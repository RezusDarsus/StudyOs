import { describe, expect, it } from 'vitest';
import { evaluatePlanReadiness } from './readiness.js';
import { statedTopics } from './interview-plan.js';

// The readiness gate decides when an interview has earned a plan. Every case
// below is one of the two ways it can fail: declaring a vague goal ready (the
// fake-plan failure) or refusing a well-specified one (the endless-questionnaire
// failure).

const evaluate = (input: {
  goalText: string;
  context?: Record<string, unknown>;
  answeredTopics?: Parameters<typeof evaluatePlanReadiness>[0]['answeredTopics'];
  questionCount?: number;
}) =>
  evaluatePlanReadiness({
    goalText: input.goalText,
    context: input.context ?? {},
    answeredTopics: input.answeredTopics ?? [],
    questionCount: input.questionCount ?? 0,
  });

describe('statedTopics', () => {
  it('reads quantity, timeframe and frequency out of the opening message', () => {
    const stated = statedTopics('I want to lose 5 kg in 8 weeks. I can train 4 days a week.');
    expect(stated).toContain('FREQUENCY');
    expect(stated).toContain('TARGET');
  });

  it('finds nothing in a vague goal', () => {
    expect(statedTopics('I want to get fitter')).toEqual([]);
  });
});

describe('the readiness gate', () => {
  it('refuses to call a bare vague wellness phrase ready', () => {
    const result = evaluate({ goalText: 'I want to get fitter' });
    expect(result.ready).toBe(false);
    // Both blocking dimensions the plan would otherwise be invented for.
    expect(result.missing).toContain('DESIRED_OUTCOME');
    expect(result.missing).toContain('WEEKLY_CAPACITY');
    // Blocking dimensions come first in the missing list.
    expect(result.missing[0]).toBe('DESIRED_OUTCOME');
  });

  it('is ready when the opening message states quantity, timeframe and frequency', () => {
    const result = evaluate({
      goalText: 'I want to lose 5 kg in 8 weeks. I can train 4 days a week.',
    });
    expect(result.ready).toBe(true);
    expect(result.missing).not.toContain('DESIRED_OUTCOME');
    expect(result.missing).not.toContain('WEEKLY_CAPACITY');
  });

  it('is ready for a run-length goal with baseline and a stated schedule', () => {
    const result = evaluate({
      goalText:
        'I want to run a 10K in 12 weeks. I currently run 3 km comfortably. I can train Monday, Wednesday, Friday and Sunday, around 45 minutes.',
    });
    expect(result.ready).toBe(true);
  });

  it('lets answered topics lift a learn-a-subject goal to ready', () => {
    const result = evaluate({
      goalText: 'I want to learn Java',
      answeredTopics: ['FREQUENCY', 'TARGET'],
      questionCount: 2,
    });
    expect(result.ready).toBe(true);
    // The named subject is the desired outcome; no question needs to re-ask it.
    expect(result.missing).not.toContain('DESIRED_OUTCOME');
  });

  it('does not let a vague goal shortcut the interview at zero questions', () => {
    const result = evaluate({
      goalText: 'I want to be more productive',
      context: { days_per_week: 3 },
      questionCount: 0,
    });
    // Capacity alone is not a goal: DESIRED_OUTCOME is still missing, and with
    // nothing stated and nothing asked, the interview must continue.
    expect(result.ready).toBe(false);
    expect(result.missing[0]).toBe('DESIRED_OUTCOME');
  });

  it('accepts a recorded context key in place of a stated one', () => {
    const result = evaluate({
      goalText: 'I want to get better at chess',
      context: { desired_outcome: 'Reach a 1500 rating', days_per_week: 3 },
      questionCount: 1,
    });
    expect(result.ready).toBe(true);
  });

  it('ignores context keys whose value is empty', () => {
    const result = evaluate({
      goalText: 'I want to get better at chess',
      context: { desired_outcome: '', days_per_week: null },
      questionCount: 1,
    });
    expect(result.ready).toBe(false);
  });

  it('counts a unit-ful quantity in the goal text as a desired outcome', () => {
    // "40 sessions" is concrete while matching no stated-topic pattern — it is
    // the CONCRETE_QUANTITY signal alone doing the work here.
    const result = evaluate({
      goalText: 'I want to complete 40 sessions',
      context: { frequency: 'weekly' },
      questionCount: 1,
    });
    expect(result.missing).not.toContain('DESIRED_OUTCOME');
    expect(result.ready).toBe(true);
  });

  it('keeps confidence between 0 and 1 and rising as dimensions become known', () => {
    const vague = evaluate({ goalText: 'I want to get fitter' });
    const better = evaluate({
      goalText: 'I want to get fitter',
      context: { days_per_week: 3 },
      questionCount: 1,
    });
    const best = evaluate({
      goalText: 'I want to get fitter',
      context: { desired_outcome: 'run 5 km', days_per_week: 3 },
      questionCount: 1,
    });
    expect(vague.confidence).toBeGreaterThanOrEqual(0);
    expect(vague.confidence).toBeLessThanOrEqual(1);
    expect(better.confidence).toBeGreaterThan(vague.confidence);
    expect(best.confidence).toBeGreaterThan(better.confidence);
  });
});
