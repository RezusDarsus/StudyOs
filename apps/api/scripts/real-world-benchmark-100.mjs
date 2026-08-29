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
 * Hard rules honored here:
 *  - The fixture is frozen: SHA-256 verified before anything runs; mismatch aborts.
 *  - A dedicated benchmark account is registered per run (generated password, held
 *    in memory only, never logged, never written to an artifact).
 *  - Per case: real HTTP flow only (start -> answers -> generate), then ALWAYS
 *    (try/finally) discard the draft and DELETE the session.
 *  - Retries: at most one per HTTP call, transport-level only (connection
 *    failure/timeout or any 5xx), every retry recorded in the results.
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
// A 5xx retry with no delay just burns its second attempt inside the same
// provider rate-limit window, doubling the damage an outage does to the run.
const RETRY_DELAY_MS = 20_000;
const HARD_QUESTION_CEILING = 10;

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

// ---------------------------------------------------------------- helpers

const DAYS3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAME_TO3 = {
  sunday: 'Sun', sun: 'Sun', monday: 'Mon', mon: 'Mon',
  tuesday: 'Tue', tues: 'Tue', tue: 'Tue', wednesday: 'Wed', wed: 'Wed',
  thursday: 'Thu', thurs: 'Thu', thu: 'Thu', friday: 'Fri', fri: 'Fri',
  saturday: 'Sat', sat: 'Sat',
};

/** Fixed answer-date offset, computed once per run: today + 10 weeks. */
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
const retryLog = []; // {caseId, route, attempt, reason, status}

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
        retryLog.push({ caseId: meta.caseId, route, attempt, reason: `HTTP ${status}`, status, code: body?.code ?? null });
        console.log(`    · transport retry ${meta.caseId} ${route} -> HTTP ${status} (${body?.code ?? 'no code'})`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      return { status, body, attempts };
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : `network: ${err?.cause?.code ?? err?.message ?? err}`;
      attempts.push({ attempt, status: null, elapsed: Date.now() - started, ok: false });
      if (attempt === 1) {
        retryLog.push({ caseId: meta.caseId, route, attempt, reason });
        console.log(`    · transport retry ${meta.caseId} ${route} -> ${reason}`);
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
  const result = {
    id: testCase.id,
    difficulty: testCase.difficulty,
    group: testCase.group,
    prompt: testCase.prompt,
    questionCap: questionCap(testCase),
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

    // -- answers until the cap (or the hard ceiling, or the interview ends)
    let guard = 0;
    while (turn.question && result.interview.length < result.questionCap && guard < HARD_QUESTION_CEILING) {
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
      turn = answerRes.body;
    }
    result.questionCount = result.interview.length;
    result.finalTurn = {
      status: turn.status,
      questionCount: turn.questionCount,
      readiness: turn.readiness ?? null,
      canGenerate: turn.canGenerate,
      revision: turn.revision,
    };
    if (turn.question) {
      // The cap (or ceiling) stopped us while the model still wanted to ask.
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

  // -- hard gate
  const verdict = hardGatePass(testCase, result);
  result.pass = verdict.pass;
  result.inQuestionRange = verdict.inQuestionRange;
  result.passReasons = verdict.reasons;
  return result;
}

// ---------------------------------------------------------------- main

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(RESULTS_ROOT, `100-case-baseline-${stamp}`);
await mkdir(outDir, { recursive: true });
await copyFile(FIXTURE_PATH, path.join(outDir, 'frozen-100.json'));
await copyFile(SHA_PATH, path.join(outDir, 'frozen-100.sha256'));

console.log('Goalify Copilot — Real-World Quality Benchmark (frozen 100-case baseline)');
console.log(`  API:        ${API}`);
console.log(`  fixture:    ${FIXTURE_PATH}`);
console.log(`  sha256:     ${fixtureSha256}`);
console.log(`  artifacts:  ${outDir}`);
console.log(`  today:      ${TODAY}  defaultAnswerDate: ${DEFAULT_DATE}`);

// dedicated, disposable account — generated password lives in memory only
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
console.log(`  gates:      structural>=90  usefulness>=75  no critical failure  questionCount within range\n`);

const results = [];
for (let index = 0; index < fixture.length; index++) {
  const testCase = fixture[index];
  const r = await runCase(testCase);
  results.push(r);
  const mark = r.pass ? 'PASS' : 'FAIL';
  console.log(
    `[${String(index + 1).padStart(3)}/100] ${r.difficulty.padEnd(6)} #${String(r.id).padStart(3)} q=${r.questionCount}` +
    `  structural=${String(r.structural?.score ?? '-').padStart(3)} usefulness=${String(r.usefulness?.usefulnessScore ?? '-').padStart(3)}  ${mark}` +
    `  ${(r.timings.totalMs / 1000).toFixed(1)}s` +
    (r.criticals.length ? `  CRITICAL: ${[...new Set(r.criticals)].join(',')}` : '') +
    (r.error ? `  ${r.error.slice(0, 120)}` : ''),
  );
  if (!r.pass && r.criticals.length) {
    console.log(`      ${r.criticals.map((c) => `${c}: ${(r.failures.find((f) => f.code === c)?.detail ?? '').slice(0, 160)}`).join('\n      ')}`);
  }
  // checkpoint after every case so a crash never loses the run
  await writeFile(path.join(outDir, 'raw-results.json'), JSON.stringify({
    benchmark: 'GOALIFY_COPILOT_REAL_WORLD_QUALITY_BASELINE_100',
    api: API,
    fixtureSha256,
    today: TODAY,
    defaultAnswerDate: DEFAULT_DATE,
    startedAt: stamp,
    updatedAt: new Date().toISOString(),
    completedCases: results.length,
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

const summary = {
  benchmark: 'GOALIFY_COPILOT_REAL_WORLD_QUALITY_BASELINE_100',
  fixtureSha256,
  scorerVersion: SCORER_VERSION,
  api: API,
  startedAt: stamp,
  finishedAt: new Date().toISOString(),
  executedCases: results.length,
  executedFully: executed,
  transportFailureCases: results.filter((r) => !r.transportSuccess).map((r) => ({ id: r.id, kind: r.criticals?.[0] ?? r.errorKind, error: r.error })),
  providerFailureCases: results.filter((r) => r.criticals.includes('PROVIDER')).map((r) => r.id),
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
  retryCount: retryLog.length,
  retries: retryLog,
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
  transcripts: results.map((r) => ({ id: r.id, interview: r.interview, transcript: r.transcript })),
}, null, 2) + '\n');
await writeFile(path.join(outDir, 'drafts.json'), JSON.stringify({
  fixtureSha256,
  drafts: results.map((r) => ({ id: r.id, draft: r.draft, adjustments: r.adjustments, assumptions: r.assumptions })),
}, null, 2) + '\n');

const report = [];
report.push('# Goalify Copilot — Real-World Quality Benchmark (frozen 100-case baseline)', '');
report.push(`- API target: \`${API}\``);
report.push(`- Fixture: \`apps/api/scripts/benchmark-fixtures/frozen-100.json\``);
report.push(`- Fixture SHA-256: \`${fixtureSha256}\``);
report.push(`- Account: dedicated, disposable benchmark account (no credentials recorded)`);
report.push(`- Gates: structural ≥ 90, usefulness ≥ 75, no critical failure, question count within expected range`, '');
report.push(`| Metric | Value |`);
report.push(`|---|---:|`);
report.push(`| Executed cases | ${results.length}/100 |`);
report.push(`| Fully executed (draft produced) | ${executed}/100 |`);
report.push(`| Structural average | ${summary.structuralAverage} |`);
report.push(`| Usefulness average | ${summary.usefulnessAverage} |`);
report.push(`| Critical failures (total) | ${criticalTotal} |`);
report.push(`| Cases with a critical failure | ${casesWithCritical}/100 |`);
report.push(`| Hard-gate pass | ${passCount}/100 (${(summary.hardGatePassRate * 100).toFixed(1)}%) |`);
report.push(`| Average questions per case | ${summary.averageQuestionsPerCase} |`);
report.push(`| Recorded transport retries | ${retryLog.length} |`);
report.push(`| Provider-class failures (honest AI_TIMEOUT/AI_PROVIDER) | ${results.filter((r) => r.criticals.includes('PROVIDER')).length} |`);
report.push(`| Over-asked cases (question cap hit) | ${summary.overAskedCases.length} |`, '');
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
failuresMd.push(`- Failures: ${failing.length}/100`, '');
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
  executed: `${results.length}/100`, fullyExecuted: `${executed}/100`,
  structuralAverage: summary.structuralAverage, usefulnessAverage: summary.usefulnessAverage,
  criticalFailures: criticalTotal, casesWithCritical: casesWithCritical,
  hardGatePass: `${passCount}/100`, retries: retryLog.length, overAsked: summary.overAskedCases,
})}`);
console.log(`ARTIFACTS ${outDir}`);
process.exit(passCount === results.length ? 0 : 1);
