/**
 * Goalify Copilot — offline re-scoring of a stored 100-case baseline.
 *
 * Reads the raw results of a frozen-100 baseline run, re-applies the FIXED scorer
 * (benchmark-scorer-100.mjs) to the stored drafts and transcripts, and writes the
 * corrected "baseline-rescored" numbers next to per-case diffs against the
 * original scoring. Strictly offline: no API calls, no provider calls, and the
 * frozen fixture is verified against its recorded SHA-256 before anything runs.
 *
 *   node apps/api/scripts/rescore-100-baseline.mjs [baselineDir]
 *
 * Without an argument the latest benchmark-results/100-case-baseline-* dir is used.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCORER_VERSION,
  structuralCheck,
  evaluateUsefulness,
  hardGatePass,
  termMatches,
  forbiddenTermPresent,
  rawTokens,
} from './benchmark-scorer-100.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_ROOT = path.resolve(here, '../../../benchmark-results');
const FIXTURE_PATH = path.join(here, 'benchmark-fixtures', 'frozen-100.json');
const SHA_PATH = path.join(here, 'benchmark-fixtures', 'frozen-100.sha256');

// ---------------------------------------------------------------- inputs

const fixtureText = await readFile(FIXTURE_PATH, 'utf8');
const fixtureSha256 = createHash('sha256').update(fixtureText).digest('hex');
const expectedSha = (await readFile(SHA_PATH, 'utf8')).trim().split(/\s+/)[0];
if (fixtureSha256 !== expectedSha) {
  console.error('FROZEN FIXTURE HASH MISMATCH — refusing to rescore.');
  process.exit(2);
}
const fixture = JSON.parse(fixtureText);
const fixtureById = new Map(fixture.map((c) => [c.id, c]));

let baselineDir = process.argv[2];
if (!baselineDir) {
  const candidates = (await readdir(RESULTS_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith('100-case-baseline-'))
    .map((d) => d.name)
    .sort();
  if (candidates.length === 0) {
    console.error('No benchmark-results/100-case-baseline-* directory found.');
    process.exit(2);
  }
  baselineDir = path.join(RESULTS_ROOT, candidates[candidates.length - 1]);
} else if (!path.isAbsolute(baselineDir)) {
  baselineDir = path.resolve(process.cwd(), baselineDir);
}

const rawPath = path.join(baselineDir, 'raw-results.json');
const raw = JSON.parse(await readFile(rawPath, 'utf8'));
if (raw.fixtureSha256 && raw.fixtureSha256 !== fixtureSha256) {
  console.error(`Baseline was run against a different fixture (${raw.fixtureSha256}) — refusing to rescore.`);
  process.exit(2);
}
const baselineStamp = path.basename(baselineDir);
console.log(`Rescoring ${baselineStamp}`);
console.log(`  fixture sha256: ${fixtureSha256}`);
console.log(`  baseline today: ${raw.today}`);
console.log(`  scorer:         ${SCORER_VERSION}\n`);

// ---------------------------------------------------------------- rescore

/**
 * Why a case's outcome moved, mapped back to the documented fix that caused it.
 * Only structural checks were documented as false positives; usefulness shifts
 * come from the same intent-matching fix feeding goalRelevance.
 */
function attributeDiff(original, rescored, testCase) {
  const reasons = [];
  const wasCodes = new Set(original.criticals);
  const nowCodes = new Set(rescored.structural.criticals);
  const taskTokens = rawTokens((rescored.draft?.tasks ?? [])
    .map((t) => `${t.title} ${t.description ?? ''}`).join(' '));

  for (const code of ['FORBIDDEN_CLAIM']) {
    if (wasCodes.has(code) && !nowCodes.has(code)) reasons.push('echo strip (fix 1)');
  }
  if (wasCodes.has('GOAL_CORRUPTION') && !nowCodes.has('GOAL_CORRUPTION')
    && testCase.expected.intentTerms.some((term) => termMatches(term, taskTokens))) {
    reasons.push('stemmed intent matching (fix 2)');
  }
  for (const code of ['CONSTRAINT_VIOLATION', 'UNSAFE_ADVICE']) {
    if (wasCodes.has(code) && !nowCodes.has(code) && testCase.expected.forbiddenIntentTerms.length) {
      const stillMatches = testCase.expected.forbiddenIntentTerms.some((term) => termMatches(term, taskTokens));
      reasons.push(stillMatches ? 'negation window (fix 3)' : 'stemmed intent matching (fix 2)');
    }
  }
  if (wasCodes.has('BROKEN_RECURRENCE') && !nowCodes.has('BROKEN_RECURRENCE')
    && (rescored.draft?.tasks ?? []).some((t) => ['MONTHLY', 'EVERY_X_MONTHS'].includes(t.recurrenceType))) {
    reasons.push('MONTHLY default dayOfMonth (fix 4)');
  }
  if (original.failures?.some((f) => f.code === 'SESSION_MINUTES')
    && !rescored.structural.issues.some((f) => f.code === 'SESSION_MINUTES')) {
    reasons.push('session-minute bounds 1-600 (fix 5)');
  }
  if (!reasons.length) reasons.push('re-scored under the fixed harness');
  return reasons;
}

const rescored = [];
const diffs = [];
const overAsked = new Map();
for (const stored of raw.results) {
  const testCase = fixtureById.get(stored.id);
  if (!testCase) throw new Error(`fixture has no case ${stored.id}`);
  if (stored.overAsked) overAsked.set(stored.id, true);
  const answersText = [testCase.prompt, ...stored.transcript
    .filter((m) => m.role === 'user')
    .map((m) => m.content)].join(' ');

  let structural;
  let usefulness;
  let noDraft = false;
  if (stored.draft) {
    structural = structuralCheck(testCase, stored.draft, answersText, raw.today);
    usefulness = evaluateUsefulness(testCase, stored.draft, stored.interview, answersText, overAsked);
  } else {
    // No draft was produced in the baseline (provider outage or DRAFT_INVALID):
    // nothing to rescore — the stored zeros stand, and the case stays a failure.
    noDraft = true;
    structural = stored.structural;
    usefulness = stored.usefulness;
  }
  const verdict = hardGatePass(testCase, { questionCount: stored.questionCount, structural, usefulness });

  const row = {
    id: stored.id,
    difficulty: stored.difficulty,
    group: stored.group,
    noDraft,
    questionCount: stored.questionCount,
    structural: { score: structural.score, issues: structural.issues, criticals: structural.criticals, critical: structural.critical },
    usefulness,
    pass: verdict.pass,
    passReasons: verdict.reasons,
    error: stored.error ?? null,
  };
  rescored.push(row);

  const changed = noDraft
    ? false
    : verdict.pass !== stored.pass
      || structural.score !== stored.structural.score
      || usefulness.usefulnessScore !== stored.usefulness.usefulnessScore
      || JSON.stringify([...new Set(structural.criticals)]) !== JSON.stringify([...new Set(stored.criticals)]);
  if (changed) {
    diffs.push({
      id: stored.id,
      difficulty: stored.difficulty,
      group: stored.group,
      prompt: testCase.prompt,
      reasons: attributeDiff(stored, { draft: stored.draft, structural }, testCase),
      original: {
        pass: stored.pass,
        structuralScore: stored.structural.score,
        usefulnessScore: stored.usefulness.usefulnessScore,
        criticals: [...new Set(stored.criticals)],
        issues: stored.failures.map((f) => `${f.code}: ${f.detail}`),
      },
      rescored: {
        pass: verdict.pass,
        structuralScore: structural.score,
        usefulnessScore: usefulness.usefulnessScore,
        criticals: [...new Set(structural.criticals)],
        issues: structural.issues.map((f) => `${f.code}: ${f.detail}`),
        usefulnessIssues: usefulness.issues,
      },
    });
  }
}

// ---------------------------------------------------------------- summary

const average = (items, field) => items.length
  ? Number((items.reduce((sum, item) => sum + (item[field] ?? 0), 0) / items.length).toFixed(2))
  : null;
const rateBy = (key) => {
  const map = {};
  for (const r of rescored) {
    map[r[key]] ??= { pass: 0, total: 0, rate: 0 };
    map[r[key]].total++;
    if (r.pass) map[r[key]].pass++;
  }
  for (const k of Object.keys(map)) map[k].rate = Number((map[k].pass / map[k].total).toFixed(4));
  return map;
};
const passCount = rescored.filter((r) => r.pass).length;
const criticalTotal = rescored.reduce((sum, r) => sum + r.structural.criticals.length, 0);
const casesWithCritical = rescored.filter((r) => r.structural.criticals.length > 0).length;

const summary = {
  benchmark: 'GOALIFY_COPILOT_REAL_WORLD_QUALITY_BASELINE_100_RESCORED',
  scorerVersion: SCORER_VERSION,
  rescoredAt: new Date().toISOString(),
  baselineDir: baselineStamp,
  baselineRun: {
    startedAt: raw.startedAt ?? null,
    today: raw.today,
    api: raw.api,
    fixtureSha256,
  },
  fixtureSha256,
  offline: true,
  noProviderCalls: true,
  executedCases: rescored.length,
  draftsRescored: rescored.filter((r) => !r.noDraft).length,
  casesWithoutDraft: rescored.filter((r) => r.noDraft).map((r) => r.id),
  structuralAverage: average(rescored.map((r) => r.structural), 'score'),
  usefulnessAverage: average(rescored.map((r) => r.usefulness), 'usefulnessScore'),
  criticalFailureCount: criticalTotal,
  casesWithCriticalFailure: casesWithCritical,
  hardGatePassCount: passCount,
  hardGatePassRate: Number((passCount / rescored.length).toFixed(4)),
  passRateByDifficulty: rateBy('difficulty'),
  passRateByGroup: rateBy('group'),
  comparedToOriginal: {
    hardGatePassCount: raw.results.filter((r) => r.pass).length,
    structuralAverage: Number((raw.results.reduce((s, r) => s + (r.structural?.score ?? 0), 0) / raw.results.length).toFixed(2)),
    usefulnessAverage: Number((raw.results.reduce((s, r) => s + (r.usefulness?.usefulnessScore ?? 0), 0) / raw.results.length).toFixed(2)),
    criticalFailureCount: raw.results.reduce((s, r) => s + [...new Set(r.criticals)].length, 0),
    casesWithCriticalFailure: raw.results.filter((r) => r.criticals.length > 0).length,
  },
  changedCases: diffs.length,
  flipsToPass: diffs.filter((d) => d.rescored.pass && !d.original.pass).map((d) => d.id),
  flipsToFail: diffs.filter((d) => !d.rescored.pass && d.original.pass).map((d) => d.id),
  gates: { structural: 90, usefulness: 75, criticalFailure: false, questionRange: true },
};

const outDir = path.join(RESULTS_ROOT, 'baseline-rescored');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
await writeFile(path.join(outDir, 'diffs.json'), JSON.stringify({ scorerVersion: SCORER_VERSION, diffs }, null, 2) + '\n');

// ---------------------------------------------------------------- report

const report = [];
report.push('# Baseline rescored — frozen 100-case fixture under the fixed harness', '');
report.push(`- Baseline run: \`${baselineStamp}\` (API \`${raw.api}\`, run date ${raw.today})`);
report.push(`- Fixture SHA-256: \`${fixtureSha256}\` (verified — unchanged)`);
report.push(`- Scorer: \`apps/api/scripts/benchmark-scorer-100.mjs\` (${SCORER_VERSION})`);
report.push('- Offline: stored drafts + transcripts only. No API or provider calls were made.', '');
report.push('## What was fixed in the harness (documented false positives only)', '');
report.push('1. **FORBIDDEN_CLAIM echo strip** — the product appends "Original request: …" to the draft description; claim-checking now ignores that echo, so only model-authored assertions count. (Cases 87, 88, 94.)');
report.push('2. **Stemmed intent matching** — intentTerms and forbiddenIntentTerms now match through the same stemmer tokenizer as the rest of the harness, with silent-e normalization, so "save" matches savings/saves/saved. (Case 5, plus usefulness goalRelevance shifts.)');
report.push('3. **Negation window for forbiddenIntentTerms** — an occurrence preceded by no/not/without/zero/avoid/hate/never (+ ≤3 words) no longer counts. (Case 64: "no speaking drills" vs forbidden "speak".)');
report.push('4. **MONTHLY dayOfMonth default** — an undefined dayOfMonth (production defaults it to the start date) is valid unless the case prompt explicitly states a day-of-month that the draft lost. Cases 35/48 state a day the drafts lost and still fail; 53/69/80/85/94 state none and pass.');
report.push('5. **Session-minute bounds aligned with production (1–600)** — the old 5-minute floor manufactured failures on legitimate micro-habits. (Cases 17, 99.)');
report.push('6. Every other check is unchanged; the fixture and its hash are untouched.', '');
report.push('## Headline numbers', '');
report.push('| Metric | Original baseline | baseline-rescored |');
report.push('|---|---:|---:|');
report.push(`| Hard-gate pass | ${summary.comparedToOriginal.hardGatePassCount}/100 | **${passCount}/100** (${(summary.hardGatePassRate * 100).toFixed(1)}%) |`);
report.push(`| Structural average | ${summary.comparedToOriginal.structuralAverage} | **${summary.structuralAverage}** |`);
report.push(`| Usefulness average | ${summary.comparedToOriginal.usefulnessAverage} | **${summary.usefulnessAverage}** |`);
report.push(`| Critical failures (total) | ${summary.comparedToOriginal.criticalFailureCount} | **${criticalTotal}** |`);
report.push(`| Cases with a critical failure | ${summary.comparedToOriginal.casesWithCriticalFailure} | **${casesWithCritical}** |`);
report.push(`| Cases changed by the rescore | — | ${diffs.length} |`, '');
report.push('## Pass rate by difficulty (rescored)', '', '| Difficulty | Pass | Total | Rate |', '|---|---:|---:|---:|');
for (const [k, v] of Object.entries(summary.passRateByDifficulty)) report.push(`| ${k} | ${v.pass} | ${v.total} | ${(v.rate * 100).toFixed(1)}% |`);
report.push('', '## Pass rate by group (rescored)', '', '| Group | Pass | Total | Rate |', '|---|---:|---:|---:|');
for (const [k, v] of Object.entries(summary.passRateByGroup)) report.push(`| ${k} | ${v.pass} | ${v.total} | ${(v.rate * 100).toFixed(1)}% |`);
report.push('', `## Changed cases (${diffs.length})`, '');
for (const d of diffs) {
  report.push(`### ${d.id}. [${d.difficulty}] ${d.group} — ${d.original.pass ? 'FAIL' : 'PASS'} → **${d.rescored.pass ? 'PASS' : 'FAIL'}**`, '');
  report.push(`Prompt: ${d.prompt}`, '');
  report.push(`Reason: ${d.reasons.join('; ')}`, '');
  report.push('| | Original | Rescored |', '|---|---:|---:|');
  report.push(`| Structural | ${d.original.structuralScore} | ${d.rescored.structuralScore} |`);
  report.push(`| Usefulness | ${d.original.usefulnessScore} | ${d.rescored.usefulnessScore} |`);
  report.push(`| Criticals | ${d.original.criticals.join(', ') || 'none'} | ${d.rescored.criticals.join(', ') || 'none'} |`, '');
  const cleared = d.original.issues.filter((i) => !d.rescored.issues.includes(i));
  const added = d.rescored.issues.filter((i) => !d.original.issues.includes(i));
  if (cleared.length) report.push(`Cleared: ${cleared.map((i) => `- ${i}`).join('\n  ')}`, '');
  if (added.length) report.push(`Newly flagged: ${added.map((i) => `- ${i}`).join('\n  ')}`, '');
}
if (!diffs.length) report.push('No case changed.', '');
report.push('## Not rescored (no draft in the baseline)', '');
report.push(`Cases ${summary.casesWithoutDraft.join(', ') || 'none'} produced no draft (provider 503s or DRAFT_INVALID). Their stored zeros stand; product fixes for those classes are measured by the next live run, not by this rescore.`, '');
report.push('## Known residual harness observations (documented, deliberately not changed)', '');
report.push('- The "Original request: …" echo can still satisfy the FEASIBILITY_UNCHALLENGED and CURRENCY_NO_RATE checks, because only the forbidden-claim check was in the documented fix list. Case 86\'s baseline pass rests on the echoed word "baseline" satisfying the challenge regex; under an echo-stripped feasibility check it would fail. Left as-is to keep this rescore strictly to the documented false positives.');
report.push('- GOAL_CORRUPTION remains on cases whose model-authored task text genuinely lacks the fixture\'s intent terms (e.g. 87 "earn/income" vs terms save/income/budget/skill with no "income" stem present in the model text) — these are product or fixture issues, not harness defects.', '');
await writeFile(path.join(outDir, 'report.md'), report.join('\n') + '\n');

console.log(`HARD-GATE PASS  ${summary.comparedToOriginal.hardGatePassCount}/100  ->  ${passCount}/100`);
console.log(`STRUCTURAL AVG  ${summary.comparedToOriginal.structuralAverage}  ->  ${summary.structuralAverage}`);
console.log(`USEFULNESS AVG  ${summary.comparedToOriginal.usefulnessAverage}  ->  ${summary.usefulnessAverage}`);
console.log(`CRITICALS       ${summary.comparedToOriginal.criticalFailureCount}  ->  ${criticalTotal} (cases with critical: ${casesWithCritical})`);
console.log(`CHANGED CASES   ${diffs.length}  (to PASS: ${summary.flipsToPass.join(',') || 'none'}; to FAIL: ${summary.flipsToFail.join(',') || 'none'})`);
console.log(`ARTIFACTS       ${outDir}`);
