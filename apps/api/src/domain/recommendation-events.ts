import { createHash } from 'node:crypto';

/**
 * Stage 2 — the durable recommendation event registry.
 *
 * Pure domain logic: no prisma, no model calls. The kind registry is a closed
 * system mechanic — an arbitrary string from a model or a client can never
 * become an event kind. The fold is a deterministic function of the event rows;
 * no AI output participates in derived state.
 *
 * Everything here is domain-open: nothing knows what kinds of things exist.
 * `entityType` never appears — identity is the Stage 1 casefolded pair, and the
 * full identity graph (editions, translations, aliases, external IDs) is later
 * migration work.
 */

/** Closed registry. `shown` is defined but never written in Stage 2: the server
 *  cannot prove the client rendered the cards. */
export const RECOMMENDATION_EVENT_KINDS = [
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
] as const;

export type RecommendationEventKind = (typeof RECOMMENDATION_EVENT_KINDS)[number];

export function isRecommendationEventKind(value: string): value is RecommendationEventKind {
  return (RECOMMENDATION_EVENT_KINDS as readonly string[]).includes(value);
}

/** Payload shape carried on every event. Versioned from day one, always data. */
export interface RecommendationEventPayload {
  schemaVersion: 1;
  /** Why the model recommended the item (recommended events). */
  reason?: string;
  /** The user's correction note (consumption_corrected). */
  note?: string;
}

export const RECOMMENDATION_PAYLOAD_VERSION = 1;

export function buildRecommendationPayload(
  fields: Omit<RecommendationEventPayload, 'schemaVersion'> = {},
): string {
  return JSON.stringify({ schemaVersion: RECOMMENDATION_PAYLOAD_VERSION, ...fields });
}

// ---------------------------------------------------------------- request keys

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Idempotency key for a generation-coupled `recommended` write.
 *
 * Deterministic per (user, goal, item): the database unique index absorbs both
 * a replayed write of the same turn and a later turn that recommends the same
 * item again — the folded facet is unchanged, so no fact is lost.
 */
export function recommendedEventRequestId(parts: {
  userId: string;
  goalId?: string | null;
  identityKey: string;
}): string {
  const hash = sha256(['recommended', parts.userId, parts.goalId ?? '', parts.identityKey].join('|'));
  return `v1|${hash}`;
}

/**
 * Idempotency key for an explicit user mutation.
 *
 * The client generates an `operationId` once per user action and reuses it on
 * retries; the server derives the database key from it, so a request that
 * committed but whose response was lost replays to the SAME key and is
 * absorbed by the unique index. `identityKey` is included so a client that
 * wrongly reuses an operationId across two different items gets two rows
 * rather than one swallowed action.
 */
export function mutationEventRequestId(parts: {
  eventKind: RecommendationEventKind;
  userId: string;
  operationId: string;
  identityKey: string;
}): string {
  const hash = sha256(
    ['mutation', parts.eventKind, parts.userId, parts.operationId, parts.identityKey].join('|'),
  );
  return `v1|${hash}`;
}

// --------------------------------------------------------------------- folding

/** The rows the fold reads — shaped to match the Prisma model's fields. */
export interface RecommendationEventFoldRow {
  identityKey: string;
  eventKind: string;
  seq: number;
}

/**
 * Current state per item, derived by a pure fold.
 *
 * Ordering is `seq` ascending — a monotonic serial, deterministic under
 * concurrency. Within each facet pair the latest event wins; facets the user
 * never touched are false. Unknown kinds (which write validation prevents) are
 * skipped defensively.
 */
export interface RecommendationFacets {
  hasBeenRecommended: boolean;
  hasBeenShown: boolean;
  saved: boolean;
  consumed: boolean;
  excluded: boolean;
  liked: boolean;
  disliked: boolean;
}

const EMPTY_FACETS: RecommendationFacets = {
  hasBeenRecommended: false,
  hasBeenShown: false,
  saved: false,
  consumed: false,
  excluded: false,
  liked: false,
  disliked: false,
};

export function foldRecommendationEvents(
  events: readonly RecommendationEventFoldRow[],
): Map<string, RecommendationFacets> {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  interface PerItem {
    recommended: boolean;
    shown: boolean;
    savedLast: 'saved' | 'unsaved' | null;
    consumedLast: 'consumed' | 'consumption_corrected' | null;
    excludedLast: 'excluded' | 'exclusion_removed' | null;
    stanceLast: 'liked' | 'disliked' | null;
  }

  const byIdentity = new Map<string, PerItem>();
  const itemFor = (identityKey: string): PerItem => {
    let item = byIdentity.get(identityKey);
    if (!item) {
      item = {
        recommended: false,
        shown: false,
        savedLast: null,
        consumedLast: null,
        excludedLast: null,
        stanceLast: null,
      };
      byIdentity.set(identityKey, item);
    }
    return item;
  };

  for (const event of ordered) {
    const item = itemFor(event.identityKey);
    switch (event.eventKind) {
      case 'recommended':
        item.recommended = true;
        break;
      case 'shown':
        item.shown = true;
        break;
      case 'saved':
      case 'unsaved':
        item.savedLast = event.eventKind as 'saved' | 'unsaved';
        break;
      case 'consumed':
      case 'consumption_corrected':
        item.consumedLast = event.eventKind as 'consumed' | 'consumption_corrected';
        break;
      case 'excluded':
      case 'exclusion_removed':
        item.excludedLast = event.eventKind as 'excluded' | 'exclusion_removed';
        break;
      case 'liked':
      case 'disliked':
        item.stanceLast = event.eventKind as 'liked' | 'disliked';
        break;
      default:
        // `preference_corrected` and anything unregistered affect no facet.
        break;
    }
  }

  const folded = new Map<string, RecommendationFacets>();
  for (const [identityKey, item] of byIdentity) {
    folded.set(identityKey, {
      hasBeenRecommended: item.recommended,
      hasBeenShown: item.shown,
      saved: item.savedLast === 'saved',
      consumed: item.consumedLast === 'consumed',
      excluded: item.excludedLast === 'excluded',
      liked: item.stanceLast === 'liked',
      disliked: item.stanceLast === 'disliked',
    });
  }
  return folded;
}

export function emptyFacets(): RecommendationFacets {
  return { ...EMPTY_FACETS };
}
