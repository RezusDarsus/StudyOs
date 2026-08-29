import { describe, expect, it } from 'vitest';
import { buildAssumptions } from './copilot.js';
import {
  applyMemoryHints,
  applyModelExtraction,
  createContext,
  putEntry,
  recordAnswer,
  serializeContext,
} from '../ai/context.js';
import type { PlanReadiness } from '../ai/readiness.js';

// These run entirely offline: the helper is pure, so no route or provider is
// exercised — only what it is told to read.

const ready: PlanReadiness = { ready: true, missing: [], confidence: 1 };
const notReady: PlanReadiness = {
  ready: false,
  missing: ['DESIRED_OUTCOME', 'WEEKLY_CAPACITY', 'TIMEFRAME', 'BASELINE', 'CONSTRAINTS', 'PREFERENCES'],
  confidence: 0,
};

const sessionWith = (build: (context: ReturnType<typeof createContext>) => void) => {
  const context = createContext('save money');
  build(context);
  return { structuredContext: serializeContext(context), initialGoalText: 'save money', status: 'DRAFT_GENERATED' };
};

describe('buildAssumptions', () => {
  it('surfaces inference-tier context as assumed, and only that tier', () => {
    const session = sessionWith((context) => {
      // A literal answer: the user said this. Never an assumption.
      recordAnswer(context, { key: 'days_per_week', questionId: 'q1', value: 4 });
      // A session inference: the model guessed it from the conversation.
      applyModelExtraction(context, { preferred_time_of_day: 'evening' }, []);
      // Long-term memory: old, but also something they once actually said.
      applyMemoryHints(context, [{ key: 'liked_activities', value: 'walking' }]);
    });
    const assumptions = buildAssumptions({ deadline: '2026-12-31' }, session, ready);
    expect(assumptions).toEqual([
      "preferred_time_of_day: evening (assumed — you didn't state this)",
    ]);
  });

  it('renders model-inference values and skips empty and object values', () => {
    const session = sessionWith((context) => {
      putEntry(context, 'plan_style', { value: { detailed: true }, source: 'CURRENT_SESSION_INFERENCE' });
      putEntry(context, 'constraints', { value: '', source: 'MODEL_INFERENCE' });
      putEntry(context, 'experience', { value: 'beginner', source: 'MODEL_INFERENCE' });
    });
    const assumptions = buildAssumptions({ deadline: null }, session, null);
    expect(assumptions).toEqual([
      "experience: beginner (assumed — you didn't state this)",
      'No deadline was provided, so this plan focuses on steady weekly progress.',
    ]);
  });

  it('caps the inferred list at six entries', () => {
    const session = sessionWith((context) => {
      for (let index = 0; index < 9; index++) {
        putEntry(context, `inferred_key_${index}`, {
          value: `value ${index}`,
          source: 'CURRENT_SESSION_INFERENCE',
        });
      }
    });
    const assumed = buildAssumptions({ deadline: '2026-12-31' }, session, null).filter((line) =>
      line.includes('(assumed'),
    );
    expect(assumed).toHaveLength(6);
  });

  it('says the plan rests on limited information when the gate refused', () => {
    const assumptions = buildAssumptions(
      { deadline: '2026-12-31' },
      sessionWith(() => {}),
      notReady,
    );
    expect(assumptions).toEqual([
      'Generated with limited information — the plan uses only what you told me.',
    ]);
  });

  it('collects the deadline note alongside the inference lines', () => {
    const session = sessionWith((context) => {
      applyModelExtraction(context, { preferred_time_of_day: 'morning' }, []);
    });
    const assumptions = buildAssumptions({ deadline: null }, session, notReady);
    expect(assumptions).toEqual([
      "preferred_time_of_day: morning (assumed — you didn't state this)",
      'Generated with limited information — the plan uses only what you told me.',
      'No deadline was provided, so this plan focuses on steady weekly progress.',
    ]);
  });

  it('invents nothing when everything relevant was stated and dated', () => {
    const assumptions = buildAssumptions(
      { deadline: '2026-12-31' },
      sessionWith((context) => {
        recordAnswer(context, { key: 'days_per_week', questionId: 'q1', value: 4 });
      }),
      ready,
    );
    expect(assumptions).toEqual([]);
  });

  it('works without a session at all, as a manually created draft does', () => {
    const assumptions = buildAssumptions({ deadline: null }, null, null);
    expect(assumptions).toEqual([
      'No deadline was provided, so this plan focuses on steady weekly progress.',
    ]);
  });
});
