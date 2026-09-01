import { z } from 'zod';
import { recommendationItemSchema } from '../../ai/schemas.js';
import { recordUserAction } from '../../services/recommendation-history.js';
import { capabilityForbidden } from '../capability-error.js';
import type {
  CapabilityContext,
  CapabilityDefinition,
  EntityRef,
} from '../types.js';

/**
 * Stage 2 recommendation actions, wrapped as capabilities (rev.1 §16).
 *
 * The persistence, idempotency and fold semantics are Stage 2's, unchanged:
 * this adapter proves the generic registry can drive the existing mature
 * service. The entity fields are validated by the same domain-open Stage 1
 * schema; identity is recomputed server-side inside the service.
 */

const recommendationActionInput = z
  .object({
    action: z.enum(['mark_consumed', 'correct_consumption']),
    operationId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,64}$/, 'operationId must be 8-64 characters of letters, digits, dashes or underscores'),
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

export type RecommendationActionInput = z.infer<typeof recommendationActionInput>;

function actionToCapability(name: 'recommendation.mark_consumed' | 'recommendation.correct_consumption') {
  const action = name === 'recommendation.mark_consumed' ? 'mark_consumed' : 'correct_consumption';
  return {
    define(): CapabilityDefinition<RecommendationActionInput, { event: unknown; facets: unknown; replayed: boolean }> {
      return {
        name,
        inputSchema: recommendationActionInput,
        confirmation: 'none',
        transactional: true,
        authorize: async (ctx: CapabilityContext, input: RecommendationActionInput) => {
          // Stage 2's goal-participation check, applied here so the executor's
          // preflight and in-tx recheck both enforce it.
          if (input.goalId) {
            const { loadGoalForUser } = await import('../../services/goals.js');
            try {
              await loadGoalForUser(input.goalId, ctx.userId, 'participate');
            } catch {
              throw capabilityForbidden('You are not part of this goal');
            }
          }
          return [
            {
              kind: 'recommendation' as const,
              id: `${input.entityType}:${input.displayName}:${input.attribution ?? ''}`,
            },
          ];
        },
        execute: async (
          ctx: CapabilityContext,
          input: RecommendationActionInput,
          _refs: readonly EntityRef[],
          tx: Parameters<CapabilityDefinition<RecommendationActionInput, never>['execute']>[3],
        ) => {
          // Stage 2 semantics on the executor's transaction client.
          const result = await recordUserAction(
            {
              userId: ctx.userId,
              goalId: input.goalId ?? null,
              action,
              operationId: input.operationId,
              item: {
                entityType: input.entityType,
                displayName: input.displayName,
                attribution: input.attribution ?? undefined,
              },
              note: input.note,
            },
            tx,
          );
          return {
            event: {
              id: result.event.id,
              entityType: result.event.entityType,
              displayName: result.event.displayName,
              attribution: result.event.attribution,
              eventKind: result.event.eventKind,
              occurredAt: result.event.occurredAt,
            },
            facets: result.facets,
            replayed: result.replayed,
          };
        },
        describe: {
          purpose:
            action === 'mark_consumed'
              ? 'Record that the user has used or completed a recommended item.'
              : 'Record the user correcting a previous consumption mark on a recommended item.',
          arguments: '{ action, operationId, entityType, displayName, attribution?, goalId?, note? }',
        },
      };
    },
  };
}

export const markConsumedCapability = actionToCapability('recommendation.mark_consumed').define();
export const correctConsumptionCapability = actionToCapability('recommendation.correct_consumption').define();

