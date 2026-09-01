import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { CapabilityError, capabilityExecutionFailed, capabilityInputInvalid } from './capability-error.js';
import { capabilityRegistry, type AnyCapabilityDefinition } from './registry.js';
import type {
  CapabilityContext,
  CapabilityFailure,
  CapabilityName,
  CapabilityOutcome,
  CapabilityRequest,
} from './types.js';

/**
 * The generic capability executor — Stage 4's safe-execution pipeline.
 *
 *   schema validation → confirmation gate → pre-claim replay check →
 *   preflight authorize (DbClient) → prepare (no tx; may call the model) →
 *   TRANSACTION: claim → in-tx authorize recheck → business writes via tx →
 *   SUCCEEDED finalize → commit → postCommit hook
 *
 * Core invariant (rev.3): PENDING is never a committed state. The idempotency
 * claim, the business mutation, and the SUCCEEDED finalization commit in ONE
 * transaction, so the database unique index arbitrates concurrent duplicates
 * before any business write. Committed states are: absent, FAILED (post-
 * rollback audit), SUCCEEDED.
 *
 * No model/network call ever runs inside the transaction: `prepare` happens
 * before it, `execute` is DB-only.
 */

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** The digest that identifies one logical operation's input. */
export function inputDigestOf(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function operationIdFor(requestOperationId: string | undefined): string {
  if (requestOperationId === undefined) {
    // Legacy clients: a request-scoped id. No cross-retry replay protection —
    // exactly the pre-Stage-4 behavior — but every execution is still audited.
    return `req-${randomUUID().replace(/-/g, '')}`;
  }
  if (!OPERATION_ID_PATTERN.test(requestOperationId)) {
    throw capabilityInputInvalid('operationId must be 8-64 characters of letters, digits, dashes or underscores');
  }
  return requestOperationId;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

interface StoredExecution {
  id: string;
  inputDigest: string;
  state: string;
  resultSummary: string;
}

async function readExecution(
  userId: string,
  capability: CapabilityName,
  operationId: string,
): Promise<StoredExecution | null> {
  const row = await prisma.capabilityExecution.findUnique({
    where: { userId_capability_operationId: { userId, capability, operationId } },
  });
  return (row as StoredExecution | null) ?? null;
}

/** Best-effort observability: a failed replay increment never invalidates a replay. */
function bumpReplayCount(executionId: string): void {
  prisma.capabilityExecution
    .update({ where: { id: executionId }, data: { replayCount: { increment: 1 } } })
    .catch(() => {});
}

/** Post-rollback failure audit. Never masks the original failure and never
 *  touches another executor's PENDING/SUCCEEDED row: the create is attempted
 *  once (first-execution failures find no row), and on a unique violation the
 *  conditional update touches ONLY a FAILED row with a matching digest. */
async function recordFailure(args: {
  userId: string;
  capability: CapabilityName;
  operationId: string;
  inputDigest: string;
  error: CapabilityFailure;
  latencyMs: number;
  correlationId: string;
}): Promise<void> {
  try {
    await prisma.capabilityExecution.create({
      data: {
        userId: args.userId,
        capability: args.capability,
        operationId: args.operationId,
        inputDigest: args.inputDigest,
        state: 'FAILED',
        confirmation: 'none',
        errorCode: args.error.code,
        latencyMs: args.latencyMs,
        correlationId: args.correlationId,
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) {
      // Audit persistence itself failed — log it; the original error must
      // propagate unchanged, never masked by an audit problem.
      console.error('[capability] failure audit could not be written:', err);
      return;
    }
    try {
      // A committed row exists: a concurrent winner (SUCCEEDED), another
      // failed attempt (FAILED), or the retry path's previous FAILED row.
      // The conditional update touches ONLY a FAILED row with a matching
      // digest — PENDING/SUCCEEDED winners are left completely untouched.
      await prisma.capabilityExecution.updateMany({
        where: {
          userId: args.userId,
          capability: args.capability,
          operationId: args.operationId,
          inputDigest: args.inputDigest,
          state: 'FAILED',
        },
        data: { errorCode: args.error.code, latencyMs: args.latencyMs },
      });
    } catch (auditErr) {
      console.error('[capability] failure audit could not be written:', auditErr);
    }
  }
}

/** Marker thrown from inside the transaction when the claim was lost; the
 *  transaction rolls back (only the claim write existed) and the conflict
 *  protocol resolves the outcome from the committed state. */
class ClaimConflict extends Error {
  constructor() {
    super('capability claim lost to a concurrent executor');
    this.name = 'ClaimConflict';
  }
}

function toFailure(err: unknown): CapabilityFailure {
  if (err instanceof CapabilityError) {
    return {
      code: err.code,
      message: err.message,
      repairableByModel: err.repairableByModel,
      requiresUserClarification: err.requiresUserClarification,
      details: err.details,
    };
  }
  return {
    code: 'CAPABILITY_EXECUTION_FAILED',
    message: err instanceof Error ? err.message : 'The operation failed.',
    repairableByModel: false,
    requiresUserClarification: false,
  };
}

/**
 * Execute one capability request through the registry.
 *
 * Expected outcomes come back as CapabilityOutcome; unexpected failures
 * throw (typed CapabilityError for capability-domain problems, the original
 * error otherwise — never masked by audit failures).
 */
export async function executeCapability<S = unknown>(
  ctx: CapabilityContext,
  request: CapabilityRequest<unknown>,
): Promise<CapabilityOutcome<S>> {
  const startedAt = Date.now();

  const definition: AnyCapabilityDefinition | undefined = capabilityRegistry.get(request.capability);
  if (!definition) {
    throw new CapabilityError('CAPABILITY_UNKNOWN', 'That action is not available.', {
      details: { capability: request.capability },
    });
  }

  const parsed = definition.inputSchema.safeParse(request.input);
  if (!parsed.success) {
    const issues = (parsed.error.issues ?? []) as Array<{ path: (string | number | symbol)[]; message: string }>;
    throw capabilityInputInvalid(
      issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '),
      { issues: issues as unknown as Record<string, unknown>[] },
    );
  }
  const input = parsed.data;
  const inputDigest = inputDigestOf(input);
  const operationId = operationIdFor(request.operationId);

  if (definition.confirmation !== 'none' && !ctx.confirmed) {
    throw new CapabilityError('CAPABILITY_CONFIRMATION_REQUIRED', 'This action needs your confirmation first.');
  }

  // Pre-claim read (no tx): the common replay/conflict cases resolve here,
  // before `prepare` — a replay never pays for a model call.
  const preClaim = await readExecution(ctx.userId, definition.name, operationId);
  if (preClaim) {
    if (preClaim.inputDigest !== inputDigest) {
      throw new CapabilityError(
        'CAPABILITY_IDEMPOTENCY_CONFLICT',
        'This operation was already used with different inputs.',
      );
    }
    if (preClaim.state === 'SUCCEEDED') {
      bumpReplayCount(preClaim.id);
      return { status: 'replayed', result: JSON.parse(preClaim.resultSummary) as S, executionId: preClaim.id };
    }
    if (preClaim.state === 'PENDING') {
      // Defensive: PENDING never commits. Treat as an in-flight operation.
      throw capabilityExecutionFailed('This operation is already being processed — try again in a moment.');
    }
    // state FAILED → the retry path below re-claims atomically.
  }

  // Preflight authorization (plain client) — fast fail only; the mandatory
  // recheck runs inside the transaction.
  await definition.authorize(ctx, input, prisma);

  // Prepare — outside any DB transaction, may call the model.
  const prepared = definition.prepare ? await definition.prepare(ctx, input) : undefined;

  // The claim, the business mutation, and the finalize commit atomically.
  // A lost claim race (concurrent executor moved the row) gets one bounded
  // re-resolution so a lost race is not user-visible.
  for (let pass = 0; ; pass++) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
      let executionId: string;
      if (!preClaim) {
        // First execution: the claim INSERT is the concurrency arbiter. A
        // unique violation here means a concurrent identical request won —
        // convert to the conflict protocol; the transaction rolls back (only
        // the claim write existed) and the committed winner is read below.
        try {
          const created = await tx.capabilityExecution.create({
            data: {
              userId: ctx.userId,
              capability: definition.name,
              operationId,
              inputDigest,
              state: 'PENDING',
              confirmation: definition.confirmation,
              correlationId: ctx.correlationId,
            },
          });
          executionId = created.id;
        } catch (err) {
          if (isUniqueViolation(err)) throw new ClaimConflict();
          throw err;
        }
      } else {
          // Retry after FAILED: conditional reclaim, atomic with the mutation.
          // count = 0 ⇒ another executor reclaimed/finished it first.
          const reclaimed = await tx.capabilityExecution.updateMany({
            where: { userId: ctx.userId, capability: definition.name, operationId, state: 'FAILED', inputDigest },
            data: { state: 'PENDING' },
          });
          if (reclaimed.count === 0) throw new ClaimConflict();
          executionId = preClaim.id;
        }

        // Mandatory in-transaction authorization recheck — the pre-tx state
        // may be stale by the time the claim is held.
        const refs = await definition.authorize(ctx, input, tx);

        const result = (await definition.execute(ctx, input, refs, tx, prepared)) as S;

        await tx.capabilityExecution.update({
          where: { id: executionId },
          data: {
            state: 'SUCCEEDED',
            resultSummary: JSON.stringify(result ?? null),
            latencyMs: Date.now() - startedAt,
          },
        });
        return { status: 'succeeded' as const, result, executionId };
      });
      // Post-commit hook: after the transaction commits, best-effort (a hook
      // failure is logged and never invalidates the committed mutation).
      if (outcome.status === 'succeeded') {
        await runPostCommit(definition.postCommit, ctx, input, outcome.result);
      }
      return outcome;
    } catch (err) {
      // A P2002 escaping the transaction is the claim's unique violation — the
      // only unique constraint in this transaction — so it is a lost race, not
      // a business failure. The conflict protocol resolves it from the
      // committed state.
      if ((err instanceof ClaimConflict || isUniqueViolation(err)) && pass < 2) {
        // Our claim/reclaim rolled back; resolve from the committed state.
        const fresh = await readExecution(ctx.userId, definition.name, operationId);
        if (fresh && fresh.inputDigest === inputDigest && fresh.state === 'SUCCEEDED') {
          bumpReplayCount(fresh.id);
          return { status: 'replayed', result: JSON.parse(fresh.resultSummary) as S, executionId: fresh.id };
        }
        if (fresh && fresh.state === 'PENDING') {
          throw capabilityExecutionFailed('This operation is already being processed — try again in a moment.');
        }
        continue; // FAILED again or absent: one bounded re-attempt.
      }

      const failure = toFailure(err);
      await recordFailure({
        userId: ctx.userId,
        capability: definition.name,
        operationId,
        inputDigest,
        error: failure,
        latencyMs: Date.now() - startedAt,
        correlationId: ctx.correlationId,
      });
      if (err instanceof CapabilityError) throw err;

      // Business-rule errors from wrapped services keep their HTTP
      // conventions: re-throw HttpError-shaped errors untouched, wrap the rest.
      if (typeof err === 'object' && err !== null && 'statusCode' in err) throw err;
      throw capabilityExecutionFailed(failure.message);
    }
  }
}

/** Post-commit hook runner (failures logged, never fatal). */
export async function runPostCommit<S, P>(
  postCommit: ((ctx: CapabilityContext, input: unknown, result: S) => Promise<void>) | undefined,
  ctx: CapabilityContext,
  input: unknown,
  result: S,
): Promise<void> {
  if (!postCommit) return;
  try {
    await postCommit(ctx, input, result);
  } catch (err) {
    console.error('[capability] post-commit hook failed:', err);
  }
}

/** Narrow an outcome to its succeeded/replayed result, surfacing a failure as
 *  the typed CapabilityError so route-level mapping stays in one place. */
export function unwrapCapability<S>(outcome: CapabilityOutcome<S>): { result: S; replayed: boolean; executionId: string } {
  if (outcome.status === 'failed') {
    throw new CapabilityError(outcome.error.code, outcome.error.message, {
      requiresUserClarification: outcome.error.requiresUserClarification,
      details: outcome.error.details,
    });
  }
  return { result: outcome.result, replayed: outcome.status === 'replayed', executionId: outcome.executionId };
}
