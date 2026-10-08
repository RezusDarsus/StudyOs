#!/usr/bin/env node
/**
 * StudyOS benchmark-v2 — reproducible prediction-calibration + provider benchmark runner.
 *
 * What it does, in order:
 *   1. Reads manifest.json, verifies every fixture file exists, computes the corpus SHA-256.
 *   2. POSTs the corpus to /api/prediction-benchmark/import (the backend ingests it through the
 *      ordinary pipeline and records the manifest; re-running with the same corpus reuses the
 *      workspace — idempotent per fixture hash).
 *   3. Runs the walk-forward backtest against that workspace, passing the fixture hash so the
 *      persisted run records its corpus.
 *   4. Optionally sends a bounded prompt set through the chat API (provider benchmark smoke).
 *   5. Writes a timestamped report into reports/ — never overwrites an earlier one.
 *
 * Usage:
 *   node run-prediction-benchmark.mjs [--base http://localhost:8081] [--prompts 0]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : (process.env.STUDYOS_BASE_URL || 'http://localhost:8081');
const promptCount = args.includes('--prompts') ? Number(args[args.indexOf('--prompts') + 1] || 0) : 0;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const reportsDir = path.resolve(here, '../../reports');

const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function request(route, options = {}, timeoutMs = 600_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = process.hrtime.bigint();
  try {
    const response = await fetch(`${base}${route}`, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { ok: response.ok, status: response.status, latencyMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n), body, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 1. fixtures

const fixtures = [];
const fixtureHashes = {};
for (const name of manifest.fixtureOrder) {
  const filePath = path.join(here, 'fixtures', name);
  if (!fs.existsSync(filePath)) { console.error(`MISSING FIXTURE: ${name}`); process.exit(1); }
  const content = fs.readFileSync(filePath, 'utf8');
  fixtureHashes[name] = sha256(content);
  fixtures.push({
    name,
    type: manifest.import.types[name] || (name.startsWith('SYNTHETIC') ? 'PAST_EXAM' : name.includes('lecture') ? 'LECTURE' : 'OTHER'),
    content,
    year: manifest.import.examYears[name] || null,
    examDate: manifest.import.examDates[name] || null
  });
}
const corpusHash = sha256(manifest.fixtureOrder.join('\n') + '\n' + manifest.fixtureOrder.map(name => fixtureHashes[name]).join('\n'));
console.log(`Corpus: ${fixtures.length} fixtures, corpus hash ${corpusHash}`);

// ---------------------------------------------------------------- 2. import

console.log('Importing corpus (this ingests every document through the real pipeline)…');
const imported = await request('/api/prediction-benchmark/import', {
  method: 'POST',
  body: JSON.stringify({ title: manifest.import.title, corpusKind: manifest.corpusKind, fixtures })
});
if (!imported.ok) { console.error('Import failed:', imported.status, imported.text?.slice(0, 400)); process.exit(1); }
const importResult = imported.body;
console.log(`Imported: workspace ${importResult.courseId}, documents=${importResult.imported}, exams=${importResult.exams}, failed=${importResult.failed}`);

// ---------------------------------------------------------------- 3. backtest

console.log('Running walk-forward backtest…');
const backtest = await request(`/api/workspaces/${importResult.courseId}/exam-predictions/backtest?fixtureHash=${corpusHash}`);
if (!backtest.ok) { console.error('Backtest failed:', backtest.status, backtest.text?.slice(0, 400)); process.exit(1); }
const report = backtest.body;
console.log(`Backtest: status=${report.status} folds=${report.foldsEvaluated} exams=${report.historicalExams}`);
console.log(`  P@5=${report.ranking?.precisionAt5?.toFixed(3)} R@5=${report.ranking?.recallAt5?.toFixed(3)} NDCG@5=${report.ranking?.ndcgAt5?.toFixed(3)} Brier=${report.brier?.toFixed(4)}`);
for (const [model, stats] of Object.entries(report.baselineRanking || {})) {
  console.log(`  ${model}: P@5=${stats.precisionAt5?.toFixed(3)} NDCG@5=${stats.ndcgAt5?.toFixed(3)} Brier=${report.baselineBrier?.[model]?.toFixed(4)}`);
}
console.log(`  ${report.fittingPolicy}`);

// ---------------------------------------------------------------- 4. optional provider smoke

let providerSmoke = null;
if (promptCount > 0) {
  const prompts = JSON.parse(fs.readFileSync(path.join(here, 'prompts-v2.json'), 'utf8')).slice(0, promptCount);
  const chat = await request(`/api/workspaces/${importResult.courseId}/chats`, { method: 'POST', body: JSON.stringify({ title: 'benchmark-v2 provider smoke', purpose: 'MAIN_TUTOR' }) });
  const chatId = chat.body.id;
  providerSmoke = { promptCount: prompts.length, results: [] };
  for (const prompt of prompts) {
    const result = await request(`/api/workspaces/${importResult.courseId}/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ content: prompt }) });
    providerSmoke.results.push({ prompt: prompt.slice(0, 80), ok: result.ok, status: result.status, latencyMs: result.latencyMs });
    console.log(`  prompt ok=${result.ok} ${result.latencyMs}ms :: ${prompt.slice(0, 60)}…`);
  }
  providerSmoke.transportSuccess = providerSmoke.results.filter(r => r.ok).length / providerSmoke.results.length;
  providerSmoke.meanLatencyMs = providerSmoke.results.reduce((total, r) => total + r.latencyMs, 0) / providerSmoke.results.length;
}

// ---------------------------------------------------------------- 5. report (timestamped, never overwrites)

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportsDir, `benchmark-v2-prediction-${stamp}.json`);
fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  benchmark: 'benchmark-v2',
  runAt: new Date().toISOString(),
  base,
  corpus: {
    hash: corpusHash,
    fixtureHashes,
    corpusKind: manifest.corpusKind,
    fixtureCount: fixtures.length,
    realExams: manifest.honesty.realExams,
    syntheticExams: manifest.honesty.syntheticExams,
    note: manifest.honesty.note
  },
  import: importResult,
  backtest: report,
  providerSmoke
}, null, 2));
console.log(`Report written: ${reportPath}`);
