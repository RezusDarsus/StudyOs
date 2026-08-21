import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CopilotUnavailableError, isCopilotEnabled } from '../ai/client.js';
import { AiProviderError } from '../ai/provider.js';
import { DraftValidationError } from '../ai/draft-validator.js';
import { RECURRENCE_TYPE } from '../domain/enums.js';
import { isDayString } from '../domain/dates.js';
import { badRequest, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { describeProvenance, parseContext, toPlainObject } from '../ai/context.js';
import {
  answerQuestion,
  cancelSession,
  loadSession,
  resumableSessions,
  startSession,
} from '../services/copilot-session.js';
import {
  applyCopilotEdit,
  applyManualEdit,
  confirmDraft,
  discardDraft,
  generateDraft,
  loadDraft,
  parseLadder,
} from '../services/copilot-draft.js';
import { askGoalCopilot } from '../services/copilot-goal.js';
import { deletePreference, listPreferences } from '../services/preferences.js';
import { recordEvent } from '../services/copilot-analytics.js';

/**
 * Every route here derives the user from the session cookie. A userId appearing
 * anywhere in a model's output is ignored — the AI cannot act as anyone.
 */
function serializeDraft(draft: Awaited<ReturnType<typeof loadDraft>>) {
  return {
    id: draft.id,
    sessionId: draft.sessionId,
    title: draft.title,
    description: draft.description,
    category: draft.category,
    targetType: draft.targetType,
    targetValue: draft.targetValue,
    deadline: draft.deadline,
    visibility: draft.visibility,
    rationale: draft.rationale,
    status: draft.status,
    createdGoalId: draft.createdGoalId,
    tasks: draft.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      recurrenceType: task.recurrenceType,
      recurrenceConfig: JSON.parse(task.recurrenceConfig || '{}'),
      estimatedMinutes: task.estimatedMinutes,
      preferredTime: task.preferredTime,
      reason: task.reason,
      // The proposed build-up, so the review screen can show it before the user
      // agrees to it. Nothing here exists as a ProgressionPlan yet.
      progression: parseLadder(task.progressionConfig),
    })),
  };
}

/**
 * A free-text message to the Copilot.
 *
 * One character is enough. This used to require two, which meant a message of
 * "/" — a legitimate thing to type, and one of the reported slash failures —
 * came back as an opaque 400 while the Send button sat there enabled. Slashes
 * are never stripped: "5/7 days" and "walking/running" reach the model verbatim.
 */
const copilotMessage = z.string().trim().min(1, 'Type something first').max(400);

/** Turn provider failures into something a person can act on. */
function toUserFacing(err: unknown): never {
  if (err instanceof CopilotUnavailableError) {
    throw badRequest(
      'The Copilot is not configured on this server. You can still create goals manually.',
      'COPILOT_DISABLED',
    );
  }
  if (err instanceof DraftValidationError) {
    throw badRequest(err.message, 'DRAFT_INVALID');
  }
  if (err instanceof AiProviderError) {
    const message =
      err.kind === 'TIMEOUT'
        ? 'The Copilot took too long to respond. Your answers are saved — try again.'
        : err.kind === 'RATE_LIMIT'
          ? 'The Copilot is busy right now. Your answers are saved — try again in a moment.'
          : err.kind === 'AUTH'
            ? 'The Copilot is not configured correctly on this server.'
            : "I couldn't build that correctly. Your answers are saved — try again.";
    throw badRequest(message, `AI_${err.kind}`);
  }
  throw err;
}

export default async function copilotRoutes(app: FastifyInstance) {
  app.get('/copilot/status', { preHandler: app.requireAuth }, async (req) => {
    return { enabled: isCopilotEnabled(), resumable: await resumableSessions(req.user!.id) };
  });

  // ------------------------------------------------------------- interview

  app.post('/copilot/goal-sessions', { preHandler: app.requireAuth }, async (req) => {
    const { goal } = z
      .object({ goal: z.string().trim().min(3, 'Tell me a little more').max(500) })
      .parse(req.body);
    try {
      return await startSession(req.user!.id, goal);
    } catch (err) {
      toUserFacing(err);
    }
  });

  app.get('/copilot/goal-sessions/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const session = await loadSession(id, req.user!.id);

    const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant');
    const draft = await prisma.goalDraft.findFirst({
      where: { sessionId: id, status: { not: 'DISCARDED' } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      sessionId: session.id,
      status: session.status,
      initialGoalText: session.initialGoalText,
      questionCount: session.questionCount,
      context: toPlainObject(parseContext(session.structuredContext, session.initialGoalText)),
      provenance: describeProvenance(parseContext(session.structuredContext, session.initialGoalText)),
      canGenerate: session.status === 'READY_TO_GENERATE',
      draftId: draft?.id ?? null,
      messages: session.messages.map((m) => ({
        role: m.role,
        content: m.content,
        question: m.structuredPayload ? JSON.parse(m.structuredPayload) : null,
        createdAt: m.createdAt,
      })),
      question:
        lastAssistant?.structuredPayload && session.status === 'INTERVIEWING'
          ? JSON.parse(lastAssistant.structuredPayload)
          : null,
    };
  });

  app.post('/copilot/goal-sessions/:id/answers', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        questionId: z.string().trim().min(1).max(60),
        // Whatever the question type produced; rendered to text for the transcript.
        answer: z.union([z.string().max(500), z.number(), z.array(z.string().max(120)).max(20)]).nullish(),
        skipped: z.boolean().default(false),
      })
      .parse(req.body);

    try {
      return await answerQuestion(id, req.user!.id, body);
    } catch (err) {
      toUserFacing(err);
    }
  });

  app.delete('/copilot/goal-sessions/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await cancelSession(id, req.user!.id);
    return { ok: true };
  });

  // ----------------------------------------------------------------- draft

  app.post('/copilot/goal-sessions/:id/generate', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { regenerate } = z
      .object({ regenerate: z.boolean().default(false) })
      .parse(req.body ?? {});
    try {
      const { draft, adjustments } = await generateDraft(id, req.user!.id, regenerate);
      return { draft: serializeDraft(draft), adjustments };
    } catch (err) {
      toUserFacing(err);
    }
  });

  app.get('/copilot/goal-drafts/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return { draft: serializeDraft(await loadDraft(id, req.user!.id)) };
  });

  app.patch('/copilot/goal-drafts/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(1000).optional(),
        deadline: z.string().refine(isDayString).nullish(),
        visibility: z.enum(['PRIVATE', 'PUBLIC']).optional(),
        tasks: z
          .array(
            z.object({
              id: z.string().optional(),
              title: z.string().trim().min(1).max(120),
              description: z.string().trim().max(400).optional(),
              recurrenceType: z.enum(RECURRENCE_TYPE),
              recurrenceConfig: z.record(z.unknown()).default({}),
              estimatedMinutes: z.number().int().min(1).max(600).nullish(),
              preferredTime: z
                .string()
                .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
                .nullish(),
              reason: z.string().trim().max(300).optional(),
              // Only null is meaningful: "remove the build-up". Omitting the key
              // keeps whatever the draft already had. A ladder cannot be authored
              // here — that belongs to the real task, once it exists.
              progression: z.null().optional(),
            }),
          )
          .max(8)
          .optional(),
      })
      .parse(req.body);

    const draft = await applyManualEdit(id, req.user!.id, body);
    return { draft: serializeDraft(draft) };
  });

  app.post('/copilot/goal-drafts/:id/copilot-edit', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { message } = z.object({ message: copilotMessage }).parse(req.body);
    try {
      const { draft, assistantMessage, applied } = await applyCopilotEdit(id, req.user!.id, message);
      return { draft: serializeDraft(draft), assistantMessage, applied };
    } catch (err) {
      toUserFacing(err);
    }
  });

  /** The only endpoint that creates real Phase 1 entities. */
  app.post('/copilot/goal-drafts/:id/confirm', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return confirmDraft(id, req.user!.id);
  });

  app.post('/copilot/goal-drafts/:id/discard', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await discardDraft(id, req.user!.id);
    return { ok: true };
  });

  app.post('/copilot/goal-drafts/:id/feedback', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { useful } = z.object({ useful: z.boolean() }).parse(req.body);
    await loadDraft(id, req.user!.id);
    await recordEvent({ userId: req.user!.id, type: 'FEEDBACK_GIVEN', draftId: id, meta: { useful } });
    return { ok: true };
  });

  // ------------------------------------------------------- existing goals

  app.post('/goals/:id/copilot', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { message } = z.object({ message: copilotMessage }).parse(req.body);
    try {
      return await askGoalCopilot(id, req.user!.id, message);
    } catch (err) {
      toUserFacing(err);
    }
  });

  // --------------------------------------------------------- preferences

  app.get('/copilot/preferences', { preHandler: app.requireAuth }, async (req) => {
    const preferences = await listPreferences(req.user!.id);
    return {
      preferences: preferences.map((p) => ({
        id: p.id,
        key: p.key,
        value: p.value,
        scope: p.scope,
        category: p.category || null,
        confidence: p.confidence,
      })),
    };
  });

  app.delete('/copilot/preferences/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await deletePreference(req.user!.id, id);
    return { ok: true };
  });
}
