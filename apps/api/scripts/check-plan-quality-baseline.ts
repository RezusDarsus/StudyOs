/**
 * Run the production plan-quality scorer (scorePlanQuality) over the stored
 * frozen-100 baseline drafts, offline. Used to measure a scoring change's effect
 * BEFORE vs AFTER: a case whose planScore crosses below the repair threshold
 * (<50) would now be rejected into repair, so existing passes must be checked
 * for regressions before shipping the change.
 *
 *   npx tsx apps/api/scripts/check-plan-quality-baseline.ts [baselineDir]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scorePlanQuality } from '../src/ai/plan-quality.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_ROOT = path.resolve(here, '../../../benchmark-results');
const FIXTURE_PATH = path.join(here, 'benchmark-fixtures', 'frozen-100.json');

const baselineArg = process.argv[2];
let baselineDir: string;
if (baselineArg) {
  baselineDir = path.isAbsolute(baselineArg) ? baselineArg : path.resolve(process.cwd(), baselineArg);
} else {
  const { readdir } = await import('node:fs/promises');
  const candidates = (await readdir(RESULTS_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith('100-case-baseline-'))
    .map((d) => d.name)
    .sort();
  if (!candidates.length) throw new Error('No 100-case-baseline-* directory found');
  baselineDir = path.join(RESULTS_ROOT, candidates[candidates.length - 1]);
}

const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Array<{ id: number; prompt: string }>;
const fixtureById = new Map(fixture.map((c) => [c.id, c]));
const drafts = JSON.parse(await readFile(path.join(baselineDir, 'drafts.json'), 'utf8')) as {
  drafts: Array<{ id: number; draft: unknown }>;
};
const transcripts = JSON.parse(await readFile(path.join(baselineDir, 'transcripts.json'), 'utf8')) as {
  transcripts: Array<{ id: number; transcript: Array<{ role: string; content: string }> }>;
};
const answersById = new Map(transcripts.transcripts.map((t) => [
  t.id,
  t.transcript.filter((m) => m.role === 'user').map((m) => m.content).join(' '),
]));

const rows = drafts.drafts.map(({ id, draft }) => {
  if (!draft) return { id, planScore: null, goalRelevance: null, issues: [] as string[] };
  const goalText = fixtureById.get(id)!.prompt;
  const quality = scorePlanQuality(goalText, draft as never, answersById.get(id) ?? '');
  return { id, planScore: quality.planScore, goalRelevance: quality.goalRelevance, issues: quality.issues };
});

const scored = rows.filter((r) => r.planScore !== null) as Array<{ id: number; planScore: number; goalRelevance: number; issues: string[] }>;
const belowThreshold = scored.filter((r) => r.planScore < 50);
const relevanceDropped = scored.filter((r) => r.goalRelevance < 20);
console.log(JSON.stringify({
  baselineDir: path.basename(baselineDir),
  scoredDrafts: scored.length,
  belowRepairThreshold: belowThreshold.map((r) => r.id),
  goalRelevanceBelow20: relevanceDropped.map((r) => r.id),
  perCase: Object.fromEntries(scored.map((r) => [r.id, r.planScore])),
}, null, 2));
