import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { recommendationIdentity, useGoalCopilot } from './useGoalCopilot';
import type { GoalCopilotAnswer } from './types';

// The goal-chat hook is driven through the DOM-free surface and asserted on the
// requests it makes: Stage 1's point is that the structured recommendations the
// server returned come back to the server in the mirrored history.

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];

const answerWith = (overrides: Partial<GoalCopilotAnswer['analysis']> = {}): GoalCopilotAnswer => ({
  intent: 'ADVICE',
  summary: {
    goalTitle: 'Read more',
    periodDays: 14,
    eligibleTaskOccurrences: 0,
    completedTaskOccurrences: 0,
    completionRate: 0,
    currentStreak: 0,
    mostMissedTasks: [],
  },
  analysis: {
    explanation: 'A class that fits your schedule.',
    suggestions: [],
    ...overrides,
  },
  progressionProposals: [],
});

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/api/, '');
      calls.push({
        path,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return { ok: true, status: 200, json: async () => answerWith() } as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('useGoalCopilot history mirroring (Stage 1)', () => {
  it('omits the recommendations key entirely when the answer carried none', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useGoalCopilot('goal-1', onError));
    // First turn: a legacy-shaped answer with no recommendations.
    await act(async () => {
      await result.current.ask('Can you recommend a pottery class?');
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    // The very first request has no history at all.
    const first = calls.filter((c) => c.path === `/goals/goal-1/copilot`)[0];
    expect(((first.body as { history: unknown[] }).history)).toEqual([]);
    // Second turn: the mirrored assistant entry carries no recommendations key.
    await act(async () => {
      await result.current.ask('another one');
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    const second = calls.filter((c) => c.path === `/goals/goal-1/copilot`)[1];
    const history = (second.body as { history: Array<Record<string, unknown>> }).history;
    expect(history).toHaveLength(2);
    expect(history[1]).toEqual({ role: 'assistant', content: 'A class that fits your schedule.' });
    expect('recommendations' in history[1]).toBe(false);
  });

  it('mirrors the structured recommendations back into the history payload', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useGoalCopilot('goal-1', onError));
    // First turn: the server responds with a structured recommendation.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = String(url).replace(/^\/api/, '');
        calls.push({
          path,
          method: init.method ?? 'GET',
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        const payload =
          path === `/goals/goal-1/copilot` && calls.filter((c) => c.path === `/goals/goal-1/copilot`).length > 1
            ? answerWith({
                explanation: 'Something different, then.',
                recommendations: [
                  { entityType: 'pottery_class', displayName: 'Hand-Building Basics' },
                ],
              })
            : answerWith({
                recommendations: [
                  {
                    entityType: 'pottery_class',
                    displayName: 'Wheel Throwing for Beginners',
                    attribution: 'Clay House Studio',
                    reason: 'Close by.',
                  },
                ],
              });
        return { ok: true, status: 200, json: async () => payload } as Response;
      }),
    );
    await act(async () => {
      await result.current.ask('Can you recommend a pottery class?');
    });
    await act(async () => {
      await result.current.ask('another one');
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    // The second request's history must carry the first turn's structured item.
    const second = calls.filter((c) => c.path === `/goals/goal-1/copilot`)[1];
    const history = (second.body as { history: Array<Record<string, unknown>> }).history;
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'A class that fits your schedule.' });
    expect(history[1].recommendations).toEqual([
      {
        entityType: 'pottery_class',
        displayName: 'Wheel Throwing for Beginners',
        attribution: 'Clay House Studio',
        reason: 'Close by.',
      },
    ]);
  });

  it('caps the mirrored history at the last four turns', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useGoalCopilot('goal-1', onError));
    // Six asks ("question 0".."question 5"): the sixth mirrors the previous
    // four turns — questions 1..4.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await result.current.ask(`question ${i}`);
      });
    }
    await waitFor(() => expect(result.current.busy).toBe(false));
    const last = calls.filter((c) => c.path === `/goals/goal-1/copilot`).at(-1);
    const history = (last!.body as { history: Array<Record<string, unknown>> }).history;
    expect(history).toHaveLength(8); // 4 turns × (user + assistant)
    expect(history[0]).toMatchObject({ role: 'user', content: 'question 1' });
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'A class that fits your schedule.' });
  });
});

describe('useGoalCopilot markConsumed (Stage 2 durable action)', () => {
  const item = {
    entityType: 'pottery_class',
    displayName: 'Wheel Throwing for Beginners',
    attribution: 'Clay House Studio',
    reason: 'Close by.',
  };

  it('posts one registered action with a client operationId and the structured fields', async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = String(url).replace(/^\/api/, '');
        calls.push({
          path,
          method: init.method ?? 'GET',
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        const payload =
          path === '/recommendations/events'
            ? {
                event: {
                  id: 'event_1',
                  entityType: 'pottery_class',
                  displayName: 'Wheel Throwing for Beginners',
                  attribution: 'Clay House Studio',
                  eventKind: 'consumed',
                  occurredAt: new Date().toISOString(),
                },
                facets: {
                  hasBeenRecommended: false,
                  hasBeenShown: false,
                  saved: false,
                  consumed: true,
                  excluded: false,
                  liked: false,
                  disliked: false,
                },
                replayed: false,
              }
            : answerWith();
        return { ok: true, status: 200, json: async () => payload } as Response;
      }),
    );
    const { result } = renderHook(() => useGoalCopilot('goal-1', onError));
    let action: unknown;
    await act(async () => {
      action = await result.current.markConsumed(item);
    });
    const mutation = calls.find((c) => c.path === '/recommendations/events');
    expect(mutation).toBeDefined();
    expect(mutation!.method).toBe('POST');
    const body = mutation!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      action: 'mark_consumed',
      entityType: 'pottery_class',
      displayName: 'Wheel Throwing for Beginners',
      attribution: 'Clay House Studio',
      goalId: 'goal-1',
    });
    expect(typeof body.operationId).toBe('string');
    expect((body.operationId as string).length).toBeGreaterThanOrEqual(8);
    expect(action).toMatchObject({ replayed: false });
    expect(onError).not.toHaveBeenCalled();
  });

  it('tracks the consumed identity so the card can render its used state', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useGoalCopilot('goal-1', onError));
    expect(result.current.consumedIdentities.size).toBe(0);
    await act(async () => {
      await result.current.markConsumed(item);
    });
    expect(result.current.consumedIdentities.has(recommendationIdentity(item))).toBe(true);
  });

  it('reports failures through the error surface and leaves the state untouched', async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Database down', code: 'RECOMMENDATION_HISTORY_UNAVAILABLE' }),
      })),
    );
    const { result } = renderHook(() => useGoalCopilot('goal-1', onError));
    let action: unknown;
    await act(async () => {
      action = await result.current.markConsumed(item);
    });
    expect(action).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.consumedIdentities.size).toBe(0);
  });
});

describe('recommendationIdentity (web mirror of the server rule)', () => {
  it('ignores case and whitespace and includes attribution', () => {
    expect(recommendationIdentity({ displayName: 'The Example', attribution: 'John Smith' })).toBe(
      recommendationIdentity({ displayName: '  the example ', attribution: ' john smith ' }),
    );
    expect(recommendationIdentity({ displayName: 'The Example' })).not.toBe(
      recommendationIdentity({ displayName: 'The Example', attribution: 'John Smith' }),
    );
  });
});
