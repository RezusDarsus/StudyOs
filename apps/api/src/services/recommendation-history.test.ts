import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mutationEventRequestId, recommendedEventRequestId } from '../domain/recommendation-events.js';
import { prisma } from '../lib/prisma.js';
import {
  loadGoalHasRecommendations,
  loadKnownIdentities,
  loadRecentRecommendationContext,
  persistRecommendedEvents,
  RecommendationHistoryUnavailableError,
  recordUserAction,
} from './recommendation-history.js';

// The recommendation-history service is exercised with the database stubbed out,
// the same way copilot-draft.test.ts does it. What matters here: bounded
// queries, mode-dependent write behavior, and idempotency arbitrated by the
// database unique index.

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  failCreateMany: null as null | Error,
  failCreate: null as null | Error,
}));

vi.mock('../lib/prisma.js', () => {
  const eventTable = {
    findMany: vi.fn(async (args: { where?: Record<string, unknown>; take?: number }) => {
      const where = (args.where ?? {}) as Record<string, unknown>;
      let rows = [...state.rows];
      if (typeof where.userId === 'string') rows = rows.filter((r) => r.userId === where.userId);
      if (typeof where.goalId === 'string') rows = rows.filter((r) => r.goalId === where.goalId);
      const identityWhere = where.identityKey as string | { in: string[] } | undefined;
      if (typeof identityWhere === 'string') rows = rows.filter((r) => r.identityKey === identityWhere);
      if (identityWhere && typeof identityWhere === 'object' && 'in' in identityWhere) {
        const wanted = new Set<string>(identityWhere.in);
        rows = rows.filter((r) => wanted.has(r.identityKey as string));
      }
      rows.sort((a, b) => (b.seq as number) - (a.seq as number));
      if (typeof args.take === 'number') rows = rows.slice(0, args.take);
      return rows.map((row) => ({ ...row }));
    }),
    findFirst: vi.fn(
      async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const where = (args.where ?? {}) as Record<string, unknown>;
        let rows = [...state.rows];
        if (typeof where.userId === 'string') rows = rows.filter((r) => r.userId === where.userId);
        if (typeof where.goalId === 'string') rows = rows.filter((r) => r.goalId === where.goalId);
        if (typeof where.identityKey === 'string') {
          rows = rows.filter((r) => r.identityKey === where.identityKey);
        }
        rows.sort((a, b) => (b.seq as number) - (a.seq as number));
        return rows[0] ? { ...rows[0] } : null;
      },
    ),
    createMany: vi.fn(async (args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
      if (state.failCreateMany) throw state.failCreateMany;
      for (const data of args.data) {
        // skipDuplicates semantics: (userId, requestId) unique.
        const clash = state.rows.some(
          (r) => r.userId === data.userId && r.requestId === data.requestId,
        );
        if (!clash) state.rows.push({ occurredAt: new Date(), ...data, seq: state.rows.length + 1 });
      }
      return { count: args.data.length };
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      if (state.failCreate) throw state.failCreate;
      const data = args.data;
      const clash = state.rows.some(
        (r) => r.userId === data.userId && r.requestId === data.requestId,
      );
      if (clash) {
        const err = new Error('Unique constraint failed on the fields: (`userId`,`requestId`)');
        (err as { code?: string }).code = 'P2002';
        throw err;
      }
      const row = {
        id: `event_${state.rows.length + 1}`,
        occurredAt: new Date(),
        ...data,
        seq: state.rows.length + 1,
      };
      state.rows.push(row);
      return row;
    }),
    findUnique: vi.fn(async (args: { where: { userId_requestId: { userId: string; requestId: string } } }) => {
      const key = args.where.userId_requestId;
      return (
        state.rows.find((r) => r.userId === key.userId && r.requestId === key.requestId) ?? null
      );
    }),
  };
  return {
    prisma: {
      recommendationEvent: eventTable,
      $transaction: vi.fn(
        async <T,>(fn: (tx: { recommendationEvent: typeof eventTable }) => Promise<T>): Promise<T> =>
          fn({ recommendationEvent: eventTable }),
      ),
    },
  };
});

const events = (prisma as unknown as { recommendationEvent: Record<string, Mock> }).recommendationEvent;

const item = {
  entityType: 'pottery_class',
  displayName: 'Wheel Throwing for Beginners',
  attribution: 'Clay House Studio',
  reason: 'Close by.',
};

const env = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(() => {
  state.rows = [];
  state.failCreateMany = null;
  state.failCreate = null;
  vi.clearAllMocks();
});

describe('loadRecentRecommendationContext (bounded)', () => {
  it('returns the latest event per identity, newest first', async () => {
    state.rows = [
      { userId: 'u1', identityKey: 'old|a', entityType: 'x', displayName: 'Old', attribution: 'a', seq: 1 },
      { userId: 'u1', identityKey: 'mid|b', entityType: 'x', displayName: 'Mid', attribution: null, seq: 2 },
      { userId: 'u1', identityKey: 'old|a', entityType: 'x', displayName: 'Old Again', attribution: 'a', seq: 3 },
      { userId: 'u1', identityKey: 'new|c', entityType: 'x', displayName: 'New', attribution: null, seq: 4 },
    ];
    const context = await loadRecentRecommendationContext('u1');
    expect(context.map((i) => i.displayName)).toEqual(['New', 'Old Again', 'Mid']);
  });

  it('caps the identity count at 12', async () => {
    state.rows = Array.from({ length: 30 }, (_, i) => ({
      userId: 'u1',
      identityKey: `k${i}|a`,
      entityType: 'x',
      displayName: `Item ${i}`,
      attribution: null,
      seq: i + 1,
    }));
    const context = await loadRecentRecommendationContext('u1');
    expect(context).toHaveLength(12);
    expect(context[0].displayName).toBe('Item 29');
  });

  it('never sees another user', async () => {
    state.rows = [{ userId: 'u2', identityKey: 'k|a', entityType: 'x', displayName: 'X', attribution: null, seq: 1 }];
    expect(await loadRecentRecommendationContext('u1')).toEqual([]);
  });
});

describe('loadGoalHasRecommendations (goal-scoped routing signal)', () => {
  it('is true only when this goal has durable events', async () => {
    state.rows = [
      {
        userId: 'u1',
        goalId: 'g1',
        identityKey: 'a|b',
        entityType: 'x',
        displayName: 'A',
        attribution: null,
        eventKind: 'recommended',
        seq: 1,
      },
    ];
    expect(await loadGoalHasRecommendations('g1')).toBe(true);
    expect(await loadGoalHasRecommendations('g2')).toBe(false);
  });
});

describe('loadKnownIdentities (full-history duplicate check, bounded by candidates)', () => {
  it('finds known candidate keys only', async () => {
    state.rows = [
      { userId: 'u1', identityKey: 'known|a', displayName: 'K', entityType: 'x', attribution: null, seq: 1 },
    ];
    const known = await loadKnownIdentities('u1', ['known|a', 'fresh|b', 'known|a']);
    expect(known.has('known|a')).toBe(true);
    expect(known.has('fresh|b')).toBe(false);
  });

  it('asks the database nothing when there are no candidates', async () => {
    await loadKnownIdentities('u1', []);
    expect(events.findMany).not.toHaveBeenCalled();
  });
});

describe('persistRecommendedEvents (required writes — canonical)', () => {
  it('writes idempotent recommended events on success', async () => {
    const result = await persistRecommendedEvents('u1', 'g1', [item]);
    expect(result.committed).toBe(true);
    expect(events.createMany).toHaveBeenCalledTimes(1);
    const args = events.createMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
      data: Array<Record<string, unknown>>;
    };
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(1);
    const identityKey = 'wheel throwing for beginners|clay house studio';
    expect(args.data[0]).toMatchObject({
      userId: 'u1',
      goalId: 'g1',
      eventKind: 'recommended',
      identityKey,
      requestId: recommendedEventRequestId({ userId: 'u1', goalId: 'g1', identityKey }),
    });
    expect(JSON.parse(String(args.data[0].payload))).toEqual({ schemaVersion: 1, reason: 'Close by.' });
  });

  it('absorbs a replay: the second identical write commits nothing', async () => {
    await persistRecommendedEvents('u1', 'g1', [item]);
    await persistRecommendedEvents('u1', 'g1', [item]);
    expect(state.rows).toHaveLength(1);
  });

  it('throws the typed retryable error when persistence fails', async () => {
    state.failCreateMany = new Error('database down');
    await expect(persistRecommendedEvents('u1', 'g1', [item])).rejects.toMatchObject({
      code: 'RECOMMENDATION_HISTORY_UNAVAILABLE',
    });
    await expect(persistRecommendedEvents('u1', 'g1', [item])).rejects.toBeInstanceOf(
      RecommendationHistoryUnavailableError,
    );
  });

  it('writes nothing for a prose-only turn', async () => {
    const result = await persistRecommendedEvents('u1', 'g1', []);
    expect(result).toEqual({ committed: false, skipped: true });
    expect(events.createMany).not.toHaveBeenCalled();
  });
});

describe('recordUserAction (operationId idempotency)', () => {
  const action = {
    userId: 'u1',
    goalId: 'g1',
    action: 'mark_consumed' as const,
    operationId: '0b9e6c35-f4de-4f99-9b55-39f24b0d1c11',
    item,
  };

  it('commits one event and folds the facets for that identity only', async () => {
    const result = await recordUserAction(action);
    expect(result.replayed).toBe(false);
    expect(result.event).toMatchObject({
      eventKind: 'consumed',
      identityKey: 'wheel throwing for beginners|clay house studio',
      requestId: mutationEventRequestId({
        eventKind: 'consumed',
        userId: 'u1',
        operationId: action.operationId,
        identityKey: 'wheel throwing for beginners|clay house studio',
      }),
    });
    expect(result.facets).toMatchObject({ consumed: true, saved: false });
    expect(state.rows).toHaveLength(1);
  });

  it('replays the same operationId to the same committed row — no duplicate', async () => {
    const first = await recordUserAction(action);
    const second = await recordUserAction(action);
    expect(second.replayed).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(state.rows).toHaveLength(1);
  });

  it('absorbs concurrent identical retries — the unique index lets exactly one commit', async () => {
    // Both transactions read the same (empty) latest state; the second create
    // hits P2002 and resolves to the row the first committed.
    const [a, b] = await Promise.all([
      recordUserAction(action),
      recordUserAction(action).catch(() => null),
    ]);
    expect(state.rows).toHaveLength(1);
    const outcomes = [a, b].filter((r): r is NonNullable<typeof r> => r !== null);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(outcomes[0].event.id).toBe(outcomes[1].event.id);
  });

  it('writes a new row for a later legitimate action with a new operationId', async () => {
    await recordUserAction(action);
    const later = await recordUserAction({ ...action, operationId: '11111111-2222-4333-8444-555555555555' });
    expect(later.replayed).toBe(false);
    expect(state.rows).toHaveLength(2);
    expect(later.facets.consumed).toBe(true);
  });

  it('records a correction as a superseding row and flips the facet', async () => {
    await recordUserAction(action);
    const corrected = await recordUserAction({
      ...action,
      action: 'correct_consumption',
      operationId: '22222222-3333-4444-8555-666666666666',
      note: 'Actually, not yet.',
    });
    expect(corrected.event.eventKind).toBe('consumption_corrected');
    expect(JSON.parse(String(corrected.event.payload))).toEqual({ schemaVersion: 1, note: 'Actually, not yet.' });
    expect(corrected.facets.consumed).toBe(false);
    expect(state.rows).toHaveLength(2);
  });

  it('carries the informational supersession pointer', async () => {
    const first = await recordUserAction(action);
    const corrected = await recordUserAction({
      ...action,
      action: 'correct_consumption',
      operationId: '22222222-3333-4444-8555-666666666666',
    });
    expect((corrected.event as unknown as Record<string, unknown>).supersedesEventId).toBe(first.event.id);
  });

  it('propagates non-idempotency failures', async () => {
    state.failCreate = new Error('connection refused');
    await expect(recordUserAction(action)).rejects.toThrow('connection refused');
  });
});
