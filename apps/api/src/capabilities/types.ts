import type { PrismaClient, Prisma } from '@prisma/client';
import type { z } from 'zod';

/**
 * Stage 4 — the generic capability contract.
 *
 * The model may propose an action, but only application-owned capability code
 * validates, authorizes, confirms, and executes it. The envelope below is
 * deliberately domain-blind: capability-specific payload lives ONLY in the
 * typed `input`, never on the envelope.
 *
 * Trust boundaries, enforced structurally:
 *  - `CapabilityContext` is server-derived (session userId; server-validated
 *    confirmation proof; request correlation) — the request surface carries no
 *    confirmation field and can never mark an action confirmed.
 *  - `authorize` runs on a DbClient before AND inside the transaction; its
 *    verdicts come from database ownership checks, never from model claims.
 *  - `execute` receives the executor's transaction client and must write
 *    through it only (architecture-tested).
 */

/** Clients a capability may read through: preflight uses the plain client,
 *  the in-transaction recheck uses the executor's transaction. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/** The bounded set of Copilot-reachable mutations (Stage 4 scope). */
export const CAPABILITY_NAMES = [
  'goal.confirm_from_draft',
  'goal.apply_ai_edit',
  'goal.apply_manual_edit',
  'recommendation.mark_consumed',
  'recommendation.correct_consumption',
  'progression.propose_from_suggestion',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export function isCapabilityName(value: string): value is CapabilityName {
  return (CAPABILITY_NAMES as readonly string[]).includes(value);
}

export type ConfirmationPolicy = 'none' | 'confirm' | 'confirm_destructive';

/**
 * Server-derived execution context. `confirmed` is set by the route from
 * WHICH authenticated endpoint received the request (a dedicated confirm-style
 * route is itself the server-validated proof of an explicit user action) —
 * never from request body input, and never from the model.
 */
export interface CapabilityContext {
  readonly userId: string;
  readonly confirmed: boolean;
  readonly correlationId: string;
}

/** A canonical, stable application reference. Execution uses ids only. */
export interface EntityRef {
  readonly kind: 'goal' | 'draft' | 'draftTask' | 'task' | 'progressionPlan' | 'recommendation';
  readonly id: string;
}

export interface CapabilityRequest<I> {
  readonly capability: CapabilityName;
  readonly input: I;
  /**
   * Client-generated per user gesture, reused verbatim on retries. Optional
   * only for legacy clients: when absent the executor derives a request-scoped
   * one (no cross-retry replay protection, exactly today's behavior).
   */
  readonly operationId?: string;
}

/** Structured, typed failure. `repairableByModel` is true ONLY for input errors. */
export interface CapabilityFailure {
  readonly code:
    | 'CAPABILITY_UNKNOWN'
    | 'CAPABILITY_INPUT_INVALID'
    | 'CAPABILITY_TARGET_NOT_FOUND'
    | 'CAPABILITY_TARGET_AMBIGUOUS'
    | 'CAPABILITY_FORBIDDEN'
    | 'CAPABILITY_CONFIRMATION_REQUIRED'
    | 'CAPABILITY_STALE'
    | 'CAPABILITY_IDEMPOTENCY_CONFLICT'
    | 'CAPABILITY_EXECUTION_FAILED';
  readonly message: string;
  readonly repairableByModel: boolean;
  readonly requiresUserClarification: boolean;
  readonly details?: Record<string, unknown>;
}

export type CapabilityOutcome<S> =
  | { status: 'succeeded'; result: S; executionId: string }
  | { status: 'replayed'; result: S; executionId: string }
  | { status: 'failed'; error: CapabilityFailure };

/** Model-facing descriptor: names, purpose, argument shapes — never functions. */
export interface CapabilityDescriptor {
  readonly name: CapabilityName;
  readonly purpose: string;
  readonly arguments: string;
  readonly confirmation: ConfirmationPolicy;
}

export interface CapabilityDefinition<I, S, P = undefined> {
  readonly name: CapabilityName;
  readonly inputSchema: z.ZodType<I>;
  readonly confirmation: ConfirmationPolicy;
  /** Every Stage-4 capability is transactional (claim + mutation + finalize in one commit). */
  readonly transactional: true;
  /** Ownership + target resolution. Runs pre-transaction (DbClient fast-fail)
   *  AND inside the transaction (mandatory recheck). */
  authorize(ctx: CapabilityContext, input: I, client: DbClient): Promise<readonly EntityRef[]>;
  /**
   * Outside any DB transaction, after the pre-claim replay check — so a replay
   * never pays for it. May call the model or other network services. Pure-DB
   * capabilities omit it.
   */
  readonly prepare?: (ctx: CapabilityContext, input: I) => Promise<P>;
  /** Business writes through the supplied transaction client ONLY. */
  execute(
    ctx: CapabilityContext,
    input: I,
    refs: readonly EntityRef[],
    tx: Prisma.TransactionClient,
    prepared: P | undefined,
  ): Promise<S>;
  /** Runs after a successful commit. Failures here are logged, never fatal. */
  readonly postCommit?: (ctx: CapabilityContext, input: I, result: S) => Promise<void>;
  /** Model-facing descriptor. */
  readonly describe: { purpose: string; arguments: string };
}
