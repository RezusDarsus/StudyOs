#!/usr/bin/env node
/**
 * Goalify Copilot — frozen intent benchmark (spec item 49).
 *
 * Measures the OFFLINE layer only: classifyIntentDeterministic runs on every
 * fixture message with no provider, no network and no LLM call. The fixture is
 * frozen (SHA-256 verified before anything runs, like the real-world frozen-100),
 * so rule changes that shift a verdict show up as a metrics move, not a silent
 * fixture edit.
 *
 *   node scripts/intent-benchmark.mjs
 *
 * The runner also guards the real-world benchmark's compatibility: every prompt
 * in benchmark-fixtures/frozen-100.json must classify CREATE_GOAL
 * deterministically, because that runner POSTs each prompt as goalText and
 * expects the session to be created (verified against the frozen fixture's own
 * SHA-256 sidecar, so a different fixture can never pass silently).
 *
 * Exit 0 iff:
 *   - fixture SHA matches the sidecar,
 *   - CREATE_GOAL false-positive rate <= 2% (non-goal messages classified
 *     CREATE_GOAL / total non-goal),
 *   - CREATE_GOAL recall >= 95%,
 *   - all 100 frozen-100 prompts classify CREATE_GOAL deterministically.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, 'intent-fixture-100.json');
const SIDECAR_PATH = join(here, 'intent-fixture-100.sha256');
const FROZEN_PATH = join(here, 'benchmark-fixtures', 'frozen-100.json');
const FROZEN_SIDECAR_PATH = join(here, 'benchmark-fixtures', 'frozen-100.sha256');

const CLASSES = [
  'CREATE_GOAL',
  'MODIFY_GOAL',
  'GOAL_QUESTION',
  'PRODUCT_HELP',
  'GENERAL_QUESTION',
  'UNKNOWN',
];
const FP_RATE_LIMIT = 0.02;
const RECALL_LIMIT = 0.95;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyFrozen(path, sidecarPath, label) {
  const actual = sha256File(path);
  const expected = readFileSync(sidecarPath, 'utf8').trim();
  if (actual !== expected) {
    console.error(`FROZEN FIXTURE MISMATCH (${label}): ${path}`);
    console.error(`  expected ${expected}`);
    console.error(`  actual   ${actual}`);
    process.exit(1);
  }
  return actual;
}

// The classifier is TypeScript; register the loader hook before importing the
// source. Plain `node scripts/intent-benchmark.mjs` works because tsx ships an
// api for exactly this — no build step, same as the real-world runner.
let classifyIntentDeterministic;
try {
  const { register } = await import('tsx/esm/api');
  register();
  ({ classifyIntentDeterministic } = await import('../src/ai/intent-router.ts'));
  // The runtime-content port is installed unconditionally (Stage 6: the
  // vocabularies are runtime data, composition is not a flag question).
  const { installRuntimeContent } = await import('../src/runtime-content.ts');
  installRuntimeContent();
} catch (err) {
  console.error('Could not load src/ai/intent-router.ts (is tsx installed?):', err.message);
  process.exit(1);
}

// ------------------------------------------------------------------- fixture

const fixtureSha = verifyFrozen(FIXTURE_PATH, SIDECAR_PATH, 'intent-fixture-100');
const frozenSha = verifyFrozen(FROZEN_PATH, FROZEN_SIDECAR_PATH, 'frozen-100');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

// confusion[expected][actual]
const confusion = Object.fromEntries(
  CLASSES.map((expected) => [expected, Object.fromEntries(CLASSES.map((actual) => [actual, 0]))]),
);

for (const { intent, text } of fixture) {
  const actual = classifyIntentDeterministic(text).intent;
  confusion[intent][actual] += 1;
}

// ------------------------------------------------------------------- metrics

const classMetrics = {};
for (const c of CLASSES) {
  const tp = confusion[c][c];
  const predictedAsC = CLASSES.reduce((sum, expected) => sum + confusion[expected][c], 0);
  const actuallyC = CLASSES.reduce((sum, actual) => sum + confusion[c][actual], 0);
  classMetrics[c] = {
    support: actuallyC,
    precision: predictedAsC === 0 ? null : tp / predictedAsC,
    recall: actuallyC === 0 ? null : tp / actuallyC,
  };
}

const totalNonGoal = fixture.filter((f) => f.intent !== 'CREATE_GOAL').length;
const falsePositives = fixture.filter(
  ({ intent, text }) => intent !== 'CREATE_GOAL' && classifyIntentDeterministic(text).intent === 'CREATE_GOAL',
);
const createRecall = classMetrics.CREATE_GOAL.recall ?? 0;
const fpRate = totalNonGoal === 0 ? 0 : falsePositives.length / totalNonGoal;

// ----------------------------------------------------------- frozen-100 gate

const frozen = JSON.parse(readFileSync(FROZEN_PATH, 'utf8'));
const frozenMisclassified = frozen.filter(
  (testCase) => classifyIntentDeterministic(testCase.prompt).intent !== 'CREATE_GOAL',
);

// -------------------------------------------------------------------- report

const pct = (value) => (value === null ? '  n/a' : `${(value * 100).toFixed(1).padStart(5)}%`);
const width = 16;
console.log('Intent benchmark — deterministic layer only (no LLM, no network)');
console.log(`fixture: intent-fixture-100.json  sha256 ${fixtureSha}`);
console.log(`frozen : benchmark-fixtures/frozen-100.json  sha256 ${frozenSha}`);
console.log('');
console.log('Confusion matrix (rows = expected, columns = predicted):');
console.log(`${' '.repeat(width)}${CLASSES.map((c) => c.slice(0, 6).padStart(8)).join('')}`);
for (const expected of CLASSES) {
  const row = CLASSES.map((actual) => String(confusion[expected][actual]).padStart(8)).join('');
  console.log(`${expected.padEnd(width)}${row}`);
}
console.log('');
console.log('Per-class metrics:');
for (const c of CLASSES) {
  const m = classMetrics[c];
  console.log(
    `  ${c.padEnd(17)} precision ${pct(m.precision)}  recall ${pct(m.recall)}  support ${m.support}`,
  );
}
console.log('');
console.log(
  `CREATE_GOAL recall: ${(createRecall * 100).toFixed(1)}% (limit >= ${(RECALL_LIMIT * 100).toFixed(0)}%)`,
);
console.log(
  `CREATE_GOAL false-positive rate: ${(fpRate * 100).toFixed(2)}% ` +
    `(${falsePositives.length}/${totalNonGoal} non-goal messages, limit <= ${(FP_RATE_LIMIT * 100).toFixed(0)}%)`,
);
if (falsePositives.length > 0) {
  console.log('False positives (expected -> predicted CREATE_GOAL):');
  for (const { id, intent, text } of falsePositives) {
    console.log(`  #${id} [${intent}] "${text}"`);
  }
}
console.log('');
console.log(
  `frozen-100 compatibility: ${frozen.length - frozenMisclassified.length}/${frozen.length} prompts ` +
    'classify CREATE_GOAL deterministically',
);
if (frozenMisclassified.length > 0) {
  for (const { id, prompt } of frozenMisclassified.slice(0, 20)) {
    const actual = classifyIntentDeterministic(prompt).intent;
    console.log(`  frozen #${id} -> ${actual}: "${prompt.slice(0, 90)}"`);
  }
}

// --------------------------------------------------------------------- verdict

const failures = [];
if (createRecall < RECALL_LIMIT) {
  failures.push(`CREATE_GOAL recall ${(createRecall * 100).toFixed(1)}% < ${(RECALL_LIMIT * 100).toFixed(0)}%`);
}
if (fpRate > FP_RATE_LIMIT) {
  failures.push(`CREATE_GOAL false-positive rate ${(fpRate * 100).toFixed(2)}% > ${(FP_RATE_LIMIT * 100).toFixed(0)}%`);
}
if (frozenMisclassified.length > 0) {
  failures.push(`${frozenMisclassified.length} frozen-100 prompts did not classify CREATE_GOAL`);
}
if (failures.length > 0) {
  console.error('');
  console.error(`FAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('');
console.log('PASS');
