import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateSemanticCase } from '../src/benchmark/semantic-validator.js';
import { REAL_WORLD_FIXTURES } from '../src/benchmark/real-world-fixtures.js';
import { questionTopic } from '../src/ai/interview-plan.js';

const api = process.env.BENCHMARK_API ?? 'http://127.0.0.1:8080/api';
const outputDirectory = path.resolve(process.argv[2] ?? '../../benchmark-results');
let cookie = '';

async function call(route: string, init: RequestInit = {}) {
  const response = await fetch(`${api}${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

function answer(question: { prompt: string; type?: string; options?: string[]; allowCustomAnswer?: boolean }) {
  const topic = questionTopic(question.prompt, question.type as Parameters<typeof questionTopic>[1], question.options);
  if (question.type === 'NUMBER') return topic === 'DURATION' ? 30 : 3;
  if (question.type === 'DATE') return '2026-12-31';
  if (question.type === 'TIME') return '19:00';
  if (question.type === 'DAYS_OF_WEEK') return ['Mon', 'Wed', 'Sat'];
  if (question.type === 'MULTI_SELECT') return question.options?.slice(0, 2) ?? ['Flexible'];
  if (question.type === 'SINGLE_SELECT') return question.options?.[0] ?? 'Flexible';
  if (topic === 'TARGET') return 'A clear, sustainable improvement I can notice within eight weeks';
  if (topic === 'CONSTRAINT') return 'Keep it realistic and sustainable';
  return 'A practical beginner plan that fits three 30-minute sessions per week';
}

const login = await call('/auth/login', {
  method: 'POST',
  body: JSON.stringify({
    email: process.env.TEST_EMAIL ?? 'kitty@goalify.app',
    password: process.env.TEST_PASSWORD ?? 'goalify123',
  }),
});
if (login.status !== 200) throw new Error(`Login failed with HTTP ${login.status}`);

const results: any[] = [];
for (const fixture of REAL_WORLD_FIXTURES) {
  let sessionId: string | undefined;
  let draftId: string | undefined;
  const interview: Array<{ question: any; answer: unknown }> = [];
  try {
    let response = await call('/copilot/goal-sessions', {
      method: 'POST', body: JSON.stringify({ goal: fixture.prompt }),
    });
    if (response.status !== 200) throw new Error(`start HTTP ${response.status}`);
    let turn = response.body;
    sessionId = turn.sessionId;
    while (turn.question && interview.length < 3) {
      const value = answer(turn.question);
      interview.push({ question: turn.question, answer: value });
      response = await call(`/copilot/goal-sessions/${sessionId}/answers`, {
        method: 'POST', body: JSON.stringify({ questionId: turn.question.id, answer: value }),
      });
      if (response.status !== 200) throw new Error(`answer HTTP ${response.status}`);
      turn = response.body;
    }
    response = await call(`/copilot/goal-sessions/${sessionId}/generate`, { method: 'POST', body: '{}' });
    if (response.status !== 200 || !response.body?.draft) throw new Error(`generate HTTP ${response.status}`);
    draftId = response.body.draft.id;
    const evaluation = evaluateSemanticCase({}, {
      prompt: fixture.prompt,
      draft: response.body.draft,
      interview,
      today: new Date().toISOString().slice(0, 10),
    });
    const questionRangePass = interview.length >= fixture.questions.min && interview.length <= fixture.questions.max;
    results.push({ fixture, interview, draft: response.body.draft, ...evaluation, questionRangePass, finalPass: evaluation.finalPass && questionRangePass });
  } catch (error) {
    results.push({ fixture, error: (error as Error).message, structuralScore: 0, usefulnessScore: 0, finalPass: false });
  } finally {
    if (draftId) await call(`/copilot/goal-drafts/${draftId}/discard`, { method: 'POST', body: '{}' }).catch(() => {});
    if (sessionId) await call(`/copilot/goal-sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
  }
}

const average = (field: string) => Number((results.reduce((sum, result) => sum + (result[field] ?? 0), 0) / results.length).toFixed(2));
const summary = {
  cases: results.length,
  passed: results.filter((result) => result.finalPass).length,
  structuralAverage: average('structuralScore'),
  usefulnessAverage: average('usefulnessScore'),
  zeroCriticalFailures: results.every((result) => !(result.critical?.length)),
  gates: { structuralScore: 90, usefulnessScore: 75, criticalFailure: false },
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, `real-world-quality-${stamp}.json`), JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.passed !== summary.cases) process.exitCode = 1;
