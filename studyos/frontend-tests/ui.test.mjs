import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from './setup.js';

loadAll('components/format.js', 'components/badges.js', 'components/states.js');
const Format = globalThis.StudyOSFormat;
const UI = globalThis.StudyOSUI;

test('a successful grade renders even when the caller passes null handlers', () => {
  loadAll('tutor/exercise-view.js');
  const Tutor = globalThis.StudyOSTutor;
  const container = { innerHTML: '', querySelector: () => null };
  Tutor.renderExerciseGrade(container, { correctness: 'CORRECT', score: 1, feedback: 'solid reasoning', masteryBefore: 0.5, masteryAfter: 0.6, evidenceWeight: 1 }, null);
  assert.match(container.innerHTML, /CORRECT/);
  assert.match(container.innerHTML, /Mastery 50% → 60%/);
});

test('percent clamps and rounds', () => {
  assert.equal(Format.percent(0.4382), '44%');
  assert.equal(Format.percent(2), '100%');
  assert.equal(Format.percent(-1), '0%');
  assert.equal(Format.percent('not a number'), '0%');
});

test('formatMinutes stays human', () => {
  assert.equal(Format.formatMinutes(45), '45m');
  assert.equal(Format.formatMinutes(75), '1h 15m');
  assert.equal(Format.formatMinutes(120), '2h');
  assert.equal(Format.formatMinutes(0), '0m');
});

test('reviewDueLabel speaks in days and direction', () => {
  const now = new Date('2026-08-29T12:00:00Z');
  assert.equal(Format.reviewDueLabel('2026-08-29T00:00:00Z', now), 'Review overdue');
  assert.equal(Format.reviewDueLabel('2026-08-30T00:00:00Z', now), 'Review due tomorrow');
  assert.equal(Format.reviewDueLabel('2026-09-03T00:00:00Z', now), 'Review due in 5 days');
  assert.equal(Format.reviewDueLabel(null, now), null);
});

test('mastery labels follow learning vocabulary, never bare numbers', () => {
  assert.equal(UI.masteryLabel(0.95).label, 'Strong');
  assert.equal(UI.masteryLabel(0.72).label, 'Held');
  assert.equal(UI.masteryLabel(0.5).label, 'Developing');
  assert.equal(UI.masteryLabel(0.2).label, 'Weak');
  assert.equal(UI.masteryLabel(0).label, 'Not started');
});

test('confidence depends on evidence, not just the number', () => {
  assert.equal(UI.confidenceLabel(0.9, 5).label, 'High');
  assert.equal(UI.confidenceLabel(0.2, 0).label, 'No evidence yet');
  assert.equal(UI.confidenceLabel(0.5, 3).label, 'Medium');
});

test('relevance and coverage labels are graded words', () => {
  assert.equal(UI.relevanceLabel(0.85).label, 'High relevance');
  assert.equal(UI.relevanceLabel(0).label, 'No exam signal');
  assert.equal(UI.coverageLabel('STRONG').label, 'Evidence coverage: Strong');
  assert.equal(UI.coverageLabel('weak').label, 'Evidence coverage: Weak');
  assert.equal(UI.coverageLabel(null).label, 'Evidence coverage: None');
});

test('difficulty maps to demand words', () => {
  assert.equal(UI.difficultyLabel(0.9), 'Very demanding');
  assert.equal(UI.difficultyLabel(0.4), 'Moderate');
  assert.equal(UI.difficultyLabel(null), null);
});

test('source badges always carry a text label, never colour alone', () => {
  assert.match(UI.sourceBadge('EXTERNAL'), /External research/);
  assert.match(UI.sourceBadge('DERIVED'), /StudyOS synthesis/);
  assert.match(UI.sourceBadge('MATERIAL'), /Course material/);
  assert.match(UI.sourceBadge(undefined), /Course material/);
});

test('badges escape their content', () => {
  assert.ok(!UI.masteryBadge('<script>').includes('<script>'));
});

test('friendly errors never leak provider internals', () => {
  assert.equal(UI.friendlyError({ status: 500, detail: 'provider_route_invalid: nvidia model missing' }), 'The AI provider is temporarily unavailable. Try again shortly.');
  assert.equal(UI.friendlyError({ status: 500, detail: 'The request exceeded its time budget' }), 'This took longer than the allowed time. Try again shortly.');
  assert.equal(UI.friendlyError({ status: 500, detail: 'weird internal thing' }, 'fallback text'), 'fallback text');
});
