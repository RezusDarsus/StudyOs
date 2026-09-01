import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { recommendationItemSchema } from '../ai/schemas.js';
import { tooManyRequests } from '../lib/errors.js';
import { AttemptWindow, describeWait } from '../lib/rate-limit.js';
import { executeCapability, unwrapCapability } from '../capabilities/executor.js';
import { CapabilityError } from '../capabilities/capability-error.js';
import { loadGoalForUser } from '../services/goals.js';

/**
 * Explicit user actions on recommended items (Stage 2).
 *
 * Deliberately small: two registered actions, no free-form instruction surface.
 * The model has nothing to do with this endpoint — it is the user's own API for
 * durable history — and every request is idempotent under a retry: the client
 * generates one `operationId` per action and reuses it, while the database
 * unique index on (userId, requestId) turns a replay into the same success.
 */

// Cheap writes, but still worth a ceiling: one user cannot churn the history
// table faster than this. In memory and per process — the same limitation
// lib/rate-limit.ts documents for every window in this app.
const MUTATIONS_PER_WINDOW = 60;
const MUTATION_WINDOW_SECONDS = 60;
const mutationsPerUser = new AttemptWindow(MUTATIONS_PER_WINDOW, MUTATION_WINDOW_SECONDS);

function throttle(
  reply: FastifyReply,
  what: string,
  key: string,
  window: AttemptWindow,
): void {
  const blocked = window.blockedFor(key);
  if (blocked === 0) {
    window.record(key);
    return;
  }
  reply.header('Retry-After', String(blocked));
  throw tooManyRequests(`Too many ${what}. Please try again in ${describeWait(blocked)}.`);
}

/**
 * The body of an explicit recommendation action. The entity fields reuse the
 * domain-open Stage 1 schema verbatim — the server recomputes identity from
 * them, so a client-supplied identity key is structurally impossible.
 */
export const recommendationMutationSchema = z
  .object({
    action: z.enum(['mark_consumed', 'correct_consumption']),
    operationId: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z0-9_-]{8,64}$/,
        'operationId must be 8-64 characters of letters, digits, dashes or underscores',
      ),
    entityType: recommendationItemSchema.shape.entityType,
    displayName: recommendationItemSchema.shape.displayName,
    attribution: recommendationItemSchema.shape.attribution,
    goalId: z.string().trim().min(1).optional(),
    note: z.string().trim().min(1).max(300).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'mark_consumed' && value.note !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a note belongs to correct_consumption, not mark_consumed',
        path: ['note'],
      });
    }
  });

export default async function recommendationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Record one explicit action on one recommended item. Ownership is
   * server-derived (the session cookie); goal participation is re-verified
   * here when a goal context is supplied.
   */
  app.post('/recommendations/events', { preHandler: app.requireAuth }, async (req, reply) => {
    throttle(reply, 'recommendation updates', `rec:user:${req.user!.id}`, mutationsPerUser);
    const body = recommendationMutationSchema.parse(req.body);
    if (body.goalId) {
      await loadGoalForUser(body.goalId, req.user!.id, 'participate');
    }
    // Stage 4 canonical path: through the registry — the capability wraps the
    // same Stage 2 service, so persistence/idempotency semantics are identical.
    // Legacy clients that omit operationId get a request-scoped key (the
    // executor's own fallback semantics, applied here because the capability
    // input schema requires the field).
    const capability =
      body.action === 'mark_consumed' ? 'recommendation.mark_consumed' : 'recommendation.correct_consumption';
    try {
      const outcome = await executeCapability(
        { userId: req.user!.id, confirmed: true, correlationId: randomUUID() },
        {
          capability,
          input: {
            action: body.action,
            entityType: body.entityType,
            displayName: body.displayName,
            attribution: body.attribution ?? undefined,
            goalId: body.goalId,
            note: body.note,
            operationId: body.operationId ?? `req-${randomUUID().replace(/-/g, '')}`,
          },
          operationId: body.operationId,
        },
      );
      const { result, replayed } = unwrapCapability(outcome) as {
        result: { event: Record<string, unknown>; facets: unknown; replayed: boolean };
        replayed: boolean;
      };
      return { ...result, replayed: replayed || result.replayed };
    } catch (err) {
      if (err instanceof CapabilityError) throw err.toHttpError();
      throw err;
    }
  });
}
