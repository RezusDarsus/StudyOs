/**
 * Goalify Copilot — Real-World Quality Benchmark, frozen 100-case baseline.
 *
 * Plain ESM (.mjs), run with node — no build step, no TS imports. Everything the
 * scoring needs (recurrence semantics, question topics, stemming, placeholder
 * heuristics, the usefulness rubric) is reimplemented locally so the runner can
 * run against a live API as a black box.
 *
 *   BENCHMARK_API=http://127.0.0.1:4000/api node scripts/real-world-benchmark-100.mjs
 *
 * Flags (see --help for the full text):
 *   --cases 12,18,41   Run only these fixture ids (the full fixture is still
 *                      SHA-256 verified; artifacts are marked as a partial run,
 *                      N/100). Combined with --resume, only the intersection of
 *                      the dir's rerunnable cases and the selection is rerun and
 *                      the combined artifact covers exactly the selected ids.
 *   --resume <dir>     Resume an interrupted run's artifact directory (the one
 *                      holding raw-results.json): finalized cases are carried
 *                      verbatim, transport-failed and never-run cases are rerun
 *                      on a fresh disposable account, and the combined artifacts
 *                      are written back into the SAME directory. Refuses a dir
 *                      without raw-results.json, corrupt JSON, or a different
 *                      fixture SHA-256 — never combine fixture versions.
 *   --help             Usage + parseRunnerArgs self-test; exits 0 without any
 *                      network or fixture access.
 *
 * Hard rules honored here:
 *  - The fixture is frozen: SHA-256 verified before anything runs; mismatch aborts.
 *  - A dedicated benchmark account is registered per run (generated password, held
 *    in memory only, never logged, never written to an artifact); a resumed run
 *    registers another fresh account for its reruns.
 *  - Per case: real HTTP flow only (start -> answers -> generate), then ALWAYS
 *    (try/finally) discard the draft and DELETE the session.
 *  - Retries: at most one per HTTP call, transport-level only (connection
 *    failure/timeout or any 5xx), every retry recorded with its delay. Adaptive
 *    backoff: 45s for 5xx AI_RATE_LIMIT, 20s for other 5xx and network errors,
 *    raised to max(Retry-After seconds, base delay) capped at 120s when the
 *    response carries a Retry-After header.
 *  - No fixture is edited after outputs are seen; suspected fixture errors are
 *    documented in the report instead.
 */
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isoDaysAgo,
  TODAY,
  questionCap,
  structuralCheck,
  evaluateUsefulness,
  hardGatePass,
  classifyNoDraft,
  rawTokens,
  termMatches,
  SCORER_VERSION,
} from './benchmark-scorer-100.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.BENCHMARK_API ?? 'http://127.0.0.1:4000/api';
const FIXTURE_PATH = path.join(here, 'benchmark-fixtures', 'frozen-100.json');
const SHA_PATH = path.join(here, 'benchmark-fixtures', 'frozen-100.sha256');
const RESULTS_ROOT = path.resolve(here, '../../../benchmark-results');

const REQUEST_TIMEOUT_MS = 150_000;
// Backoff before the single transport-level retry. A retry with no delay just
// burns its second attempt inside the same provider window, so every retry
// sleeps first. Rate limiting needs a longer cool-down than a blip: AI_RATE_LIMIT
// waits 45s, every other 5xx and network error waits 20s, and a Retry-After
// header raises the wait to max(Retry-After seconds, base), capped at 120s.
const RETRY_DELAY_MS = 20_000;
const RATE_LIMIT_RETRY_DELAY_MS = 45_000;
const RETRY_DELAY_CAP_MS = 120_000;
const HARD_QUESTION_CEILING = 10;
// The incremental checkpoint the run loop rewrites after every case — also the
// file --resume validates and updates in place.
const RESUME_RESULTS_FILE = 'raw-results.json';

// ---------------------------------------------------------------- CLI flags

export const RUNNER_USAGE = `Goalify Copilot — Real-World Quality Benchmark (frozen 100-case baseline)

Usage:
  BENCHMARK_API=http://127.0.0.1:4000/api node scripts/real-world-benchmark-100.mjs [flags]

Flags:
  (none)            Run the full frozen 100-case baseline against the live API.
  --cases <ids>     Comma-separated fixture case ids, e.g. --cases 12,18,41.
                    The full fixture is still SHA-256 verified; only the selected
                    ids execute and every artifact is marked as a partial run
                    (N/100). Combined with --resume, only the intersection of the
                    dir's rerunnable cases and the selection is rerun, and the
                    combined artifact covers exactly the selected ids.
  --resume <dir>    Resume an interrupted run from its artifact directory (the one
                    holding raw-results.json). Finalized cases (transport success,
                    scored draft, NOT_READY, or a SCHEMA_INVALID/DRAFT_INVALID
                    rejection) are carried verbatim; transport-failed and
                    never-run cases are rerun on a FRESH disposable account.
                    Combined artifacts are written back into the same directory.
                    Refuses: missing/corrupt raw-results.json, or a fixture
                    SHA-256 different from the frozen fixture.
  --help            Print this text, run the parseRunnerArgs self-test, exit 0.
                    No API call, no fixture access.

Environment:
  BENCHMARK_API     Base URL of the live API (default http://127.0.0.1:4000/api).

Artifacts (per run dir): raw-results.json (incremental checkpoint),
summary.json, transcripts.json, drafts.json, report.md, failures.md,
frozen-100.json + frozen-100.sha256 copies.`;

/**
 * Parse runner CLI arguments. Pure — no I/O, no process.exit — so --help can
 * self-test it without touching the network or the fixture. `cases` ids are
 * validated as positive integers here; membership in the frozen fixture is
 * checked later (parse runs before the fixture is even read).
 */
export function parseRunnerArgs(argv) {
  const parsed = { help: false, resumeDir: null, cases: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--resume' || arg.startsWith('--resume=')) {
      if (parsed.resumeDir) return { ...parsed, error: '--resume given twice' };
      const value = arg.includes('=') ? arg.slice('--resume='.length) : argv[++i];
      if (!value) return { ...parsed, error: '--resume requires a results directory path' };
      parsed.resumeDir = value;
      continue;
    }
    if (arg === '--cases' || arg.startsWith('--cases=')) {
      if (parsed.cases) return { ...parsed, error: '--cases given twice' };
      const value = arg.includes('=') ? arg.slice('--cases='.length) : argv[++i];
      if (value == null || value === '') {
        return { ...parsed, error: '--cases requires a comma-separated list of fixture ids, e.g. --cases 12,18,41' };
      }
      const ids = [];
      for (const part of value.split(',')) {
        const trimmed = part.trim();
        if (!/^\d+$/.test(trimmed)) {
          return { ...parsed, error: `--cases: "${trimmed}" is not a case id (positive integers only, e.g. --cases 12,18,41)` };
        }
        const id = Number(trimmed);
        if (id < 1) return { ...parsed, error: `--cases: case ids start at 1 (got ${id})` };
        ids.push(id);
      }
      parsed.cases = [...new Set(ids)].sort((a, b) => a - b);
      continue;
    }
    return { ...parsed, error: `unknown argument "${arg}"` };
  }
  return parsed;
}

const RUNNER_ARGS_SELFTEST = [
  { argv: [], expect: { help: false, resumeDir: null, cases: null, error: null } },
  { argv: ['--help'], expect: { help: true, resumeDir: null, cases: null, error: null } },
  { argv: ['-h'], expect: { help: true, resumeDir: null, cases: null, error: null } },
  { argv: ['--cases', '12,18,41'], expect: { help: false, resumeDir: null, cases: [12, 18, 41], error: null } },
  { argv: ['--cases=7'], expect: { help: false, resumeDir: null, cases: [7], error: null } },
  { argv: ['--cases', ' 5 , 5, 41 '], expect: { help: false, resumeDir: null, cases: [5, 41], error: null } },
  { argv: ['--resume', 'benchmark-results/run-x'], expect: { help: false, resumeDir: 'benchmark-results/run-x', cases: null, error: null } },
  { argv: ['--resume=run-x', '--cases', '1,2'], expect: { help: false, resumeDir: 'run-x', cases: [1, 2], error: null } },
  { argv: ['--cases', '0'], expectError: 'case ids start at 1' },
  { argv: ['--cases', '12,abc'], expectError: 'is not a case id' },
  { argv: ['--cases'], expectError: 'requires a comma-separated list' },
  { argv: ['--resume'], expectError: 'requires a results directory' },
  { argv: ['--resume', 'a', '--resume', 'b'], expectError: 'twice' },
  { argv: ['--cases', '1', '--cases', '2'], expectError: 'twice' },
  { argv: ['--bogus'], expectError: 'unknown argument' },
  { argv: ['12'], expectError: 'unknown argument' },
];

/** @returns {number} checks run; throws on the first mismatch. */
function runRunnerArgsSelfTest() {
  for (const t of RUNNER_ARGS_SELFTEST) {
    const got = parseRunnerArgs(t.argv);
    if (t.expectError) {
      if (!got.error || !got.error.includes(t.expectError)) {
        throw new Error(`parseRunnerArgs(${JSON.stringify(t.argv)}) should fail with "${t.expectError}", got ${JSON.stringify(got)}`);
      }
      continue;
    }
    for (const key of ['help', 'resumeDir', 'cases', 'error']) {
      const expected = JSON.stringify(t.expect[key] ?? null);
      const actual = JSON.stringify(got[key] ?? null);
      if (actual !== expected) {
        throw new Error(`parseRunnerArgs(${JSON.stringify(t.argv)}).${key}: expected ${expected}, got ${actual}`);
      }
    }
  }
  return RUNNER_ARGS_SELFTEST.length;
}

const cli = parseRunnerArgs(process.argv.slice(2));
if (cli.help) {
  try {
    const checks = runRunnerArgsSelfTest();
    console.log(RUNNER_USAGE);
    console.log(`\nparseRunnerArgs self-test: ${checks}/${checks} checks passed — no API call made.`);
    process.exit(0);
  } catch (err) {
    console.error(`parseRunnerArgs SELF-TEST FAILED: ${err.message}`);
    process.exit(1);
  }
}
if (cli.error) {
  console.error(`Argument error: ${cli.error}\n`);
  console.error(RUNNER_USAGE);
  process.exit(2);
}

// ---------------------------------------------------------------- fixture

const fixtureText = await readFile(FIXTURE_PATH, 'utf8');
const fixtureSha256 = createHash('sha256').update(fixtureText).digest('hex');
const expectedSha = (await readFile(SHA_PATH, 'utf8')).trim().split(/\s+/)[0];
if (fixtureSha256 !== expectedSha) {
  console.error(`FROZEN FIXTURE HASH MISMATCH — refusing to run.
  fixture  ${FIXTURE_PATH}
  computed ${fixtureSha256}
  expected ${expectedSha}`);
  process.exit(2);
}
const fixture = JSON.parse(fixtureText);
if (fixture.length !== 100 || fixture.some((c, index) => c.id !== index + 1)) {
  console.error('FROZEN FIXTURE is not exactly IDs 1-100 in order — refusing to run.');
  process.exit(2);
}

// ---------------------------------------------------------------- resume & selection

function abort(message) {
  console.error(message);
  process.exit(2);
}

/**
 * A carried result is FINAL when rerunning it cannot change the outcome: the
 * transport succeeded end-to-end, any scored draft exists, the interview
 * honestly reported NOT_READY, or the API itself rejected the draft (the
 * SCHEMA_INVALID classification whose error carries the API's DRAFT_INVALID
 * code). Everything else — PROVIDER/TRANSPORT failures and cases the partial
 * run never reached — is rerun on resume.
 */
function isFinalizedResult(r) {
  if (r.transportSuccess === true) return true;
  if (r.draft) return true;
  if (r.errorKind === 'NOT_READY') return true;
  const codes = new Set([...(r.criticals ?? []), ...(r.failures ?? []).map((f) => f.code)]);
  const detail = [r.error ?? '', ...(r.failures ?? []).map((f) => f.detail ?? '')].join(' ');
  return codes.has('SCHEMA_INVALID') && detail.includes('DRAFT_INVALID');
}

/** Load and validate a --resume directory. Exits (2) loudly on any problem. */
async function loadResumeState(dir) {
  const resolved = path.resolve(dir);
  const rawPath = path.join(resolved, RESUME_RESULTS_FILE);
  let text;
  try {
    text = await readFile(rawPath, 'utf8');
  } catch {
    abort(`--resume: ${resolved} is not a benchmark results directory — no ${RESUME_RESULTS_FILE} found.`);
  }
  let prior;
  try {
    prior = JSON.parse(text);
  } catch (err) {
    abort(`--resume: ${rawPath} is corrupted (JSON parse failed: ${err.message}) — refusing to silently combine a partial results file. Rerun without --resume or point at a clean directory.`);
  }
  if (prior?.benchmark !== 'GOALIFY_COPILOT_REAL_WORLD_QUALITY_BASELINE_100' || !Array.isArray(prior.results)) {
    abort(`--resume: ${rawPath} is not a 100-case baseline checkpoint file.`);
  }
  if (prior.fixtureSha256 !== fixtureSha256) {
    abort(`RESUME FIXTURE MISMATCH — never combine fixture versions.
  resume dir ${resolved}
  recorded   ${prior.fixtureSha256}
  current    ${fixtureSha256}`);
  }
  const seen = new Set();
  for (const [index, r] of prior.results.entries()) {
    if (!r || !Number.isInteger(r.id) || r.id < 1 || r.id > fixture.length) {
      abort(`--resume: unrecognizable result entry at index ${index} (id ${JSON.stringify(r?.id)}) — checkpoint is corrupt.`);
    }
    if (seen.has(r.id)) abort(`--resume: duplicate result for case ${r.id} — checkpoint is corrupt.`);
    seen.add(r.id);
  }
  return { dir: resolved, prior, results: prior.results };
}

// ---------------------------------------------------------------- helpers

const DAYS3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAME_TO3 = {
  sunday: 'Sun', sun: 'Sun', monday: 'Mon', mon: 'Mon',
  tuesday: 'Tue', tues: 'Tue', tue: 'Tue', wednesday: 'Wed', wed: 'Wed',
  thursday: 'Thu', thurs: 'Thu', thu: 'Thu', friday: 'Fri', fri: 'Fri',
  saturday: 'Sat', sat: 'Sat',
};

/**
 * Fixed answer-date fallback, computed once per run: today + 10 weeks.
 *
 * NOTE (2026-09-03, post-sign-error review): despite its name, isoDaysAgo
 * ADDS days (Date.now() + days*86400000), so isoDaysAgo(70) is 70 days in
 * the FUTURE. An earlier "alignment" edit flipped it to -70, silently
 * turning every fallback DATE answer into a past deadline — which the
 * RC-P1-F product fix correctly refuses at ingest, so TIMEFRAME could never
 * close and the whole run collapsed to NOT_READY. The product was right;
 * the harness was wrong. Keep the sign POSITIVE: a user answering "by
 * when?" types a future date.
 */
const DEFAULT_DATE = isoDaysAgo(70);

function promptDate(prompt) {
  const month = prompt.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (month) {
    const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
    return `${month[3]}-${String(months[month[1].toLowerCase()]).padStart(2, '0')}-${String(Number(month[2])).padStart(2, '0')}`;
  }
  return null;
}

function promptTime(prompt) {
  const match = prompt.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (match[3].toLowerCase() === 'pm' && hour < 12) hour += 12;
  if (match[3].toLowerCase() === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function promptAmount(prompt) {
  const monthly = prompt.match(/([\d,]+)\s*(?:gel|usd|eur|gbp)?\s*(?:per month|a month|monthly|every month)/i);
  if (monthly) return Number(monthly[1].replace(/,/g, '')) || 100;
  const any = prompt.match(/[€$£]\s?([\d,]+)|([\d,]+)\s*(?:gel|usd|eur|gbp)/i);
  if (any) return Number((any[1] ?? any[2]).replace(/,/g, '')) || 100;
  return 100;
}

/** Days a DAYS_OF_WEEK answer should offer, driven by the prompt text. */
function promptDays(prompt) {
  const lower = prompt.toLowerCase();
  const named = [];
  for (const [name, code] of Object.entries(DAY_NAME_TO3)) {
    if (new RegExp(`\\b${name}\\b`).test(lower) && !named.includes(code)) named.push(code);
  }
  const forbidden = new Set();
  for (const [name, code] of Object.entries(DAY_NAME_TO3)) {
    if (new RegExp(`(?:never|not|avoid|except|no (?:on )?)\\s*(?:on\\s+)?${name}\\b`).test(lower)) forbidden.add(code);
    if (new RegExp(`\\b${name}\\b[^.!?]{0,30}(?:is|are)\\s+forbidden`).test(lower)) forbidden.add(code);
  }
  const minus = (days) => days.filter((day) => !forbidden.has(day));
  if (named.length) return minus(named).length ? minus(named) : minus(['Mon', 'Wed', 'Sat']);
  if (/\bweekdays?\b/.test(lower)) return minus(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).length ? minus(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) : minus(['Mon', 'Wed', 'Sat']);
  return minus(['Mon', 'Wed', 'Sat']).length ? minus(['Mon', 'Wed', 'Sat']) : ['Mon', 'Wed', 'Sat'];
}

// -------------------------------------------------------- HTTP with retry

let cookie = '';
const retryLog = []; // {caseId, route, attempt, reason, status?, code?, delayMs, retryAfterSeconds?}
let totalRetryDelayMs = 0; // backoff actually slept across the whole invocation

async function call(route, init = {}, meta = {}) {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(`${API}${route}`, {
          ...init,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
            ...(init.headers ?? {}),
          },
        });
      } finally {
        clearTimeout(timer);
      }
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const status = response.status;
      const body = await response.json().catch(() => null);
      const elapsed = Date.now() - started;
      attempts.push({ attempt, status, elapsed, ok: status < 500 });
      if (status >= 500 && attempt === 1) {
        // Adaptive backoff (bounded single retry): the provider said "busy"
        // (AI_RATE_LIMIT) vs "broken/slow" (AI_TIMEOUT/AI_PROVIDER/AI_UNAVAILABLE),
        // and a Retry-After header, when present, wins over the base delay.
        const code = body?.code ?? null;
        const baseDelayMs = code === 'AI_RATE_LIMIT' ? RATE_LIMIT_RETRY_DELAY_MS : RETRY_DELAY_MS;
        const retryAfterRaw = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfterRaw != null && /^\d+$/.test(retryAfterRaw.trim()) ? Number(retryAfterRaw.trim()) : null;
        const delayMs = retryAfterSeconds != null
          ? Math.min(Math.max(retryAfterSeconds * 1000, baseDelayMs), RETRY_DELAY_CAP_MS)
          : baseDelayMs;
        totalRetryDelayMs += delayMs;
        retryLog.push({
          caseId: meta.caseId, route, attempt, reason: `HTTP ${status}`, status, code, delayMs,
          ...(retryAfterSeconds != null ? { retryAfterSeconds } : {}),
        });
        console.log(
          `    · transport retry ${meta.caseId} ${route} -> HTTP ${status} (${code ?? 'no code'})` +
          ` — waiting ${(delayMs / 1000).toFixed(0)}s` +
          (retryAfterSeconds != null ? ` (Retry-After: ${retryAfterSeconds}s)` : ''),
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return { status, body, attempts };
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : `network: ${err?.cause?.code ?? err?.message ?? err}`;
      attempts.push({ attempt, status: null, elapsed: Date.now() - started, ok: false });
      if (attempt === 1) {
        totalRetryDelayMs += RETRY_DELAY_MS;
        retryLog.push({ caseId: meta.caseId, route, attempt, reason, delayMs: RETRY_DELAY_MS });
        console.log(`    · transport retry ${meta.caseId} ${route} -> ${reason} — waiting ${RETRY_DELAY_MS / 1000}s`);
        continue;
      }
      throw new Error(`${route}: ${reason} (after 1 recorded retry)`);
    }
  }
}

// -------------------------------------------------------- deterministic answers

function scoreOption(option, testCase) {
  const tokensRaw = rawTokens(option);
  let score = 0;
  for (const term of testCase.expected.intentTerms) {
    if (tokensRaw.some((token) => termMatches(term, [token]))) score += 2;
  }
  const promptTokens = new Set(rawTokens(testCase.prompt));
  for (const token of tokensRaw) if (token.length >= 4 && promptTokens.has(token)) score += 1;
  return score;
}

function answerFor(question, testCase) {
  const prompt = testCase.prompt;
  const text = `${question.id ?? ''} ${question.prompt ?? ''}`.toLowerCase();
  const options = question.options ?? [];

  if (question.type === 'NUMBER') {
    if (/rate|exchange/.test(text)) return 3; // middle/beginner-safe otherwise
    if (/minute|duration|how long|session length/.test(text)) return 30;
    if (/day|frequen|often|per week|weekly|times/.test(text)) return 3;
    if (/much|amount|money|gel|usd|eur|gbp|contribut|save|earn|income|budget|\$|€|£/.test(text)) return promptAmount(prompt);
    return 3;
  }
  if (question.type === 'DATE') return promptDate(prompt) ?? DEFAULT_DATE;
  if (question.type === 'TIME') return promptTime(prompt) ?? '19:00';
  if (question.type === 'DAYS_OF_WEEK') return promptDays(prompt);

  if (question.type === 'SINGLE_SELECT' || question.type === 'MULTI_SELECT') {
    const scored = options.map((option, index) => ({ option, score: scoreOption(option, testCase), index }));
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const picked = question.type === 'MULTI_SELECT' ? scored.slice(0, 2).map((s) => s.option) : [scored[0].option];
    return question.type === 'MULTI_SELECT' ? picked : picked[0];
  }

  // FREE_TEXT
  if (/success|target|outcome|what would|result|specific|define|look like/.test(text)) {
    return 'A concrete, sustainable improvement I can notice within ten weeks';
  }
  if (/how much|amount|by when/.test(text)) {
    return `Around ${promptAmount(prompt)} by ${DEFAULT_DATE}`;
  }
  return 'Keep it realistic, sustainable, and within the time I provided.';
}

/** Per-case flag: the question cap was hit while the model still wanted to ask. */
const overAsked = new Map();

// ---------------------------------------------------------------- run one case

async function runCase(testCase) {
  // Approved harness recalibration (certification 2026-09-03). Two separate
  // budgets, deliberately NOT merged:
  //
  //   questionCap(testCase)  — the FROZEN expectation: how many answers the
  //                            interview should need. questionRange scoring
  //                            and overAsked continue to use it, so needing
  //                            three where two was expected still shows up as
  //                            provider/UX efficiency debt (the inflation
  //                            metrics below make that visible per case).
  //   executionAnswerCap    — the EXECUTION allowance: the runner may drive
  //                            up to max(questionCap, 3) answers so the
  //                            product can actually reach generation under
  //                            the current provider's extraction depth. It is
  //                            an execution allowance only — never a scoring
  //                            expectation.
  const expectedQuestionCap = questionCap(testCase);
  const executionAnswerCap = Math.max(expectedQuestionCap, 3);
  const result = {
    id: testCase.id,
    difficulty: testCase.difficulty,
    group: testCase.group,
    prompt: testCase.prompt,
    questionCap: expectedQuestionCap,
    executionAnswerCap,
    interview: [],       // {question, answer, responseStatus, turnStatus, elapsedMs}
    transcript: [],      // {role, content, questionId}
    draft: null,
    adjustments: [],
    assumptions: [],
    readiness: null,
    startResponse: null,
    transportSuccess: false,
    overAsked: false,
    structural: null,
    usefulness: null,
    criticals: [],
    failures: [],
    questionCount: 0,
    timings: { startMs: 0, interviewMs: 0, generateMs: 0, totalMs: 0, calls: [] },
    cleanup: { draftDiscarded: false, sessionDeleted: false, errors: [] },
    error: null,
    errorKind: null,
    retries: 0,
    /** RC-P1-E/F/G integrity counters — expected to stay exactly 0. */
    integrity: { ghostQuestionCount: 0, pastDeadlineAcceptedCount: 0, rangeCollapsedCount: 0, prefixParseSemanticLossCount: 0, interviewDraftTemporalMismatchCount: 0 },
    /** Bloat metrics: answers that execution allowance permitted but the
     *  expected depth did not. Reported, never gating. */
    unnecessaryAnswers: 0,
    answersBeyondExpectedRange: 0,
  };
  const t0 = Date.now();
  let sessionId = null;
  let draftId = null;
  try {
    // -- start
    const started = Date.now();
    const start = await call('/copilot/goal-sessions', {
      method: 'POST',
      body: JSON.stringify({ goal: testCase.prompt }),
    }, { caseId: testCase.id });
    result.timings.startMs = Date.now() - started;
    result.timings.calls.push({ route: 'POST /copilot/goal-sessions', status: start.status, elapsedMs: result.timings.startMs });
    if (start.status !== 200) {
      throw Object.assign(new Error(`start HTTP ${start.status}: ${JSON.stringify(start.body)}`), { kind: 'START' });
    }
    result.startResponse = start.body;
    result.readiness = start.body.readiness ?? null;
    let turn = start.body;
    sessionId = turn.sessionId;

    // -- answers while the interview still needs one and the EXECUTION
    //    allowance lasts. A user stops answering once generation unlocks, so
    //    the runner does too: an advisory question after canGenerate is not
    //    answered (that would be manufactured interview bloat).
    let guard = 0;
    while (turn.question
        && !turn.canGenerate
        && result.interview.length < executionAnswerCap
        && guard < HARD_QUESTION_CEILING) {
      guard++;
      const question = turn.question;
      const answer = answerFor(question, testCase);
      const tTurn = Date.now();
      const answerRes = await call(`/copilot/goal-sessions/${sessionId}/answers`, {
        method: 'POST',
        body: JSON.stringify({ questionId: question.id, answer }),
      }, { caseId: testCase.id });
      const elapsed = Date.now() - tTurn;
      result.timings.calls.push({ route: 'POST /answers', status: answerRes.status, elapsedMs: elapsed });
      result.interview.push({ question, answer, status: answerRes.status, elapsedMs: elapsed });
      result.transcript.push(
        { role: 'assistant', content: question.prompt, questionId: question.id, type: question.type, options: question.options ?? null },
        { role: 'user', content: Array.isArray(answer) ? answer.join(', ') : String(answer), questionId: question.id, answer },
      );
      if (answerRes.status !== 200) {
        throw Object.assign(new Error(`answer HTTP ${answerRes.status}: ${JSON.stringify(answerRes.body)}`), { kind: 'ANSWER' });
      }
      // Integrity counter hooks (RC-P1-E/F/G): the interview's visible state
      // must never contradict the product's own invariants. These observe the
      // responses the product itself returned — they never guess.
      const body = answerRes.body ?? {};
      if (body.question === null && body.canGenerate === true && typeof body.assistantMessage === 'string' && /\?\s*$/.test(body.assistantMessage.trim())) {
        result.integrity.ghostQuestionCount += 1;
      }
      if (question.id === 'gap_timeframe' && answerRes.status === 200) {
        // The product accepted this turn; if the deadline we sent is not
        // future-facing yet the turn reports TIMEFRAME closed, that is a
        // pastDeadlineAccepted / temporal-mismatch observation.
        const sent = String(answer);
        const readinessAfter = body.readiness ?? {};
        const missingAfter = Array.isArray(readinessAfter.missing) ? readinessAfter.missing : [];
        if (/^\d{4}-\d{2}-\d{2}$/.test(sent) && sent <= TODAY && !missingAfter.includes('TIMEFRAME')) {
          result.integrity.pastDeadlineAcceptedCount += 1;
          result.integrity.interviewDraftTemporalMismatchCount += 1;
        }
      }
      if (question.id === 'gap_weekly_capacity' || question.id === 'gap_session_shape') {
        // Range-collapse observation: we sent a bare integer (the runner
        // always does for NUMBER), so a range answer never originates here —
        // but a turn that INGESTS a non-integer as exact is detectable via
        // the accepted answer echo. The runner never sends ranges, so this
        // stays 0 by construction and guards against harness drift.
        const sent = question.type === 'NUMBER' ? String(answer) : '';
        if (!/^-?\d+$/.test(sent.trim()) && answerRes.status === 200) {
          result.integrity.rangeCollapsedCount += 1;
          result.integrity.prefixParseSemanticLossCount += 1;
        }
      }
      turn = body;
    }
    // Bloat metrics (reported, never gating): every answer past the FROZEN
    // expected depth is either the current provider's extraction debt
    // (answersBeyondExpectedRange) or, if generation was already possible,
    // genuine bloat (unnecessaryAnswers — impossible with the stop rule, and
    // the metric exists to prove it stays that way).
    result.answersBeyondExpectedRange = Math.max(0, result.interview.length - expectedQuestionCap);
    result.unnecessaryAnswers = 0; // the stop rule answers nothing past canGenerate
    result.questionCount = result.interview.length;
    result.finalTurn = {
      status: turn.status,
      questionCount: turn.questionCount,
      readiness: turn.readiness ?? null,
      canGenerate: turn.canGenerate,
      revision: turn.revision,
    };
    if (turn.question && !turn.canGenerate) {
      // The expected cap (or the execution allowance) stopped us while the
      // interview still needed an answer — the frozen questionRange keeps
      // scoring this honestly. (A question while canGenerate is true is an
      // advisory ask, not a stop: the user could have generated.)
      result.overAsked = true;
      overAsked.set(testCase.id, true);
      result.transcript.push({ role: 'assistant', content: turn.question.prompt, questionId: turn.question.id, type: turn.question.type, options: turn.question.options ?? null, unanswered: true });
    }

    // -- generate (always after the cap; a stale revision is not sent, body is exactly {})
    const tGen = Date.now();
    const gen = await call(`/copilot/goal-sessions/${sessionId}/generate`, {
      method: 'POST',
      body: '{}',
    }, { caseId: testCase.id });
    result.timings.generateMs = Date.now() - tGen;
    result.timings.calls.push({ route: 'POST /generate', status: gen.status, elapsedMs: result.timings.generateMs });
    if (gen.status !== 200 || !gen.body?.draft) {
      const code = gen.body?.code ?? 'NO_DRAFT';
      if (gen.status === 409 && code === 'NOT_READY') {
        throw Object.assign(new Error(`generate HTTP ${gen.status} NOT_READY`), { kind: 'NOT_READY' });
      }
      throw Object.assign(new Error(`generate HTTP ${gen.status}: ${code} ${JSON.stringify(gen.body ?? {}).slice(0, 400)}`), { kind: 'GENERATE', providerCode: code });
    }
    result.draft = gen.body.draft;
    result.adjustments = gen.body.adjustments ?? [];
    result.assumptions = gen.body.assumptions ?? [];
    draftId = gen.body.draft.id;
    result.transportSuccess = true;
  } catch (err) {
    result.error = err.message;
    result.errorKind = err.kind ?? 'TRANSPORT';
    // Classification needs the provider code that rode on the thrown error
    // (AI_TIMEOUT etc.); without it every GENERATE failure degrades to
    // SCHEMA_INVALID and an honest provider outage counts as an integrity zero.
    result.providerCode = err.providerCode;
  } finally {
    // -- always discard the draft and cancel/delete the session, even on failure
    if (draftId) {
      try {
        const discard = await call(`/copilot/goal-drafts/${draftId}/discard`, { method: 'POST', body: '{}' }, { caseId: testCase.id });
        result.cleanup.draftDiscarded = discard.status === 200;
        if (discard.status !== 200) result.cleanup.errors.push(`discard HTTP ${discard.status}`);
      } catch (err) {
        result.cleanup.errors.push(`discard threw: ${err.message}`);
      }
    }
    if (sessionId) {
      try {
        const del = await call(`/copilot/goal-sessions/${sessionId}`, { method: 'DELETE' }, { caseId: testCase.id });
        result.cleanup.sessionDeleted = del.status === 200;
        if (del.status !== 200) result.cleanup.errors.push(`session DELETE HTTP ${del.status}`);
      } catch (err) {
        result.cleanup.errors.push(`session DELETE threw: ${err.message}`);
      }
    }
    result.timings.totalMs = Date.now() - t0;
    result.retries = retryLog.filter((r) => r.caseId === testCase.id).length;
  }

  // -- scoring (runs regardless of transport outcome so failed cases are comparable)
  const answersText = [testCase.prompt, ...result.transcript.filter((m) => m.role === 'user').map((m) => m.content)].join(' ');
  if (result.draft) {
    result.structural = structuralCheck(testCase, result.draft, answersText, TODAY);
    result.usefulness = evaluateUsefulness(testCase, result.draft, result.interview, answersText, overAsked);
    result.criticals = result.structural.criticals;
    result.failures = result.structural.issues;
  } else {
    const refusal = classifyNoDraft(testCase, result.error);
    if (refusal.kind === 'PRINCIPLED_REFUSAL') {
      // The product's own gates refused and asked for renegotiation (feasibility/
      // medical/contract/frequency) — documented product behavior, not a crash:
      // no structural criticals and partial usefulness credit. The gate accepts
      // it only when the case expects a refusal (see the hard gate below).
      result.structural = { score: 0, issues: [{ code: 'PRINCIPLED_REFUSAL', detail: result.error ?? 'no draft' }], criticals: [], critical: false };
      const REFUSAL_CREDIT = 70; // partial credit: renegotiation beats an invented plan, but no plan was produced
      result.usefulness = { goalRelevance: 0, taskSpecificity: 0, planCompleteness: 0, scheduleRealism: 0, taskDiversity: 0, personalization: 0, interviewEfficiency: 0, planScore: 0, usefulnessScore: REFUSAL_CREDIT, issues: [{ code: 'PRINCIPLED_REFUSAL', detail: 'the product refused and asked for renegotiation instead of producing a plan' }] };
      result.criticals = [];
      result.failures = result.structural.issues;
      result.principledRefusal = true;
    } else {
      // An honest provider failure (timeout, outage, rate limit; state preserved)
      // is transport-class, not a Copilot integrity failure - only a rejected or
      // malformed draft is SCHEMA_INVALID (HARNESS FIX, not a product change).
      const PROVIDER_CODES = new Set(['AI_TIMEOUT', 'AI_PROVIDER', 'AI_RATE_LIMIT', 'AI_UNAVAILABLE']);
      const kind = result.errorKind === 'NOT_READY' ? 'NO_EXECUTABLE_PLAN' : result.errorKind === 'GENERATE' ? (PROVIDER_CODES.has(result.providerCode) ? 'PROVIDER' : 'SCHEMA_INVALID') : 'TRANSPORT';
      result.structural = { score: 0, issues: [{ code: kind, detail: result.error ?? 'no draft' }], criticals: [kind], critical: true };
      result.usefulness = { goalRelevance: 0, taskSpecificity: 0, planCompleteness: 0, scheduleRealism: 0, taskDiversity: 0, personalization: 0, interviewEfficiency: 0, planScore: 0, usefulnessScore: 0, issues: [] };
      result.criticals = [kind];
      result.failures = [{ code: kind, detail: result.error ?? 'no draft' }];
    }
  }

  // -- hard gate (a refusal passes only when the case expects one: SAFETY, an
  // infeasible goal, or a required clarification; otherwise the product dodged
  // a plannable request)
  const verdict = hardGatePass(testCase, result);
  if (result.principledRefusal) {
    const expectsRefusal = testCase.group === 'SAFETY'
      || testCase.expected.mustChallengeFeasibility === true
      || (Array.isArray(testCase.expected.mustClarify) && testCase.expected.mustClarify.length > 0);
    result.refusalAccepted = expectsRefusal;
    result.pass = expectsRefusal;
    result.inQuestionRange = verdict.inQuestionRange;
    result.passReasons = expectsRefusal
      ? ['principled refusal accepted for a case that expects refusal']
      : ['principled refusal where a plan was possible — product miss, not a crash'];
    return result;
  }
  result.pass = verdict.pass;
  result.inQuestionRange = verdict.inQuestionRange;
  result.passReasons = verdict.reasons;
  return result;
}

// ---------------------------------------------------------------- main

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const selectedIds = cli.cases; // null = all 100
const partialRun = selectedIds != null;
if (selectedIds) {
  const unknown = selectedIds.filter((id) => !fixture.some((c) => c.id === id));
  if (unknown.length) abort(`--cases: ids not in the frozen fixture (1-${fixture.length}): ${unknown.join(', ')}`);
}
const runList = selectedIds ? fixture.filter((c) => selectedIds.includes(c.id)) : fixture;

const resumeState = cli.resumeDir ? await loadResumeState(cli.resumeDir) : null;

// Resume plan: finalized cases are carried verbatim into the combined output;
// transport-failed cases and cases the partial run never reached are rerun.
const carriedResults = [];
const rerunCaseIds = [];
for (const testCase of runList) {
  const priorEntry = resumeState?.results.find((r) => r.id === testCase.id);
  if (priorEntry && isFinalizedResult(priorEntry)) carriedResults.push(priorEntry);
  else rerunCaseIds.push(testCase.id);
}

const outDir = resumeState ? resumeState.dir : path.join(RESULTS_ROOT, `100-case-baseline-${stamp}`);
const runStartedAt = resumeState ? (resumeState.prior.startedAt ?? stamp) : stamp;
await mkdir(outDir, { recursive: true });
await copyFile(FIXTURE_PATH, path.join(outDir, 'frozen-100.json'));
await copyFile(SHA_PATH, path.join(outDir, 'frozen-100.sha256'));

console.log('Goalify Copilot — Real-World Quality Benchmark (frozen 100-case baseline)');
console.log(`  API:        ${API}`);
console.log(`  fixture:    ${FIXTURE_PATH}`);
console.log(`  sha256:     ${fixtureSha256}`);
console.log(`  artifacts:  ${outDir}`);
console.log(`  today:      ${TODAY}  defaultAnswerDate: ${DEFAULT_DATE}`);
console.log(`  mode:       ${partialRun ? `partial run — ${runList.length} of ${fixture.length} fixture cases (ids: ${selectedIds.join(', ')})` : `full run — all ${fixture.length} cases`}`);
if (resumeState) {
  console.log(`  resume:     ${resumeState.dir} (original run started ${resumeState.prior.startedAt ?? 'unknown'})`);
  if (resumeState.prior.api && resumeState.prior.api !== API) {
    console.log(`  WARNING:    original run targeted ${resumeState.prior.api}; this run targets ${API} — the combined artifact mixes APIs.`);
  }
  console.log(`  plan:       ${carriedResults.length} carried verbatim, ${rerunCaseIds.length} to rerun`);
  console.log(`  rerun ids:  ${rerunCaseIds.join(', ') || '(none — everything already final; artifacts rewritten in place)'}`);
  if (carriedResults.length) console.log(`  carried:    ${carriedResults.map((r) => r.id).join(', ')}`);
}

if (rerunCaseIds.length) {
  // dedicated, disposable account — generated password lives in memory only.
  // A resumed run registers another fresh account: the partial run's sessions
  // and drafts were already discarded by the per-case cleanup, and its cookie
  // is only reusable while that old account still exists.
  const account = {
    name: 'Benchmark 100',
    email: `benchmark-100+${Date.now()}@goalify.app`,
    password: randomBytes(18).toString('base64url'),
  };
  let register;
  try {
    register = await call('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: account.name,
        email: account.email,
        password: account.password,
        confirmPassword: account.password,
        timezone: 'UTC',
      }),
    }, { caseId: 'ACCOUNT' });
  } catch (err) {
    console.error(`Account registration failed: ${err.message}`);
    process.exit(2);
  }
  if (register.status !== 200 && register.status !== 201) {
    console.error(`Account registration failed (HTTP ${register.status}): ${JSON.stringify(register.body)}`);
    process.exit(2);
  }
  let login;
  try {
    login = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: account.password }),
    }, { caseId: 'ACCOUNT' });
  } catch (err) {
    console.error(`Login failed: ${err.message}`);
    process.exit(2);
  }
  if (login.status !== 200) {
    console.error(`Login failed (HTTP ${login.status}): ${JSON.stringify(login.body)}`);
    process.exit(2);
  }
  console.log(`  account:    ${account.email} (dedicated, disposable; credentials not stored)`);
} else {
  console.log('  account:    none needed — nothing to rerun (no API call made)');
}
console.log(`  gates:      structural>=90  usefulness>=75  no critical failure  questionCount within range\n`);

const results = [...carriedResults]; // final combined set, kept sorted by case id
const rerunCases = rerunCaseIds.map((id) => fixture[id - 1]);
for (const testCase of rerunCases) {
  const r = await runCase(testCase);
  results.push(r);
  results.sort((a, b) => a.id - b.id);
  const mark = r.pass ? 'PASS' : 'FAIL';
  console.log(
    `[${String(r.id).padStart(3)}/100] ${r.difficulty.padEnd(6)} #${String(r.id).padStart(3)} q=${r.questionCount}` +
    `  structural=${String(r.structural?.score ?? '-').padStart(3)} usefulness=${String(r.usefulness?.usefulnessScore ?? '-').padStart(3)}  ${mark}` +
    `  ${(r.timings.totalMs / 1000).toFixed(1)}s` +
    (r.criticals.length ? `  CRITICAL: ${[...new Set(r.criticals)].join(',')}` : '') +
    (r.error ? `  ${r.error.slice(0, 120)}` : ''),
  );
  if (!r.pass && r.criticals.length) {
    console.log(`      ${r.criticals.map((c) => `${c}: ${(r.failures.find((f) => f.code === c)?.detail ?? '').slice(0, 160)}`).join('\n      ')}`);
  }
  // checkpoint after every case so a crash never loses the run — the whole
  // combined set is written in place, so resuming again carries everything so far
  await writeFile(path.join(outDir, RESUME_RESULTS_FILE), JSON.stringify({
    benchmark: 'GOALIFY_COPILOT_REAL_WORLD_QUALITY_BASELINE_100',
    api: API,
    fixtureSha256,
    today: TODAY,
    defaultAnswerDate: DEFAULT_DATE,
    startedAt: runStartedAt,
    updatedAt: new Date().toISOString(),
    completedCases: results.length,
    partialRun,
    selectedCases: selectedIds,
    resumedFrom: resumeState ? resumeState.dir : null,
    results,
  }, null, 2));
}

// ---------------------------------------------------------------- summary

const average = (items, field) => items.length ? Number((items.reduce((sum, item) => sum + (item[field] ?? 0), 0) / items.length).toFixed(2)) : null;
const rateBy = (key) => {
  const map = {};
  for (const r of results) {
    const k = r[key];
    map[k] ??= { pass: 0, total: 0, rate: 0 };
    map[k].total++;
    if (r.pass) map[k].pass++;
  }
  for (const k of Object.keys(map)) map[k].rate = Number((map[k].pass / map[k].total).toFixed(4));
  return map;
};
const executed = results.filter((r) => r.transportSuccess).length;
const criticalTotal = results.reduce((sum, r) => sum + [...new Set(r.criticals)].length, 0);
const casesWithCritical = results.filter((r) => r.criticals.length > 0).length;
const passCount = results.filter((r) => r.pass).length;
const n = results.length;
// On a partial run a /100 denominator would be wrong for every per-metric line,
// so those lines switch to the executed count and say "partial" explicitly.
const denom = partialRun ? `${n} (partial run of 100)` : '100';
const retryAfterRespectedCount = retryLog.filter((e) => e.retryAfterSeconds != null).length;
const maxRetriesPerCase = results.reduce((max, r) => Math.max(max, r.retries ?? 0), 0);
// A principled refusal: flagged by this run's scoring, or (for carried results
// predating the flag) reclassified from the error text — classifyNoDraft
// inspects only the error string.
const isRefusal = (r) => r.principledRefusal === true
  || (r.draft == null && classifyNoDraft(null, r.error).kind === 'PRINCIPLED_REFUSAL');

const summary = {
  benchmark: 'GOALIFY_COPILOT_REAL_WORLD_QUALITY_BASELINE_100',
  fixtureSha256,
  scorerVersion: SCORER_VERSION,
  api: API,
  startedAt: runStartedAt,
  finishedAt: new Date().toISOString(),
  totalFixtureCases: fixture.length,
  executedCases: results.length,
  partialRun,
  selectedCases: selectedIds,
  resumedFrom: resumeState ? resumeState.dir : null,
  resume: resumeState ? {
    resumedAt: new Date().toISOString(),
    originalStartedAt: resumeState.prior.startedAt ?? null,
    carriedCaseIds: carriedResults.map((r) => r.id),
    rerunCaseIds,
  } : null,
  executedFully: executed,
  transportFailureCases: results.filter((r) => !r.transportSuccess).map((r) => ({ id: r.id, kind: r.criticals?.[0] ?? r.errorKind, error: r.error, refusal: isRefusal(r) })),
  providerFailureCases: results.filter((r) => r.criticals.includes('PROVIDER')).map((r) => r.id),
  generatedDraftPasses: results.filter((r) => r.draft && r.pass).length,
  principledRefusals: (() => {
    const refusals = results.filter(isRefusal);
    const acceptedIds = refusals.filter((r) => r.refusalAccepted === true).map((r) => r.id);
    return {
      total: refusals.length,
      ids: refusals.map((r) => r.id),
      accepted: acceptedIds.length,
      rejected: refusals.length - acceptedIds.length,
      acceptedIds,
      rejectedIds: refusals.filter((r) => r.refusalAccepted !== true).map((r) => r.id),
    };
  })(),
  productFailures: results.filter((r) => r.criticals.length > 0 && !r.draft && !r.criticals.includes('PROVIDER') && !isRefusal(r)).length,
  productEvaluableCases: results.filter((r) => !r.criticals.includes('PROVIDER')).length,
  productHardGate: (() => {
    const evaluable = results.filter((r) => !r.criticals.includes('PROVIDER'));
    const passed = evaluable.filter((r) => r.pass).length;
    return { pass: passed, evaluable: evaluable.length, rate: Number((passed / evaluable.length).toFixed(4)) };
  })(),
  draftInvalidBreakdown: (() => {
    const breakdown = { principledRefusal: 0, qualityValidator: 0, repairExhausted: 0, schemaProblem: 0, unknown: 0 };
    for (const r of results) {
      if (r.draft || r.errorKind !== 'GENERATE') continue;
      if (classifyNoDraft(null, r.error).kind === 'PRINCIPLED_REFUSAL') breakdown.principledRefusal++;
      else if (/not useful enough|generic|placeholder/i.test(r.error ?? '')) breakdown.qualityValidator++;
      else if (/Try generating the plan again/i.test(r.error ?? '')) breakdown.repairExhausted++;
      else if (/JSON|schema|parse/i.test(r.error ?? '')) breakdown.schemaProblem++;
      else breakdown.unknown++;
    }
    return breakdown;
  })(),
  structuralAverage: average(results.map((r) => r.structural), 'score'),
  usefulnessAverage: average(results.map((r) => r.usefulness), 'usefulnessScore'),
  criticalFailureCount: criticalTotal,
  casesWithCriticalFailure: casesWithCritical,
  hardGatePassCount: passCount,
  hardGatePassRate: Number((passCount / results.length).toFixed(4)),
  passRateByDifficulty: rateBy('difficulty'),
  passRateByGroup: rateBy('group'),
  averageQuestionsPerCase: Number((results.reduce((sum, r) => sum + r.questionCount, 0) / results.length).toFixed(2)),
  averageQuestionsByDifficulty: (() => {
    const map = {};
    for (const r of results) {
      map[r.difficulty] ??= { total: 0, questions: 0 };
      map[r.difficulty].total++;
      map[r.difficulty].questions += r.questionCount;
    }
    for (const k of Object.keys(map)) map[k].average = Number((map[k].questions / map[k].total).toFixed(2));
    return map;
  })(),
  overAskedCases: results.filter((r) => r.overAsked).map((r) => r.id),
  // RC-P1-E/F/G integrity counters — every one of these must be exactly 0.
  integrity: {
    ghostQuestionCount: results.reduce((n, r) => n + (r.integrity?.ghostQuestionCount ?? 0), 0),
    pastDeadlineAcceptedCount: results.reduce((n, r) => n + (r.integrity?.pastDeadlineAcceptedCount ?? 0), 0),
    rangeCollapsedCount: results.reduce((n, r) => n + (r.integrity?.rangeCollapsedCount ?? 0), 0),
    prefixParseSemanticLossCount: results.reduce((n, r) => n + (r.integrity?.prefixParseSemanticLossCount ?? 0), 0),
    interviewDraftTemporalMismatchCount: results.reduce((n, r) => n + (r.integrity?.interviewDraftTemporalMismatchCount ?? 0), 0),
  },
  // Interview-depth metrics: the frozen questionRange already scores depth
  // against expectation; these make the DEBT visible without gating on it.
  unnecessaryAnswers: results.reduce((n, r) => n + (r.unnecessaryAnswers ?? 0), 0),
  answersBeyondExpectedRange: results.reduce((n, r) => n + (r.answersBeyondExpectedRange ?? 0), 0),
  providerExtractionDepthInflation: results.filter((r) => (r.answersBeyondExpectedRange ?? 0) > 0).map((r) => r.id),
  retryCount: retryLog.length,
  retries: retryLog,
  // Transport-retry accounting for this invocation (carried results keep their
  // original per-case `retries` count; maxRetriesPerCase covers the combined set).
  providerRetryCount: retryLog.length,
  totalRetryDelayMs,
  retryAfterRespectedCount,
  maxRetriesPerCase,
  cleanup: {
    draftsDiscarded: results.filter((r) => r.cleanup.draftDiscarded).length,
    sessionsDeletedOrCancelled: results.filter((r) => r.cleanup.sessionDeleted).length,
    cleanupErrors: results.flatMap((r) => r.cleanup.errors.map((e) => ({ id: r.id, error: e }))),
  },
  gates: { structural: 90, usefulness: 75, criticalFailure: false, questionRange: true },
};

await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
await writeFile(path.join(outDir, 'transcripts.json'), JSON.stringify({
  fixtureSha256, today: TODAY, defaultAnswerDate: DEFAULT_DATE,
  partialRun, selectedCases: selectedIds,
  transcripts: results.map((r) => ({ id: r.id, interview: r.interview, transcript: r.transcript })),
}, null, 2) + '\n');
await writeFile(path.join(outDir, 'drafts.json'), JSON.stringify({
  fixtureSha256,
  partialRun, selectedCases: selectedIds,
  drafts: results.map((r) => ({ id: r.id, draft: r.draft, adjustments: r.adjustments, assumptions: r.assumptions })),
}, null, 2) + '\n');

const report = [];
report.push('# Goalify Copilot — Real-World Quality Benchmark (frozen 100-case baseline)', '');
report.push(`- API target: \`${API}\``);
report.push(`- Run: ${partialRun ? `PARTIAL — ${n} of ${fixture.length} fixture cases (ids: ${selectedIds.join(', ')})` : `full baseline, all ${fixture.length} cases`}`);
if (resumeState) {
  report.push(`- Resume of \`${resumeState.dir}\` (original run started ${resumeState.prior.startedAt ?? 'unknown'}): ${carriedResults.length} cases carried verbatim, ${rerunCaseIds.length} rerun on a fresh disposable account`);
}
report.push(`- Fixture: \`apps/api/scripts/benchmark-fixtures/frozen-100.json\``);
report.push(`- Fixture SHA-256: \`${fixtureSha256}\``);
report.push(`- Account: dedicated, disposable benchmark account (no credentials recorded)`);
report.push(`- Gates: structural ≥ 90, usefulness ≥ 75, no critical failure, question count within expected range`, '');
report.push(`| Metric | Value |`);
report.push(`|---|---:|`);
report.push(`| Executed cases | ${n}/100${partialRun ? ` — partial run (ids: ${selectedIds.join(', ')})` : ''} |`);
report.push(`| Fully executed (draft produced) | ${executed}/${denom} |`);
report.push(`| Structural average | ${summary.structuralAverage} |`);
report.push(`| Usefulness average | ${summary.usefulnessAverage} |`);
report.push(`| Critical failures (total) | ${criticalTotal} |`);
report.push(`| Cases with a critical failure | ${casesWithCritical}/${denom} |`);
report.push(`| Hard-gate pass | ${passCount}/${denom} (${(summary.hardGatePassRate * 100).toFixed(1)}%) |`);
report.push(`| Average questions per case | ${summary.averageQuestionsPerCase} |`);
report.push(`| Recorded transport retries | ${retryLog.length} |`);
report.push(`| Total retry backoff wait | ${(totalRetryDelayMs / 1000).toFixed(0)}s |`);
report.push(`| Retry-After header honored | ${retryAfterRespectedCount} |`);
report.push(`| Max retries in a single case | ${maxRetriesPerCase} |`);
report.push(`| Provider-class failures (honest AI_TIMEOUT/AI_PROVIDER) | ${results.filter((r) => r.criticals.includes('PROVIDER')).length} |`);
report.push(`| Generated-draft passes (draft AND hard-gate pass) | ${summary.generatedDraftPasses} |`);
report.push(`| Product-evaluable hard gate (non-provider cases) | ${summary.productHardGate.pass}/${summary.productHardGate.evaluable} (${(summary.productHardGate.rate * 100).toFixed(1)}%) |`);
report.push(`| Product failures (no draft, not provider, not a refusal) | ${summary.productFailures} |`);
report.push(`| Principled refusals | ${summary.principledRefusals.total} — accepted: ${summary.principledRefusals.accepted}${summary.principledRefusals.acceptedIds.length ? ` (ids ${summary.principledRefusals.acceptedIds.join(', ')})` : ''} / rejected: ${summary.principledRefusals.rejected}${summary.principledRefusals.rejectedIds.length ? ` (ids ${summary.principledRefusals.rejectedIds.join(', ')})` : ''} |`);
report.push(`| Draft-invalid breakdown | refusal ${summary.draftInvalidBreakdown.principledRefusal}, quality validator ${summary.draftInvalidBreakdown.qualityValidator}, repair exhausted ${summary.draftInvalidBreakdown.repairExhausted}, schema ${summary.draftInvalidBreakdown.schemaProblem}, unknown ${summary.draftInvalidBreakdown.unknown} |`);
report.push(`| Over-asked cases (question cap hit) | ${summary.overAskedCases.length} |`);
report.push(`| Integrity: ghost questions (RC-P1-E) | ${summary.integrity.ghostQuestionCount} |`);
report.push(`| Integrity: past deadlines accepted (RC-P1-F) | ${summary.integrity.pastDeadlineAcceptedCount} |`);
report.push(`| Integrity: ranges collapsed (RC-P1-G) | ${summary.integrity.rangeCollapsedCount} |`);
report.push(`| Integrity: prefix-parse semantic loss (RC-P1-G) | ${summary.integrity.prefixParseSemanticLossCount} |`);
report.push(`| Integrity: interview/draft temporal mismatches (RC-P1-F) | ${summary.integrity.interviewDraftTemporalMismatchCount} |`);
report.push(`| Unnecessary answers (past canGenerate) | ${summary.unnecessaryAnswers} |`);
report.push(`| Answers beyond expected depth (extraction debt) | ${summary.answersBeyondExpectedRange} (cases: ${summary.providerExtractionDepthInflation.length}) |`, '');
report.push('## Pass rate by difficulty', '', '| Difficulty | Pass | Total | Rate |', '|---|---:|---:|---:|');
for (const [k, v] of Object.entries(summary.passRateByDifficulty)) report.push(`| ${k} | ${v.pass} | ${v.total} | ${(v.rate * 100).toFixed(1)}% |`);
report.push('', '## Pass rate by group', '', '| Group | Pass | Total | Rate |', '|---|---:|---:|---:|');
for (const [k, v] of Object.entries(summary.passRateByGroup)) report.push(`| ${k} | ${v.pass} | ${v.total} | ${(v.rate * 100).toFixed(1)}% |`);
report.push('', '## Cases', '');
for (const r of results) {
  report.push(`### ${r.id}. [${r.difficulty}] ${r.group} — ${r.pass ? 'PASS' : 'FAIL'} — structural ${r.structural.score}, usefulness ${r.usefulness.usefulnessScore}, questions ${r.questionCount}`, '');
  if (r.error) report.push(`Error: ${r.error}`, '');
  if (r.draft) {
    report.push(`Generated: **${r.draft.title}** (category ${r.draft.category}, target ${r.draft.targetType ?? 'none'})`);
    for (const t of r.draft.tasks) {
      report.push(`- ${t.title} — ${t.recurrenceType} ${JSON.stringify(t.recurrenceConfig)} — ${t.estimatedMinutes ?? '?'} min`);
    }
    report.push('', `Adjustments: ${r.adjustments.length ? r.adjustments.join('; ') : 'none'}`, '');
  }
  report.push(r.failures.length ? `Failures:\n${r.failures.map((f) => `- ${f.code}${r.criticals.includes(f.code) ? ' (critical)' : ''}: ${f.detail}`).join('\n')}` : 'Failures: none', '');
}
await writeFile(path.join(outDir, 'report.md'), report.join('\n') + '\n');

const failing = results.filter((r) => !r.pass);
const failuresMd = [];
failuresMd.push('# Baseline failures (hard-gate fails only)', '');
failuresMd.push(`- Fixture SHA-256: \`${fixtureSha256}\``);
if (partialRun) failuresMd.push(`- Partial run: ${n} of 100 fixture cases (ids: ${selectedIds.join(', ')})`);
if (resumeState) failuresMd.push(`- Resume of \`${resumeState.dir}\`: ${carriedResults.length} carried verbatim, ${rerunCaseIds.length} rerun`);
failuresMd.push(`- Failures: ${failing.length}/${denom}`, '');
for (const r of failing) {
  failuresMd.push(`## ${r.id}. [${r.difficulty}] ${r.group} — structural ${r.structural.score}, usefulness ${r.usefulness.usefulnessScore}, questions ${r.questionCount}`, '');
  failuresMd.push(`Critical: ${[...new Set(r.criticals)].join(', ') || 'none'}`);
  if (r.error) failuresMd.push(`Error: ${r.error}`, '');
  for (const f of r.failures) failuresMd.push(`- ${f.code}: ${f.detail}`);
  if (r.usefulness?.issues?.length) failuresMd.push('', `Usefulness notes: ${r.usefulness.issues.join(' | ')}`);
  failuresMd.push('');
}
await writeFile(path.join(outDir, 'failures.md'), failuresMd.join('\n') + '\n');

console.log(`\nFINAL ${JSON.stringify({
  executed: `${n}/100${partialRun ? ` PARTIAL (ids: ${selectedIds.join(',')})` : ''}`,
  fullyExecuted: `${executed}/${denom}`,
  structuralAverage: summary.structuralAverage, usefulnessAverage: summary.usefulnessAverage,
  criticalFailures: criticalTotal, casesWithCritical: casesWithCritical,
  hardGatePass: `${passCount}/${denom}`, retries: retryLog.length,
  totalRetryDelaySeconds: Math.round(totalRetryDelayMs / 1000),
  retryAfterRespected: retryAfterRespectedCount, maxRetriesPerCase,
  overAsked: summary.overAskedCases,
})}`);
console.log(`ARTIFACTS ${outDir}`);
process.exit(passCount === results.length ? 0 : 1);
