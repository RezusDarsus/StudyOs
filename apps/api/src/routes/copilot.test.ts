import { describe, expect, it, vi } from 'vitest';
import {
  buildAssumptions,
  goalCopilotHistorySchema,
  routeNewSessionRequest,
  toUserFacing,
} from './copilot.js';
import {
  applyMemoryHints,
  applyModelExtraction,
  createContext,
  putEntry,
  recordAnswer,
  serializeContext,
} from '../ai/context.js';
import type { CopilotIntentResult } from '../ai/intent-router.js';
import type { PlanReadiness } from '../ai/requirements/coverage.js';
import { RecommendationValidationError } from '../services/copilot-recommendations.js';
import { RecommendationHistoryUnavailableError } from '../services/recommendation-history.js';
import { HttpError } from '../lib/errors.js';

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

describe('routeNewSessionRequest', () => {
  const fallbackThatMustNotRun = async (): Promise<CopilotIntentResult | null> => {
    throw new Error('the deterministic layer already had a verdict');
  };

  it('proceeds exactly as before for a high-confidence goal statement', async () => {
    for (const goal of [
      'I want to get fitter',
      'Save $3,000 for a trip to Italy',
      'I want lose weight; I will start boxing and gym',
    ]) {
      await expect(routeNewSessionRequest(goal, undefined, fallbackThatMustNotRun)).resolves.toEqual({
        create: true,
      });
    }
  });

  it('refuses to start an interview for a product question, with the clarification', async () => {
    const routed = await routeNewSessionRequest(
      'What happens if I miss a day?',
      undefined,
      fallbackThatMustNotRun,
    );
    expect(routed).toEqual({
      create: false,
      intent: 'PRODUCT_HELP',
      clarification: 'Do you want me to create a goal for this, or are you asking a question?',
    });
  });

  it('consults the LLM fallback only when the rules are silent', async () => {
    const fallback = vi.fn(async () => ({ intent: 'CREATE_GOAL' as const, confidence: 0.88, method: 'llm' as const }));
    await expect(routeNewSessionRequest('blue apple', undefined, fallback)).resolves.toEqual({
      create: true,
    });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('stays unrouted when the fallback fails — never defaulting to CREATE_GOAL', async () => {
    const routed = await routeNewSessionRequest('blue apple', undefined, async () => null);
    expect(routed).toMatchObject({ create: false, intent: 'UNKNOWN' });
  });

  it('lets an explicit intentAnswer goal override everything', async () => {
    const fallback = vi.fn(async () => ({ intent: 'PRODUCT_HELP' as const, confidence: 0.99, method: 'llm' as const }));
    await expect(routeNewSessionRequest('What happens if I miss a day?', 'goal', fallback)).resolves.toEqual({
      create: true,
    });
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('goalCopilotHistorySchema (Stage 1 structured history)', () => {
  it('parses a pre-Stage-1 payload with no recommendations field', () => {
    const parsed = goalCopilotHistorySchema.parse([
      { role: 'user', content: 'which book u can suggest' },
      { role: 'assistant', content: 'Try "The Example" by John Smith.' },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].recommendations).toBeUndefined();
  });

  it('accepts and normalizes mirrored structured recommendations', () => {
    const parsed = goalCopilotHistorySchema.parse([
      {
        role: 'assistant',
        content: 'A class that fits your schedule.',
        recommendations: [
          {
            entityType: 'Pottery_Class',
            displayName: '  Wheel Throwing for Beginners  ',
            attribution: 'Clay House Studio',
          },
        ],
      },
    ]);
    expect(parsed[0].recommendations?.[0]).toMatchObject({
      entityType: 'pottery_class',
      displayName: 'Wheel Throwing for Beginners',
    });
  });

  it('rejects malformed items and oversized arrays', () => {
    expect(() =>
      goalCopilotHistorySchema.parse([{ role: 'assistant', content: 'x', recommendations: [{ entityType: 'x' }] }]),
    ).toThrow();
    expect(() =>
      goalCopilotHistorySchema.parse(
        Array.from({ length: 9 }, (_, i) => ({ role: 'user' as const, content: `m${i}` })),
      ),
    ).toThrow();
  });
});

describe('toUserFacing (Stage 1 typed recommendation failure)', () => {
  it('maps RecommendationValidationError to a retryable 503 RECOMMENDATIONS_INVALID', () => {
    let mapped: unknown;
    try {
      toUserFacing(new RecommendationValidationError(['every item repeated']));
    } catch (err) {
      mapped = err;
    }
    expect(mapped).toBeInstanceOf(HttpError);
    const httpError = mapped as HttpError;
    expect(httpError.statusCode).toBe(503);
    expect(httpError.code).toBe('RECOMMENDATIONS_INVALID');
    expect(httpError.message).toMatch(/Try again/);
  });

  it('maps RecommendationHistoryUnavailableError to a retryable 503 (Stage 2, required writes)', () => {
    let mapped: unknown;
    try {
      toUserFacing(new RecommendationHistoryUnavailableError(new Error('database down')));
    } catch (err) {
      mapped = err;
    }
    expect(mapped).toBeInstanceOf(HttpError);
    const httpError = mapped as HttpError;
    expect(httpError.statusCode).toBe(503);
    expect(httpError.code).toBe('RECOMMENDATION_HISTORY_UNAVAILABLE');
    expect(httpError.message).toMatch(/Try again/);
  });
});
