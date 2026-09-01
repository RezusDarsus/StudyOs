import { z } from 'zod';
import {
  applyManualEditInTx,
  applyPatchInTx,
  confirmDraftInTx,
  loadDraft,
  applyCopilotEdit,
} from '../../services/copilot-draft.js';
import { applyDecision, loadPlansForGoal, progressionSummary } from '../../services/progression.js';
import { prisma } from '../../lib/prisma.js';
import { CapabilityError, capabilityStale } from '../capability-error.js';
import type {
  CapabilityContext,
  CapabilityDefinition,
  EntityRef,
} from '../types.js';

/**
 * Draft-lifecycle capabilities (Stage 4). Each adapter wraps the existing
 * tested InTx writer; the executor commits the idempotency claim, the
 * business writes, and the SUCCEEDED finalize in ONE transaction.
 *
 * Confirmation policies are 'none' because the existing UX already owns the
 * confirmation step: the draft review screen is the preview, and "confirm"
 * / "apply edit" are the user's explicit actions. Nothing here executes
 * without a user-initiated request on an owned draft.
 */

// ------------------------------------------------------------------ confirm

const confirmInputSchema = z.object({ draftId: z.string().min(1) });

export const confirmFromDraftCapability: CapabilityDefinition<
  z.infer<typeof confirmInputSchema>,
  { goalId: string; alreadyCreated: boolean }
> = {
  name: 'goal.confirm_from_draft',
  inputSchema: confirmInputSchema,
  confirmation: 'none',
  transactional: true,
  authorize: async (ctx, input, client) => {
    await loadDraft(input.draftId, ctx.userId, client);
    return [{ kind: 'draft', id: input.draftId }];
  },
  execute: async (ctx, input, _refs, tx) => confirmDraftInTx(input.draftId, ctx.userId, tx),
  postCommit: async (ctx, input, result) => {
    const { recordEvent } = await import('../../services/copilot-analytics.js');
    if (!result.alreadyCreated) {
      await recordEvent({
        userId: ctx.userId,
        type: 'DRAFT_CONFIRMED',
        draftId: input.draftId,
        meta: { goalId: result.goalId },
      });
    }
  },
  describe: {
    purpose: 'Create the real goal (with tasks, ladders and occurrences) from a confirmed draft.',
    arguments: '{ draftId }',
  },
};

// --------------------------------------------------------------- AI edit

const aiEditInputSchema = z.object({
  draftId: z.string().min(1),
  message: z.string().trim().min(1, 'Type something first').max(400),
});

/**
 * The model call happens in `prepare` — outside the idempotency claim and
 * transaction — because the model is not transactional. The digest covers only
 * { draftId, message }, so a retry replays the committed patch regardless of
 * model nondeterminism, and a replay never pays for a model call.
 */
export const applyAiEditCapability: CapabilityDefinition<
  { draftId: string; message: string },
  { draft: unknown; applied: string[]; assistantMessage: string },
  { patch: unknown; assistantMessage: string }
> = {
  name: 'goal.apply_ai_edit',
  inputSchema: aiEditInputSchema,
  confirmation: 'none',
  transactional: true,
  authorize: async (ctx, input, client) => {
    const draft = await loadDraft(input.draftId, ctx.userId, client);
    if (draft.status === 'CONFIRMED') {
      throw capabilityStale('This draft has already been used');
    }
    return [{ kind: 'draft', id: input.draftId }];
  },
  prepare: async (ctx, input) => {
    const { patch, assistantMessage } = await applyCopilotEditPrepare(input.draftId, ctx.userId, input.message);
    return { patch, assistantMessage };
  },
  execute: async (ctx, input, _refs, tx, prepared) => {
    if (!prepared) {
      // Unreachable: the executor always runs prepare before execute when defined.
      throw new CapabilityError('CAPABILITY_EXECUTION_FAILED', 'The AI edit was not prepared.');
    }
    const { draft, applied } = await applyPatchInTx(input.draftId, ctx.userId, prepared.patch as never, tx);
    return { draft, applied, assistantMessage: prepared.assistantMessage };
  },
  postCommit: async (ctx, input) => {
    const { recordEvent } = await import('../../services/copilot-analytics.js');
    await recordEvent({ userId: ctx.userId, type: 'DRAFT_EDITED_WITH_AI', draftId: input.draftId });
  },
  describe: {
    purpose: 'Apply a conversational edit to a draft (patch operations, re-validated by id).',
    arguments: '{ draftId, message }',
  },
};

/** Split out of applyCopilotEdit: generation + validation WITHOUT the writes. */
async function applyCopilotEditPrepare(draftId: string, userId: string, message: string) {
  const chatJson = (await import('../../ai/client.js')).chatJson;
  const { PROMPT_VERSIONS, draftEditSystemPrompt, draftEditUserPrompt } = await import('../../ai/prompts.js');
  const { draftPatchSchema } = await import('../../ai/schemas.js');
  const draft = await loadDraft(draftId, userId);
  if (draft.status === 'CONFIRMED') throw capabilityStale('This draft has already been used');
  const patch = await chatJson(
    {
      purpose: 'DRAFT_EDIT' as never,
      promptVersion: PROMPT_VERSIONS.edit,
      userId,
      thinking: false,
      temperature: 0.2,
      maxTokens: 1200,
      messages: [
        { role: 'system' as const, content: draftEditSystemPrompt() },
        {
          role: 'user' as const,
          content: draftEditUserPrompt({
            draft: {
              title: draft.title,
              description: draft.description,
              deadline: draft.deadline,
              tasks: draft.tasks.map((t) => ({
                taskId: t.id,
                title: t.title,
                recurrence: { type: t.recurrenceType as never, ...JSON.parse(t.recurrenceConfig || '{}') },
                estimatedMinutes: t.estimatedMinutes,
                preferredTime: t.preferredTime,
              })),
            },
            message,
          }),
        },
      ],
    },
    draftPatchSchema,
  );
  return { patch, assistantMessage: patch.assistantMessage };
}

// ------------------------------------------------------------ manual edit

const manualEditSchema = z.object({
  draftId: z.string().min(1),
  title: z.string().trim().max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  deadline: z.string().optional(),
  visibility: z.enum(['PRIVATE', 'PUBLIC']).optional(),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1), // Stable ID required — display-text matching is gone.
        title: z.string().trim().min(1).max(120),
        description: z.string().trim().max(400).optional(),
        recurrenceType: z.string(),
        recurrenceConfig: z.record(z.unknown()),
        estimatedMinutes: z.number().int().min(1).max(600).nullish(),
        preferredTime: z.string().nullish(),
        reason: z.string().trim().max(300).optional(),
        progression: z.null().optional(),
      }),
    )
    .max(8)
    .optional(),
});

export const applyManualEditCapability: CapabilityDefinition<
  z.infer<typeof manualEditSchema>,
  { draft: unknown }
> = {
  name: 'goal.apply_manual_edit',
  inputSchema: manualEditSchema,
  confirmation: 'none',
  transactional: true,
  authorize: async (ctx, input, client) => {
    const draft = await loadDraft(input.draftId, ctx.userId, client);
    if (draft.status === 'CONFIRMED') throw capabilityStale('This draft has already been used');
    return [{ kind: 'draft', id: input.draftId }];
  },
  execute: async (ctx, input, _refs, tx) => {
    // Stable-ID requirement: the capability input's task ids drive the ladder
    // carry-back; the legacy title fallback never runs on this path.
    await applyManualEditInTx(
      input.draftId,
      ctx.userId,
      {
        title: input.title,
        description: input.description,
        deadline: input.deadline ?? undefined,
        visibility: input.visibility,
        tasks: input.tasks?.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          recurrenceType: task.recurrenceType as never,
          recurrenceConfig: task.recurrenceConfig,
          estimatedMinutes: task.estimatedMinutes ?? null,
          preferredTime: task.preferredTime ?? null,
          reason: task.reason,
          progression: null,
        })),
      },
      tx,
    );
    return { draft: await loadDraft(input.draftId, ctx.userId, tx) };
  },
  postCommit: async (ctx, input) => {
    const { recordEvent } = await import('../../services/copilot-analytics.js');
    await recordEvent({ userId: ctx.userId, type: 'DRAFT_EDITED_MANUALLY', draftId: input.draftId });
  },
  describe: {
    purpose: 'Apply the user’s own field edits to a draft (title, description, tasks).',
    arguments: '{ draftId, title?, description?, deadline?, visibility?, tasks? }',
  },
};

// ------------------------------------------------- progression proposals

const progressionSuggestionSchema = z.object({
  taskId: z.string().trim().min(1).max(60).nullish(),
  taskTitle: z.string().trim().max(120).nullish(),
  proposedProgressionAction: z.enum(['ADVANCE', 'REDUCE']).nullish(),
});

const progressionInputSchema = z.object({
  goalId: z.string().min(1),
  suggestions: z.array(progressionSuggestionSchema).max(4),
});

export interface ProgressionProposalLike {
  planId: string;
  taskTitle: string;
  requested: 'ADVANCE' | 'REDUCE';
  reviewAction: string;
  stageLabel: string;
  reason: string;
  applied: boolean;
}

/**
 * Resolve a suggestion to a stable progression plan. The model's `taskId` —
 * supplied in the prompt from server-owned data — wins; the title is the
 * explicit 0/1/>1 resolver and NEVER the executor's target.
 */
/** Exported for the Stage 4 stable-reference tests. */
export async function resolveSuggestion(
  goalId: string,
  suggestion: { taskId?: string | null; taskTitle?: string | null },
): Promise<{ planId: string; taskTitle: string } | { outcome: 'not_found' | 'ambiguous' }> {
  const plans = await loadPlansForGoal(goalId);
  const tasks = await prisma.taskDefinition.findMany({
    where: { goalId, archivedAt: null },
    select: { id: true, title: true },
  });
  const titleById = new Map(tasks.map((task) => [task.id, task.title]));
  const activePlans = plans.filter((plan) => plan.status === 'ACTIVE');

  // 1. Stable ID first — the model echoed a server-owned reference.
  if (suggestion.taskId) {
    const byId = activePlans.find((plan) => plan.taskDefinitionId === suggestion.taskId);
    const task = tasks.find((t) => t.id === suggestion.taskId);
    if (byId && task) return { planId: byId.id, taskTitle: task.title };
    return { outcome: 'not_found' };
  }

  // 2. Explicit title resolver: 0 → not found, 1 → resolved, >1 → ambiguous.
  if (suggestion.taskTitle) {
    const matches = activePlans
      .map((plan) => ({ plan, title: titleById.get(plan.taskDefinitionId) }))
      .filter((entry): entry is { plan: typeof activePlans[number]; title: string } =>
        entry.title?.trim().toLowerCase() === suggestion.taskTitle!.trim().toLowerCase());
    if (matches.length === 1) return { planId: matches[0].plan.id, taskTitle: matches[0].title };
    if (matches.length > 1) return { outcome: 'ambiguous' };
    return { outcome: 'not_found' };
  }

  return { outcome: 'not_found' };
}

export const proposeProgressionCapability: CapabilityDefinition<
  z.infer<typeof progressionInputSchema>,
  { proposals: ProgressionProposalLike[]; unresolved: number }
> = {
  name: 'progression.propose_from_suggestion',
  inputSchema: progressionInputSchema,
  confirmation: 'none',
  transactional: true,
  authorize: async (ctx, input, client) => {
    const { loadGoalForUser } = await import('../../services/goals.js');
    const { participant } = await loadGoalForUser(input.goalId, ctx.userId, 'participate');
    void participant;
    return [{ kind: 'goal', id: input.goalId }];
  },
  execute: async (ctx, input, _refs, tx) => {
    // The decision must be attributed to the GOAL PARTICIPANT, not the raw
    // user id — resolved server-side here (in-transaction, ownership-checked).
    const { loadGoalForUser } = await import('../../services/goals.js');
    const { participant } = await loadGoalForUser(input.goalId, ctx.userId, 'participate');
    // Ownership was just proven in authorize; the participant id is required
    // for a correctly attributed decision.
    if (!participant) throw new CapabilityError('CAPABILITY_FORBIDDEN', 'You are not part of this goal');
    const proposals: ProgressionProposalLike[] = [];
    let unresolved = 0;
    const seen = new Set<string>();
    for (const suggestion of input.suggestions) {
      if (suggestion.proposedProgressionAction !== 'ADVANCE' && suggestion.proposedProgressionAction !== 'REDUCE') {
        continue;
      }
      const resolved = await resolveSuggestion(input.goalId, suggestion);
      if ('outcome' in resolved) {
        // 0 matches or ambiguous: skipped deterministically, counted in the
        // audit — never silently picked among duplicates.
        unresolved++;
        continue;
      }
      if (seen.has(resolved.planId)) continue;
      seen.add(resolved.planId);
      try {
        const result = await applyDecision({
          planId: resolved.planId,
          participantId: participant.id,
          action: suggestion.proposedProgressionAction,
          source: 'COPILOT',
        }, tx);
        const { progressionSummary } = await import('../../services/progression.js');
        proposals.push({
          planId: resolved.planId,
          taskTitle: resolved.taskTitle,
          requested: suggestion.proposedProgressionAction,
          reviewAction: result.verdict.action,
          stageLabel: progressionSummary(result.plan).stageLabel,
          reason: result.reason,
          applied: result.applied,
        });
      } catch {
        continue;
      }
    }
    return { proposals, unresolved };
  },
  describe: {
    purpose: 'Record stage-change proposals derived from the Copilot’s answer (never self-applied).',
    arguments: '{ goalId, suggestions[] }',
  },
};
