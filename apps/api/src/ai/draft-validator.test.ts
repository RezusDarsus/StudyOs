import { describe, expect, it } from 'vitest';
import { DraftValidationError, validateAndNormalizeDraft } from './draft-validator.js';
import type { GoalDraftInput } from './schemas.js';

// Colocated gates for the two deterministic semantics of the draft pipeline:
// goal-coverage rejection and approval-gated build-ups. The wider behavioral
// suite lives in copilot.test.ts; these pin the two gates themselves.

type DraftTask = GoalDraftInput['tasks'][number];

const draft = (tasks: DraftTask[]) => ({
  title: 'Backend Interview Prep',
  description: 'Interview preparation routine.',
  category: 'CAREER' as const,
  targetType: 'HABIT' as const,
  rationale: 'You want to be ready for interviews.',
  tasks,
});

const task = (overrides: Partial<DraftTask> = {}): DraftTask => ({
  title: 'Study data structures',
  description: '',
  recurrence: { type: 'TIMES_PER_WEEK' as const, timesPerWeek: 3 },
  estimatedMinutes: 30,
  preferredTime: null,
  reason: 'You want steady practice.',
  ...overrides,
});

const laddered = (sourceText: string, timesPerWeek: number, targets: number[]) =>
  validateAndNormalizeDraft(
    draft([task({
      recurrence: { type: 'TIMES_PER_WEEK' as const, timesPerWeek },
      estimatedMinutes: 15,
      progression: {
        metricType: 'MINUTES' as const,
        unitLabel: 'min',
        stages: targets.map((target) => ({ target, minDays: 7 })),
      },
    })]),
    'UTC',
    new Date('2026-08-25T10:00:00Z'),
    sourceText,
  );

describe('goal-coverage gate', () => {
  const uncoveredDraft = () => draft([task({
    title: 'Review core Java concepts',
    description: 'Read one chapter.',
    reason: 'You want steady review.',
  })]);

  it('rejects a plan that ignores the goal its request names', () => {
    expect(() =>
      validateAndNormalizeDraft(uncoveredDraft(), 'UTC', new Date('2026-08-25T10:00:00Z'), 'Prepare for backend interviews.'),
    ).toThrow(DraftValidationError);
  });

  it('names every missing stem in the rejection', () => {
    expect(() =>
      validateAndNormalizeDraft(uncoveredDraft(), 'UTC', new Date('2026-08-25T10:00:00Z'), 'Prepare for backend interviews.'),
    ).toThrow('The plan does not pursue the stated goal: no task covers "backend", "interview". Keep the goal\'s core activities in the plan.');
  });

  it('accepts a plan that pursues the stated goal', () => {
    const result = validateAndNormalizeDraft(
      draft([task({
        title: 'Backend interview practice',
        description: 'Drill algorithms and system design.',
        reason: 'You are preparing for backend interviews.',
      })]),
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Prepare for backend interviews.',
    );
    expect(result.tasks).toHaveLength(1);
  });

  it('rejects a plan that drops one of two explicitly requested activities', () => {
    const boxingOnly = draft([task({
      title: 'Boxing session',
      description: 'Practice boxing fundamentals.',
      reason: 'You asked to start boxing.',
    })]);
    expect(() =>
      validateAndNormalizeDraft(
        boxingOnly,
        'UTC',
        new Date('2026-08-25T10:00:00Z'),
        'I want lose weight; I will start boxing and gym',
      ),
    ).toThrow('The plan omits explicitly requested activities: "gym"');
  });

});

describe('authority-gated build-ups', () => {
  it('marks a step-up that would exceed a filled cap as requiring approval', () => {
    const result = laddered('Walk at most two times per week.', 2, [15, 30]);
    expect(result.tasks[0].progression?.requiresApproval).toBe(true);
    expect(result.tasks[0].reason.endsWith('This step-up starts only after you approve it.')).toBe(true);
    expect(result.adjustments.join(' ')).toMatch(/requiring approval/);
  });

  it('leaves a build-up alone while the plan stays inside the stated cap', () => {
    const result = laddered('Walk at most five times per week.', 2, [15, 30]);
    expect(result.tasks[0].progression?.requiresApproval).toBe(false);
    expect(result.tasks[0].reason).not.toMatch(/approve it/);
  });

  it('never flags a build-up when the user stated no weekly cap', () => {
    const result = validateAndNormalizeDraft(
      draft([task({ estimatedMinutes: 15, progression: {
        metricType: 'MINUTES' as const,
        unitLabel: 'min',
        stages: [{ target: 15, minDays: 7 }, { target: 30, minDays: 7 }],
      } })]),
      'UTC',
    );
    expect(result.tasks[0].progression?.requiresApproval).toBe(false);
  });
});
