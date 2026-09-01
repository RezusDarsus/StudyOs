import { describe, expect, it } from 'vitest';
import {
  buildRecommendationPayload,
  emptyFacets,
  foldRecommendationEvents,
  isRecommendationEventKind,
  mutationEventRequestId,
  RECOMMENDATION_EVENT_KINDS,
  recommendedEventRequestId,
  type RecommendationEventFoldRow,
} from './recommendation-events.js';

// Pure, offline: the registry, the idempotency keys and the fold. Nothing here
// knows what a book is.

const event = (identityKey: string, eventKind: string, seq: number): RecommendationEventFoldRow => ({
  identityKey,
  eventKind,
  seq,
});

describe('event kind registry', () => {
  it('is the closed Stage 2 set', () => {
    expect(RECOMMENDATION_EVENT_KINDS).toEqual([
      'recommended',
      'shown',
      'saved',
      'unsaved',
      'consumed',
      'consumption_corrected',
      'excluded',
      'exclusion_removed',
      'liked',
      'disliked',
      'preference_corrected',
    ]);
  });

  it('accepts registered kinds and rejects everything else', () => {
    for (const kind of RECOMMENDATION_EVENT_KINDS) {
      expect(isRecommendationEventKind(kind)).toBe(true);
    }
    for (const kind of ['RECOMMENDED', 'archived', 'execute_command', '', 'recommended ']) {
      expect(isRecommendationEventKind(kind)).toBe(false);
    }
  });
});

describe('payload builder', () => {
  it('versioned from day one, with optional fields', () => {
    expect(buildRecommendationPayload()).toBe('{"schemaVersion":1}');
    expect(buildRecommendationPayload({ reason: 'Fits the schedule.' })).toBe(
      '{"schemaVersion":1,"reason":"Fits the schedule."}',
    );
    expect(buildRecommendationPayload({ note: 'Actually, not yet.' })).toBe(
      '{"schemaVersion":1,"note":"Actually, not yet."}',
    );
  });
});

describe('recommendedEventRequestId (generation-coupled writes)', () => {
  it('is deterministic for the same parts', () => {
    const a = recommendedEventRequestId({ userId: 'u1', goalId: 'g1', identityKey: 'item|author' });
    const b = recommendedEventRequestId({ userId: 'u1', goalId: 'g1', identityKey: 'item|author' });
    expect(a).toBe(b);
    expect(a.startsWith('v1|')).toBe(true);
  });

  it('differs per user, goal, and item', () => {
    const base = { userId: 'u1', goalId: 'g1', identityKey: 'item|author' };
    const keys = new Set([
      recommendedEventRequestId(base),
      recommendedEventRequestId({ ...base, userId: 'u2' }),
      recommendedEventRequestId({ ...base, goalId: 'g2' }),
      recommendedEventRequestId({ ...base, goalId: null }),
      recommendedEventRequestId({ ...base, identityKey: 'other|author' }),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe('mutationEventRequestId (explicit user actions)', () => {
  const parts = {
    eventKind: 'consumed' as const,
    userId: 'u1',
    operationId: '0b9e6c35-f4de-4f99-9b55-39f24b0d1c11',
    identityKey: 'item|author',
  };

  it('is stable across recomputation — a retried request derives the same key', () => {
    expect(mutationEventRequestId(parts)).toBe(mutationEventRequestId({ ...parts }));
    expect(mutationEventRequestId(parts).startsWith('v1|')).toBe(true);
  });

  it('differs per operationId — a later legitimate action is a new row, not a replay', () => {
    expect(mutationEventRequestId(parts)).not.toBe(
      mutationEventRequestId({ ...parts, operationId: '11111111-2222-4333-8444-555555555555' }),
    );
  });

  it('differs per kind, user and item — an operationId reused across items is not a false replay', () => {
    const keys = new Set([
      mutationEventRequestId(parts),
      mutationEventRequestId({ ...parts, eventKind: 'consumption_corrected' }),
      mutationEventRequestId({ ...parts, userId: 'u2' }),
      mutationEventRequestId({ ...parts, identityKey: 'other|author' }),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe('foldRecommendationEvents', () => {
  it('returns an empty map for no events', () => {
    expect(foldRecommendationEvents([]).size).toBe(0);
  });

  it('marks recommendation and shows facets independently of pairs', () => {
    const folded = foldRecommendationEvents([event('a', 'recommended', 1), event('a', 'shown', 2)]);
    expect(folded.get('a')).toEqual({
      hasBeenRecommended: true,
      hasBeenShown: true,
      saved: false,
      consumed: false,
      excluded: false,
      liked: false,
      disliked: false,
    });
  });

  it('save → unsaved flips the facet; the later event wins', () => {
    const folded = foldRecommendationEvents([event('a', 'saved', 1), event('a', 'unsaved', 2)]);
    expect(folded.get('a')?.saved).toBe(false);
    const reSaved = foldRecommendationEvents([event('a', 'saved', 1), event('a', 'unsaved', 2), event('a', 'saved', 3)]);
    expect(reSaved.get('a')?.saved).toBe(true);
  });

  it('excluded → exclusion_removed flips the facet', () => {
    const folded = foldRecommendationEvents([event('a', 'excluded', 1), event('a', 'exclusion_removed', 2)]);
    expect(folded.get('a')?.excluded).toBe(false);
    expect(foldRecommendationEvents([event('a', 'excluded', 1)]).get('a')?.excluded).toBe(true);
  });

  it('consumed → consumption_corrected flips the facet, and re-consumption re-asserts it', () => {
    const corrected = foldRecommendationEvents([event('a', 'consumed', 1), event('a', 'consumption_corrected', 2)]);
    expect(corrected.get('a')?.consumed).toBe(false);
    const again = foldRecommendationEvents([
      event('a', 'consumed', 1),
      event('a', 'consumption_corrected', 2),
      event('a', 'consumed', 3),
    ]);
    expect(again.get('a')?.consumed).toBe(true);
  });

  it('liked and disliked share one stance slot — the latest wins', () => {
    const disliked = foldRecommendationEvents([event('a', 'liked', 1), event('a', 'disliked', 2)]);
    expect(disliked.get('a')).toMatchObject({ liked: false, disliked: true });
    const liked = foldRecommendationEvents([event('a', 'liked', 1), event('a', 'disliked', 2), event('a', 'liked', 3)]);
    expect(liked.get('a')).toMatchObject({ liked: true, disliked: false });
  });

  it('preference_corrected affects no facet', () => {
    const folded = foldRecommendationEvents([event('a', 'preference_corrected', 1)]);
    expect(folded.get('a')).toEqual(emptyFacets());
  });

  it('is deterministic regardless of input order — seq is the authority', () => {
    const forward = [event('a', 'saved', 1), event('a', 'unsaved', 2), event('b', 'recommended', 3)];
    const shuffled = [event('b', 'recommended', 3), event('a', 'unsaved', 2), event('a', 'saved', 1)];
    expect(foldRecommendationEvents(forward)).toEqual(foldRecommendationEvents(shuffled));
    expect(foldRecommendationEvents(shuffled).get('a')?.saved).toBe(false);
  });

  it('keeps identities independent of each other', () => {
    const folded = foldRecommendationEvents([event('a', 'saved', 1), event('b', 'recommended', 2)]);
    expect(folded.get('a')).toMatchObject({ saved: true, hasBeenRecommended: false });
    expect(folded.get('b')).toMatchObject({ saved: false, hasBeenRecommended: true });
  });

  it('skips unregistered kinds defensively instead of throwing', () => {
    const folded = foldRecommendationEvents([event('a', 'something_unregistered', 1), event('a', 'saved', 2)]);
    expect(folded.get('a')?.saved).toBe(true);
  });
});
