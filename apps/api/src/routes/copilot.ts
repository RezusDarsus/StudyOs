import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CopilotUnavailableError, isCopilotEnabled } from '../ai/client.js';
import { AiProviderError } from '../ai/provider.js';
import { DraftValidationError } from '../ai/draft-validator.js';
import { MAX_RECOMMENDATIONS, recommendationItemSchema } from '../ai/schemas.js';
import { RECURRENCE_TYPE } from '../domain/enums.js';
import { isDayString } from '../domain/dates.js';
import { badRequest, notFound, serviceUnavailable, tooManyRequests } from '../lib/errors.js';
import { AttemptWindow, describeWait } from '../lib/rate-limit.js';
import { prisma } from '../lib/prisma.js';
import { describeProvenance, parseContext, toPlainObject } from '../ai/context.js';
import { canForceGenerate, HARD_MAX_QUESTIONS } from '../services/copilot-session.js';
import {
  classifyIntent,
  classifyIntentWithLlm,
  INTENT_CLARIFICATION,
  type CopilotIntent,
  type CopilotIntentResult,
} from '../ai/intent-router.js';
import type { PlanReadiness } from '../ai/requirements/coverage.js';
import {
  answerQuestion,
  cancelSession,
  loadSession,
  resumableSessions,
  sessionReadiness,
  startSession,
} from '../services/copilot-session.js';
import {
  applyCopilotEdit,
  discardDraft,
  generateDraft,
  loadDraft,
  parseLadder,
} from '../services/copilot-draft.js';
import { askGoalCopilot } from '../services/copilot-goal.js';
import { RecommendationValidationError } from '../services/copilot-recommendations.js';
import { RecommendationHistoryUnavailableError } from '../services/recommendation-history.js';
import { executeCapability, unwrapCapability } from '../capabilities/executor.js';
import { CapabilityError } from '../capabilities/capability-error.js';
import { deletePreference, listPreferences } from '../services/preferences.js';
import { recordEvent } from '../services/copilot-analytics.js';
import { estimateRemainingAskable, evaluateAstReadiness, summarizeReadiness, renderAssumptionLines, type RequirementState } from '../ai/requirements/index.js';
import { parseRequirementState } from '../ai/context.js';

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

// Every AI call costs real money and real latency, so every Copilot user gets a
// rate: this many model-backed requests per minute, keyed on the authenticated
// user. In memory and per process — the same limitation lib/rate-limit.ts
// documents — and applied only to the model-backed routes below; reads and
// drafts-by-id stay unmetered.
const AI_REQUESTS_PER_WINDOW = 30;
const AI_WINDOW_SECONDS = 60;
const copilotAiPerUser = new AttemptWindow(AI_REQUESTS_PER_WINDOW, AI_WINDOW_SECONDS);

function throttleAi(req: FastifyRequest, reply: FastifyReply): void {
  const key = `copilot-ai:user:${req.user!.id}`;
  const blocked = copilotAiPerUser.blockedFor(key);
  if (blocked > 0) {
    reply.header('Retry-After', String(blocked));
    throw tooManyRequests(
      `Too many Copilot requests. Please try again in ${describeWait(blocked)}.`,
    );
  }
  copilotAiPerUser.record(key);
}

/**
 * The mirrored goal-chat conversation the client sends back. Stage 1: entries
 * may carry the structured recommendations that came with the turn — the only
 * recommendation memory this pipeline has. Optional and validated with the same
 * domain-open schema the model output uses, so pre-Stage-1 clients (which send
 * no field) parse unchanged.
 */
export const goalCopilotHistorySchema = z
  .array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().trim().min(1).max(800),
      recommendations: z.array(recommendationItemSchema).max(MAX_RECOMMENDATIONS).nullish(),
    }),
  )
  .max(8)
  .default([]);

/** Turn provider failures into something a person can act on. */
export function toUserFacing(err: unknown): never {
  if (err instanceof CopilotUnavailableError) {
    throw badRequest(
      'The Copilot is not configured on this server. You can still create goals manually.',
      'COPILOT_DISABLED',
    );
  }
  if (err instanceof DraftValidationError) {
    throw badRequest(err.message, 'DRAFT_INVALID');
  }
  if (err instanceof RecommendationValidationError) {
    // The structured recommendation contract could not be satisfied within the
    // one-repair budget. Typed and retryable — nothing is substituted for the
    // model's answer, ever.
    throw serviceUnavailable(
      "Copilot couldn't format its recommendations just now. Try again.",
      err.code,
    );
  }
  if (err instanceof RecommendationHistoryUnavailableError) {
    // Stage 2, `required` write mode: durable memory is part of the request,
    // so a persistence failure is an honest retryable 503 rather than an
    // answer that silently forgets.
    throw serviceUnavailable(err.message, err.code);
  }
  if (err instanceof CapabilityError) {
    // Stage 4: typed capability failures carry their own HTTP convention
    // (403/404/409/503 per code) and are never fed back to the model for
    // repair when they are authorization-shaped.
    throw err.toHttpError();
  }
  if (err instanceof AiProviderError) {
    // AUTH is the one permanent failure: retrying cannot help, so it stays a
    // 400 describing the server's configuration. Everything else is the
    // provider being down, slow or incoherent — a 503 that says to try again,
    // never a fake plan dressed up as success.
    if (err.kind === 'AUTH') {
      throw badRequest('The Copilot is not configured correctly on this server.', 'AI_AUTH');
    }
    const message =
      err.kind === 'TIMEOUT'
        ? 'The Copilot took too long to respond. Your answers are saved — try again.'
        : err.kind === 'RATE_LIMIT'
          ? 'The Copilot is busy right now. Your answers are saved — try again in a moment.'
          : "I couldn't build that correctly. Your answers are saved — try again.";
    const code =
      err.kind === 'TIMEOUT' ? 'AI_TIMEOUT' : err.kind === 'RATE_LIMIT' ? 'AI_RATE_LIMIT' : 'AI_PROVIDER';
    throw serviceUnavailable(message, code);
  }
  throw err;
}

/** The part of a session the assumptions helper reads. */
interface AssumptionSession {
  structuredContext: string;
  initialGoalText: string;
  /** READY_TO_GENERATE means the interview itself concluded early (cap or outage). */
  status: string;
}

/** Sources that are the model guessing — neither the user answering nor old memory. */
const ASSUMED_SOURCES: ReadonlySet<string> = new Set([
  'CURRENT_SESSION_INFERENCE',
  'MODEL_INFERENCE',
]);

const LIMITED_INFORMATION_LINE =
  'Generated with limited information — the plan uses only what you told me.';

/**
 * What a plan rests on that the user never said, said out loud.
 *
 * Every line comes from something actually stored: context entries whose source
 * is an inference tier are listed verbatim (capped, so a long interview cannot
 * bury the plan in fine print, and skipping empty or structured values, which
 * do not render as a sentence). A refused readiness gate adds its one honest
 * line, and a missing deadline gets its own. Nothing here is invented.
 *
 * Stage 5 (flag ON): structured assumptions — ACTIVE records with provenance
 * SYSTEM_ASSUMPTION — come first. Unsafe assumptions never reach rendering:
 * the merge rejected them, so everything here is safe by construction.
 */
export function buildAssumptions(
  draft: { deadline: string | null },
  session: AssumptionSession | null,
  readiness: PlanReadiness | null,
  requirementState?: RequirementState | null,
): string[] {
  const assumptions: string[] = [];
  if (requirementState) {
    for (const line of renderAssumptionLines(requirementState)) {
      if (assumptions.length >= 6) break;
      assumptions.push(line);
    }
  }
  if (session) {
    const provenance = describeProvenance(parseContext(session.structuredContext, session.initialGoalText));
    for (const entry of provenance) {
      if (assumptions.length >= 6) break;
      if (!ASSUMED_SOURCES.has(entry.source)) continue;
      const { value } = entry;
      if (value === null || value === undefined || value === '' || typeof value === 'object') continue;
      assumptions.push(`${entry.key}: ${String(value)} (assumed — you didn't state this)`);
    }
  }
  if (readiness && !readiness.ready) assumptions.push(LIMITED_INFORMATION_LINE);
  if (session && session.status === 'READY_TO_GENERATE' && assumptions.length === 0 && !draft.deadline) {
    // The interview ended early (question cap or outage fallback) and nothing
    // was inferred either: say the plan is conservative rather than pretending
    // every detail was asked for.
    assumptions.push(LIMITED_INFORMATION_LINE);
  }
  if (!draft.deadline) {
    assumptions.push('No deadline was provided, so this plan focuses on steady weekly progress.');
  }
  return assumptions;
}

/**
 * The create view's routing decision, taken before any session exists.
 *
 * A high-confidence goal statement proceeds exactly as it always has. Anything
 * else — a product question, a status question, gibberish — must not silently
 * become an interview: the caller receives the routing decision plus the one
 * clarification, and the user decides. `intentAnswer: 'goal'` is the user
 * answering that clarification, and overrides the classifier entirely.
 *
 * The LLM fallback only fires when the deterministic rules return UNKNOWN, so
 * the frozen benchmark's 100 goal statements never wait on a model call.
 */
export async function routeNewSessionRequest(
  goal: string,
  intentAnswer?: 'goal' | 'question',
  llmFallback: (text: string) => Promise<CopilotIntentResult | null> = classifyIntentWithLlm,
): Promise<{ create: true } | { create: false; intent: CopilotIntent; clarification: string }> {
  if (intentAnswer === 'goal') return { create: true };
  const decision = await classifyIntent(goal, {}, llmFallback);
  if (decision.intent === 'CREATE_GOAL') return { create: true };
  return { create: false, intent: decision.intent, clarification: INTENT_CLARIFICATION };
}

export default async function copilotRoutes(app: FastifyInstance) {
  app.get('/copilot/status', { preHandler: app.requireAuth }, async (req) => {
    return { enabled: isCopilotEnabled(), resumable: await resumableSessions(req.user!.id) };
  });

  // ------------------------------------------------------------- interview

  app.post('/copilot/goal-sessions', { preHandler: app.requireAuth }, async (req, reply) => {
    throttleAi(req, reply);
    const { goal, intentAnswer } = z
      .object({
        goal: z.string().trim().min(3, 'Tell me a little more').max(2000),
        // The user's answer to the routing clarification. Absent means undecided.
        intentAnswer: z.enum(['goal', 'question']).optional(),
      })
      .parse(req.body);
    const routed = await routeNewSessionRequest(goal, intentAnswer);
    if (!routed.create) {
      // 200, not an error: the message was understood well enough to know that
      // starting an interview is wrong. Nothing was created, nothing invented.
      return { routed: false, intent: routed.intent, clarification: routed.clarification };
    }
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

    const requirementState = parseRequirementState(session.structuredContext);
    const snapshotReadiness = summarizeReadiness(requirementState, {
      questionCount: session.questionCount,
      maxQuestions: HARD_MAX_QUESTIONS,
    });
    const remaining = estimateRemainingAskable(
      evaluateAstReadiness(requirementState, {
        questionCount: session.questionCount,
        maxQuestions: HARD_MAX_QUESTIONS,
      }),
      session.questionCount,
      HARD_MAX_QUESTIONS,
    );

    return {
      sessionId: session.id,
      status: session.status,
      initialGoalText: session.initialGoalText,
      questionCount: session.questionCount,
      // Both are re-derived on demand so the snapshot always agrees with the
      // gates the interview and the generate route actually enforce.
      revision: session.revision,
      readiness: sessionReadiness(session),
      // Stage 6: the AST gate's own verdict — ready / shouldAsk / canForce are
      // deliberately separate fields, and conflicts/pending are listed.
      shouldAsk: snapshotReadiness.shouldAsk,
      canForce: canForceGenerate(session, requirementState),
      requirements: snapshotReadiness,
      estimatedTotal: session.status === 'INTERVIEWING'
        ? session.questionCount + remaining
        : session.questionCount,
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

  app.post('/copilot/goal-sessions/:id/answers', { preHandler: app.requireAuth }, async (req, reply) => {
    throttleAi(req, reply);
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

  app.post('/copilot/goal-sessions/:id/generate', { preHandler: app.requireAuth }, async (req, reply) => {
    throttleAi(req, reply);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { regenerate, force, revision } = z
      .object({
        regenerate: z.boolean().default(false),
        // The one override for the readiness gate: a user who insists on a plan
        // for an under-answered interview gets one, once at least two questions
        // were asked — with the assumptions it rests on said out loud.
        force: z.boolean().default(false),
        // The revision the caller last saw; a mismatch is a stale request.
        revision: z.number().int().nonnegative().optional(),
      })
      .parse(req.body ?? {});
    try {
      const { draft, adjustments } = await generateDraft(id, req.user!.id, regenerate, {
        force,
        revision,
      });
      const session = await loadSession(id, req.user!.id);
      const readiness = sessionReadiness(session);
      const serialized = serializeDraft(draft);
      const requirementState = parseRequirementState(session.structuredContext);
      return {
        draft: serialized,
        adjustments,
        readiness,
        missingDimensions: readiness.ready ? [] : readiness.missing,
        assumptions: buildAssumptions(serialized, session, readiness, requirementState),
      };
    } catch (err) {
      toUserFacing(err);
    }
  });

  app.get('/copilot/goal-drafts/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const draft = serializeDraft(await loadDraft(id, req.user!.id));
    // The draft's own session is read directly, not through loadSession: an
    // expired interview must not break reviewing the plan it produced. A draft
    // with no session (or a deleted one) simply has no provenance to assume from.
    const session = draft.sessionId
      ? await prisma.copilotSession.findUnique({ where: { id: draft.sessionId } })
      : null;
    const requirementState = session
      ? parseRequirementState(session.structuredContext)
      : null;
    return { draft, assumptions: buildAssumptions(draft, session, null, requirementState) };
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

    // Stage 4 canonical path: through the registry — schema, authorization,
    // idempotency claim, transaction and audit in one generic pipeline. The
    // client's task ids are required on this path (the review UI always has
    // them).
    const outcome = await executeCapability<{ draft: unknown }>(
      { userId: req.user!.id, confirmed: true, correlationId: randomUUID() },
      {
        capability: 'goal.apply_manual_edit',
        input: {
          draftId: id,
          title: body.title,
          description: body.description,
          deadline: body.deadline ?? undefined,
          visibility: body.visibility,
          tasks: body.tasks?.map((task) => ({
            id: task.id ?? '',
            title: task.title,
            description: task.description,
            recurrenceType: task.recurrenceType,
            recurrenceConfig: task.recurrenceConfig,
            estimatedMinutes: task.estimatedMinutes ?? null,
            preferredTime: task.preferredTime ?? null,
            reason: task.reason,
            progression: null,
          })),
        },
      },
    );
    return { draft: serializeDraft(unwrapCapability(outcome).result.draft as never) };
  });

  app.post('/copilot/goal-drafts/:id/copilot-edit', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { message, operationId } = z
      .object({ message: copilotMessage, operationId: z.string().optional() })
      .parse(req.body);
    throttleAi(req, reply);
    try {
      // Stage 4 canonical path: the model call runs in the capability's prepare
      // phase, then the prepared patch is applied inside the claim transaction.
      // A replay returns the committed result without a model call.
      const outcome = await executeCapability<{ draft: unknown; assistantMessage: string; applied: string[] }>(
        { userId: req.user!.id, confirmed: true, correlationId: randomUUID() },
        { capability: 'goal.apply_ai_edit', input: { draftId: id, message }, operationId },
      );
      const { result, replayed: editReplayed } = unwrapCapability(outcome);
      return {
        draft: serializeDraft(result.draft as never),
        assistantMessage: result.assistantMessage,
        applied: result.applied,
        replayed: editReplayed,
      };
    } catch (err) {
      toUserFacing(err);
    }
  });

  /** The only endpoint that creates real Phase 1 entities. */
  app.post('/copilot/goal-drafts/:id/confirm', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const operationId = typeof body.operationId === 'string' ? body.operationId : undefined;
    // Stage 4 canonical path: the whole confirm sequence (claim, goal, tasks,
    // ladders, occurrences) commits atomically with the idempotency claim; a
    // replay returns the same goal id.
    const outcome = await executeCapability<{ goalId: string; alreadyCreated: boolean }>(
      { userId: req.user!.id, confirmed: true, correlationId: randomUUID() },
      { capability: 'goal.confirm_from_draft', input: { draftId: id }, operationId },
    );
    const { result, replayed } = unwrapCapability(outcome);
    return {
      goalId: result.goalId,
      alreadyCreated: result.alreadyCreated || replayed,
    };
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

  app.post('/goals/:id/copilot', { preHandler: app.requireAuth }, async (req, reply) => {
    throttleAi(req, reply);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { message, history } = z.object({
      message: copilotMessage,
      history: goalCopilotHistorySchema,
    }).parse(req.body);
    try {
      return await askGoalCopilot(id, req.user!.id, message, history);
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
