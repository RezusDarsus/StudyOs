import { describe, expect, it } from 'vitest';
import { assessFeasibility } from './feasibility.js';
import { validateAndNormalizeDraft, DraftValidationError } from './draft-validator.js';
import { addDays, todayIn } from '../domain/dates.js';

// The feasibility gate refuses the two unplannable goal shapes: a quantified
// jump in a quality that has no unit, and an outcome with no metric at all.
// Every case below is one of those, or a goal that must pass untouched.

const REFRAME_SNIPPET = 'measurable signal';

const baseDraft = {
  title: 'Creativity Sprint',
  description: 'A sketching routine.',
  category: 'HEALTH' as const,
  targetType: 'HABIT' as const,
  rationale: 'You want a routine you can keep.',
  tasks: [
    {
      title: 'Daily sketch',
      description: '',
      recurrence: { type: 'TIMES_PER_WEEK' as const, timesPerWeek: 3 },
      estimatedMinutes: 20,
      preferredTime: null,
      reason: 'You want to build the habit.',
    },
  ],
};

describe('assessFeasibility', () => {
  it('reframes a quantified quality jump inside a short window', () => {
    const result = assessFeasibility({ goalText: 'I want to become twice as creative in 30 days' });
    expect(result.verdict).toBe('NEEDS_REFRAME');
    expect(result.reason).toContain(REFRAME_SNIPPET);
  });

  it('recognises the other comparative shapes', () => {
    expect(assessFeasibility({ goalText: 'double my charisma in 6 weeks' }).verdict).toBe('NEEDS_REFRAME');
    expect(assessFeasibility({ goalText: 'boost my discipline by 50% in 2 months' }).verdict).toBe('NEEDS_REFRAME');
    expect(assessFeasibility({ goalText: 'make my memory 20% better within 30 days' }).verdict).toBe('NEEDS_REFRAME');
  });

  it('uses the draft deadline as the window when the text states none', () => {
    const soon = assessFeasibility({
      goalText: 'I want to become twice as creative',
      deadline: addDays(todayIn('UTC'), 30),
    });
    expect(soon.verdict).toBe('NEEDS_REFRAME');
    const far = assessFeasibility({
      goalText: 'I want to become twice as creative',
      deadline: addDays(todayIn('UTC'), 200),
    });
    expect(far.verdict).toBe('OK');
  });

  it('allows the same claim with no window or a long one', () => {
    expect(assessFeasibility({ goalText: 'I want to become twice as creative' }).verdict).toBe('OK');
    expect(assessFeasibility({ goalText: 'I want to become twice as creative in 2 years' }).verdict).toBe('OK');
  });

  it('clarifies a vague outcome with no measurable metric', () => {
    const result = assessFeasibility({ goalText: 'I want to get better at piano' });
    expect(result.verdict).toBe('NEEDS_CLARIFICATION');
    expect(result.reason).toContain(REFRAME_SNIPPET);
  });

  it('does not count a deadline number as a metric', () => {
    expect(assessFeasibility({ goalText: 'improve my memory in 30 days' }).verdict).toBe('NEEDS_CLARIFICATION');
    expect(assessFeasibility({ goalText: 'become more confident by December' }).verdict).toBe('NEEDS_CLARIFICATION');
  });

  it('passes a goal with a number outside its deadline phrase', () => {
    expect(assessFeasibility({ goalText: 'improve my 5k time' }).verdict).toBe('OK');
    expect(assessFeasibility({ goalText: 'read 12 books by December' }).verdict).toBe('OK');
  });

  it('passes concrete quantified goals', () => {
    expect(assessFeasibility({ goalText: 'run a 5k in 8 weeks' }).verdict).toBe('OK');
    expect(assessFeasibility({
      goalText: 'I want to lose 5 kg in 8 weeks and train 4 days a week',
    }).verdict).toBe('OK');
    expect(assessFeasibility({ goalText: 'save $5,000 in 10 months' }).verdict).toBe('OK');
  });
});

describe('the feasibility gate in the draft pipeline', () => {
  it('rejects a reframe-shaped draft with the gate reason', () => {
    expect(() =>
      validateAndNormalizeDraft(
        baseDraft,
        'UTC',
        new Date('2026-08-29T10:00:00Z'),
        'I want to become twice as creative in 30 days',
      ),
    ).toThrow(DraftValidationError);
    expect(() =>
      validateAndNormalizeDraft(
        baseDraft,
        'UTC',
        new Date('2026-08-29T10:00:00Z'),
        'I want to become twice as creative in 30 days',
      ),
    ).toThrow(
      'You asked for a measurable jump in "creative", but a quality like that has no number a schedule can track. Decide what measurable signal would show you improved — work produced, sessions completed, hours practiced — and set that as the goal instead.',
    );
  });

  it('rejects a vague draft with the clarification reason', () => {
    expect(() =>
      validateAndNormalizeDraft(
        baseDraft,
        'UTC',
        new Date('2026-08-29T10:00:00Z'),
        'I want to get better at piano',
      ),
    ).toThrow(/measurable outcome/);
  });

  it('accepts a concrete draft unchanged', () => {
    const result = validateAndNormalizeDraft(
      // The stated "in 8 weeks" is parsed as an explicit deadline, so the draft
      // must carry the same date to pass the contract gate.
      { ...baseDraft, deadline: addDays('2026-08-29', 56) },
      'UTC',
      new Date('2026-08-29T10:00:00Z'),
      'I want to run a 5k in 8 weeks',
    );
    expect(result.tasks).toHaveLength(1);
  });
});
