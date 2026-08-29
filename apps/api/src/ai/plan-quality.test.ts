import { describe, expect, it } from 'vitest';
import {
  GENERIC_TASK_TITLES,
  isGenericTaskTitle,
  meaningfulTokens,
  scorePlanQuality,
} from './plan-quality.js';

// Offline checks for the shared tokeniser and the generic-title rules. Nothing
// here calls a provider.

describe('meaningfulTokens', () => {
  it('stems, lower-cases and drops stopwords', () => {
    expect(meaningfulTokens('Reading the Books')).toEqual(new Set(['read', 'book']));
  });

  it('is the one stemmer shared with the near-duplicate pass', () => {
    // Singular and plural must collide, or near-duplicate titles would compare unfairly.
    expect(meaningfulTokens('Read 25 pages')).toEqual(meaningfulTokens('Read 25 page'));
  });
});

describe('the placeholder title list', () => {
  it('holds the exact phrases the model emits when it has nothing real', () => {
    expect(GENERIC_TASK_TITLES.has('take the first concrete step')).toBe(true);
    expect(GENERIC_TASK_TITLES.has('work on my goal')).toBe(true);
    expect(GENERIC_TASK_TITLES.has('track progress')).toBe(true);
  });
});

describe('isGenericTaskTitle', () => {
  it('flags every exact placeholder phrase, whatever the casing', () => {
    for (const title of ['Take the first concrete step', 'TAKE ACTION', 'Daily Practice']) {
      expect(isGenericTaskTitle(title), title).toBe(true);
    }
  });

  it('never flags a short title that names a concrete action', () => {
    expect(isGenericTaskTitle('Read 25 pages')).toBe(false);
    expect(isGenericTaskTitle('Walk 30 minutes')).toBe(false);
    expect(isGenericTaskTitle('Cook dinner')).toBe(false);
  });

  it('lets a goal-family token make a short title concrete', () => {
    const chessFamily = new Set(['chess', 'tactic', 'opening', 'endgame', 'game']);
    expect(isGenericTaskTitle('Opening tactics', chessFamily)).toBe(false);
    // The same title, with nothing to anchor it to the goal, is generic.
    expect(isGenericTaskTitle('Opening tactics', null)).toBe(true);
  });

  it('treats a longer descriptive title as concrete on its own', () => {
    expect(isGenericTaskTitle('Swim 20 lengths of the local pool')).toBe(false);
  });
});

describe('scorePlanQuality generic handling', () => {
  const task = (title: string) => ({
    title,
    description: '',
    recurrenceType: 'ONCE' as const,
    recurrenceConfig: {},
    estimatedMinutes: 20,
  });

  it('names each generic title without failing a plan that has real ones', () => {
    const quality = scorePlanQuality('I want to get fitter', {
      title: 'Get moving',
      tasks: [task('Take action'), task('Brisk 30 minute walk')],
    });
    expect(quality.issues).toContain('GENERIC_TASKS: "Take action" is too generic to be actionable');
    expect(quality.issues).not.toContain('All task titles are generic placeholders');
    expect(quality.taskSpecificity).toBeGreaterThan(0);
  });

  it('caps the generic-title callouts at three', () => {
    const quality = scorePlanQuality('I want to get fitter', {
      title: 'Get moving',
      tasks: [
        task('Take action'),
        task('Make progress'),
        task('Stay consistent'),
        task('Improve yourself'),
      ],
    });
    const callouts = quality.issues.filter((issue) => issue.startsWith('GENERIC_TASKS:'));
    expect(callouts).toHaveLength(3);
  });

  it('scores a plan made entirely of placeholders at zero specificity', () => {
    const quality = scorePlanQuality('I want to read more', {
      title: 'Read more',
      tasks: [task('Take the first step'), task('Track progress')],
    });
    expect(quality.taskSpecificity).toBe(0);
    expect(quality.issues).toContain('All task titles are generic placeholders');
  });

  it('leaves a plan with no generic titles untouched', () => {
    const quality = scorePlanQuality('I want to read more', {
      title: 'Read more',
      tasks: [task('Read 25 pages'), task('Log one sentence about the chapter')],
    });
    expect(quality.issues.some((issue) => issue.startsWith('GENERIC_TASKS:'))).toBe(false);
    expect(quality.taskSpecificity).toBeGreaterThan(0);
  });
});
