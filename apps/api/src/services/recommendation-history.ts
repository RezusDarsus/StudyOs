import type { Prisma } from '@prisma/client';
import {
  buildRecommendationPayload,
  foldRecommendationEvents,
  isRecommendationEventKind,
  mutationEventRequestId,
  recommendedEventRequestId,
  type RecommendationEventFoldRow,
  type RecommendationEventKind,
  type RecommendationFacets,
} from '../domain/recommendation-events.js';
import { prisma } from '../lib/prisma.js';
import { recommendationIdentity, type StructuredRecommendation } from './copilot-recommendations.js';

/**
 * Stage 2 — durable recommendation history: bounded reads, idempotent writes.
 *
 * Every query here is bounded. Nothing loads or folds a user's whole event
 * history per recommendation request: prompt context is a capped recent window,
 * duplicate rejection looks up only the candidate identity keys the model just
 * proposed (the `@@index([userId, identityKey])` index makes that a full-history
 * check for those items without scanning anything), and mutations read a single
 * identity.
 *
 * The client never supplies an identity key, an event kind, or a request id.
 * Identity is recomputed server-side from the validated entity fields; kinds
 * come from the closed registry; request ids are derived (section 4 of the
 * Stage 2 spec). The database unique index on (userId, requestId) is the final
 * idempotency guarantee — application checks are optimizations.
 */

export interface RecentRecommendationContextItem {
  entityType: string;
  displayName: string;
  attribution?: string;
  identityKey: string;
}

/** Thrown when persistence fails. Typed and retryable. */
export class RecommendationHistoryUnavailableError extends Error {
  readonly code = 'RECOMMENDATION_HISTORY_UNAVAILABLE' as const;
  constructor(cause: unknown) {
    super('Durable recommendation history could not be written just now. Try again.');
    this.name = 'RecommendationHistoryUnavailableError';
    this.cause = cause;
  }
}

// ------------------------------------------------------------------- bounded reads

/**
 * The most recent recommendation context for the prompt block: the latest event
 * per identity, newest first, capped. Bounded twice — a hard row fetch limit
 * and a hard identity count — so cost does not grow with history length.
 */
export async function loadRecentRecommendationContext(
  userId: string,
  opts: { fetchLimit?: number; identities?: number } = {},
): Promise<RecentRecommendationContextItem[]> {
  const fetchLimit = opts.fetchLimit ?? 256;
  const identityCap = opts.identities ?? 12;
  const rows = await prisma.recommendationEvent.findMany({
    where: { userId },
    orderBy: { seq: 'desc' },
    take: fetchLimit,
    select: { entityType: true, displayName: true, attribution: true, identityKey: true },
  });
  const seen = new Set<string>();
  const items: RecentRecommendationContextItem[] = [];
  for (const row of rows) {
    if (seen.has(row.identityKey)) continue;
    seen.add(row.identityKey);
    items.push({
      entityType: row.entityType,
      displayName: row.displayName,
      attribution: row.attribution ?? undefined,
      identityKey: row.identityKey,
    });
    if (items.length >= identityCap) break;
  }
  return items;
}

/** Goal-scoped routing signal: does this goal have any durable recommendation context? */
export async function loadGoalHasRecommendations(goalId: string): Promise<boolean> {
  const row = await prisma.recommendationEvent.findFirst({
    where: { goalId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Which of the candidate identity keys already have durable history. This is
 * the full-history duplicate check: an event from any point in the past rejects
 * its item, without ever loading history.
 */
export async function loadKnownIdentities(userId: string, candidateKeys: readonly string[]): Promise<Set<string>> {
  const uniqueKeys = [...new Set(candidateKeys)];
  if (uniqueKeys.length === 0) return new Set();
  const rows = await prisma.recommendationEvent.findMany({
    where: { userId, identityKey: { in: uniqueKeys } },
    select: { identityKey: true },
    distinct: ['identityKey'],
  });
  return new Set(rows.map((row) => row.identityKey));
}

// ----------------------------------------------------------- generation-coupled writes

export interface PersistResult {
  /** True when the events were committed (or had already been committed). */
  committed: boolean;
  /** True when the write mode made persistence someone else's problem. */
  skipped: boolean;
}

/**
 * Persist the validated recommendations of one structured ADVICE turn as
 * `recommended` events.
 *
 * Stage 6 canonical: writes are always "required" — part of the request. A
 * persistence failure is the typed retryable 503, never a silently forgotten
 * answer. Idempotent by construction: one deterministic request id per
 * (user, goal, item), and `skipDuplicates` lets the database absorb a replay.
 */
export async function persistRecommendedEvents(
  userId: string,
  goalId: string | null,
  items: readonly StructuredRecommendation[],
): Promise<PersistResult> {
  // Stage 6 canonical: writes are "required" — part of the request. A
  // persistence failure is the typed retryable 503, never a silently
  // forgotten answer.
  if (items.length === 0) {
    return { committed: false, skipped: true };
  }
  const data = items.map((item) => {
    const identityKey = recommendationIdentity(item);
    return {
      userId,
      goalId,
      entityType: item.entityType,
      displayName: item.displayName,
      attribution: item.attribution ?? null,
      identityKey,
      eventKind: 'recommended' satisfies RecommendationEventKind,
      requestId: recommendedEventRequestId({ userId, goalId, identityKey }),
      payload: buildRecommendationPayload({ reason: item.reason ?? undefined }),
    };
  });
  try {
    await prisma.recommendationEvent.createMany({ data, skipDuplicates: true });
    return { committed: true, skipped: false };
  } catch (err) {
    throw new RecommendationHistoryUnavailableError(err);
  }
}

// ----------------------------------------------------------------- user mutations

/** The Stage 2 mutation surface: exactly two explicit, registered actions. */
export const RECOMMENDATION_MUTATION_ACTIONS = {
  mark_consumed: 'consumed',
  correct_consumption: 'consumption_corrected',
} as const;

export type RecommendationMutationAction = keyof typeof RECOMMENDATION_MUTATION_ACTIONS;

export interface RecordedMutation {
  event: {
    id: string;
    eventKind: string;
    entityType: string;
    displayName: string;
    attribution: string | null;
    identityKey: string;
    requestId: string;
    payload: string;
    occurredAt: Date;
  };
  facets: RecommendationFacets;
  replayed: boolean;
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

/**
 * Record one explicit user action on one recommended item.
 *
 * The operation id comes from the client — generated once per user action and
 * reused on retries — but the database request id is derived here, and the
 * unique index absorbs a replay: a request that committed but whose response
 * was lost replays to the same key and returns the existing event with
 * `replayed: true`. A later legitimate action uses a new operation id and
 * writes a new row.
 */
export async function recordUserAction(
  input: {
    userId: string;
    goalId?: string | null;
    action: RecommendationMutationAction;
    operationId: string;
    item: StructuredRecommendation;
    note?: string;
  },
  client?: Prisma.TransactionClient,
): Promise<RecordedMutation> {
  const eventKind = RECOMMENDATION_MUTATION_ACTIONS[input.action];
  if (!isRecommendationEventKind(eventKind)) {
    // Unreachable while the action table maps into the registry; kept as the
    // registry's own guard.
    throw new Error(`Unregistered recommendation event kind: ${eventKind}`);
  }
  const identityKey = recommendationIdentity(input.item);
  const requestId = mutationEventRequestId({
    eventKind,
    userId: input.userId,
    operationId: input.operationId,
    identityKey,
  });
  const payload =
    input.action === 'correct_consumption'
      ? buildRecommendationPayload({ note: input.note })
      : buildRecommendationPayload();

  // Stage 4: when the capability executor supplies a transaction client, the
  // claim/write/replay-read all run on it (single transaction with the
  // idempotency claim). Without one, the Stage 2 behavior is unchanged: this
  // function owns its own transaction.
  const runOn = async (tx: Prisma.TransactionClient): Promise<RecommendationEventRow> => {
    // Informational only — the fold orders by seq, never by this pointer.
    const latest = await tx.recommendationEvent.findFirst({
      where: { userId: input.userId, identityKey },
      orderBy: { seq: 'desc' },
      select: { id: true },
    });
    return await tx.recommendationEvent.create({
      data: {
        userId: input.userId,
        goalId: input.goalId ?? null,
        entityType: input.item.entityType,
        displayName: input.item.displayName,
        attribution: input.item.attribution ?? null,
        identityKey,
        eventKind,
        requestId,
        payload,
        supersedesEventId: latest?.id ?? null,
      },
    });
  };

  let created: RecommendationEventRow;
  try {
    created = client
      ? await runOn(client)
      : await prisma.$transaction(async (tx) => runOn(tx));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A replay: the same logical action already committed. Return it as the
    // success it is — one row, no duplicate.
    const existing = await (client ?? prisma).recommendationEvent.findUnique({
      where: { userId_requestId: { userId: input.userId, requestId } },
    });
    if (!existing) throw err;
    return toMutationResult(existing, input.userId, true, client);
  }
  return toMutationResult(created, input.userId, false, client);
}

interface RecommendationEventRow {
  id: string;
  eventKind: string;
  entityType: string;
  displayName: string;
  attribution: string | null;
  identityKey: string;
  requestId: string;
  payload: string;
  occurredAt: Date;
}

async function toMutationResult(
  row: RecommendationEventRow,
  userId: string,
  replayed: boolean,
  client?: Prisma.TransactionClient,
): Promise<RecordedMutation> {
  // The fold must read on the caller's transaction when one is supplied: under
  // the capability executor the row was just written inside a still-open
  // transaction, and reading on the global client would not see it yet.
  return { event: { ...row }, facets: await foldedFacetsFor(userId, row.identityKey, client), replayed };
}

/** Folded facets for one identity — the only fold a mutation response runs. */
async function foldedFacetsFor(
  userId: string,
  identityKey: string,
  client?: Prisma.TransactionClient,
): Promise<RecommendationFacets> {
  const rows = await loadEventRowsForIdentity(userId, identityKey, client);
  const folded = foldRecommendationEvents(rows);
  return folded.get(identityKey) ?? {
    hasBeenRecommended: false,
    hasBeenShown: false,
    saved: false,
    consumed: false,
    excluded: false,
    liked: false,
    disliked: false,
  };
}

async function loadEventRowsForIdentity(
  userId: string,
  identityKey: string,
  client?: Prisma.TransactionClient,
): Promise<RecommendationEventFoldRow[]> {
  const rows = await (client ?? prisma).recommendationEvent.findMany({
    where: { userId, identityKey },
    orderBy: { seq: 'asc' },
    select: { identityKey: true, eventKind: true, seq: true },
  });
  return rows;
}
