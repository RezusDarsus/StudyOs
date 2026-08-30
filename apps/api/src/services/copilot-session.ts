import type { CopilotSession } from '@prisma/client';
import { chatJson } from '../ai/client.js';
import { AiProviderError } from '../ai/provider.js';
import {
  PROMPT_VERSIONS,
  interviewSystemPrompt,
  interviewUserPrompt,
} from '../ai/prompts.js';
import {
  interviewResponseSchema,
  type CopilotQuestion,
  type InterviewResponse,
} from '../ai/schemas.js';
import {
  promoteMultiSelect,
  ensureCustomAnswer,
  assessPlanningSufficiency,
  questionBudget,
  essentialFallbackQuestion,
  questionDomainMismatch,
  questionTopic,
  redundancyReason,
  type QuestionTopic,
} from '../ai/interview-plan.js';
import { evaluatePlanReadiness, type PlanReadiness, type PlanningDimension } from '../ai/readiness.js';
import {
  applyModelExtraction,
  createContext,
  currentSessionFacts,
  describeProvenance,
  inferredValues,
  literalAnswers,
  parseContext,
  recordAnswer,
  serializeContext,
  toPlainObject,
} from '../ai/context.js';
import { memoryGateCategory } from '../ai/category.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { getPreferencesForPrompt } from './preferences.js';
import { recordEvent } from './copilot-analytics.js';
import { parseExplicitGoalConstraints } from '../ai/goal-constraints.js';
import { RESOLVE_FREQUENCY_CONFLICT_ID, withCorrectionSignal } from '../ai/frequency-conflict.js';
import { classifyIntentDeterministic, PRODUCT_HELP_STUB } from '../ai/intent-router.js';
import { todayIn } from '../domain/dates.js';

// Interview limits are enforced by the backend, not by trusting the model to
// stop. A chatty model cannot trap the user in an endless questionnaire.
//
// The limit that binds is the per-request budget from ai/interview-plan.ts, which is
// smaller for someone who already said what they want. This is the absolute ceiling
// on top of it — a backstop against a future budget being widened by mistake, not
// something a normal run ever reaches.
export const HARD_MAX_QUESTIONS = 10;

const SESSION_TTL_HOURS = 48;
/** Only the tail of the transcript is sent — cost control, and it is not the source of truth. */
const TRANSCRIPT_WINDOW = 12;

export interface InterviewTurn {
  sessionId: string;
  status: string;
  assistantMessage: string;
  question: CopilotQuestion | null;
  questionCount: number;
  estimatedTotal: number;
  context: Record<string, unknown>;
  /** Where each context value came from — for debugging and the quality harness. */
  provenance: Array<{ key: string; value: unknown; source: string; questionId: string | null }>;
  canGenerate: boolean;
  /** The deterministic readiness gate's verdict on this turn. */
  readiness: PlanReadiness;
  /** Bumped on every applied turn; a generate request quotes it to prove freshness. */
  revision: number;
}

function safeParse(raw: string): { id?: string; prompt?: string } | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** The session belongs to the caller, or it does not exist as far as they know. */
export async function loadSession(sessionId: string, userId: string) {
  const session = await prisma.copilotSession.findUnique({
    where: { id: sessionId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!session) throw notFound('That Copilot session no longer exists');
  if (session.userId !== userId) throw notFound('That Copilot session no longer exists');
  if (session.expiresAt.getTime() < Date.now()) {
    throw badRequest('That Copilot session has expired. Start a new one.', 'SESSION_EXPIRED');
  }
  return session;
}

type SessionMessage = { role: string; content: string; structuredPayload?: string | null };

/**
 * Pair each asked question with the answer it received.
 *
 * Handing the model explicit Q&A pairs is what stops it re-asking something in
 * slightly different words — the raw transcript alone was not enough.
 */
export function answeredPairs(messages: SessionMessage[]) {
  const questions = new Map<string, string>();
  const pairs: Array<{ questionId: string; prompt: string; answer: string }> = [];

  for (const message of messages) {
    if (!message.structuredPayload) continue;
    let payload: { id?: string; prompt?: string; questionId?: string; answer?: unknown };
    try {
      payload = JSON.parse(message.structuredPayload);
    } catch {
      continue;
    }
    if (message.role === 'assistant' && payload.id) {
      questions.set(payload.id, payload.prompt ?? '');
    }
    if (message.role === 'user' && payload.questionId) {
      pairs.push({
        questionId: payload.questionId,
        prompt: questions.get(payload.questionId) ?? '',
        answer: formatAnswer(payload.answer),
      });
    }
  }
  return pairs;
}

/**
 * Every subject already put to the user, read back off the transcript.
 *
 * Derived rather than stored: the asked question ids are persisted but an id says
 * nothing about what it asked, and the assistant messages already carry the full
 * question. One less column to keep in step with reality.
 */
export function askedTopics(messages: SessionMessage[]): QuestionTopic[] {
  const topics: QuestionTopic[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.structuredPayload) continue;
    const payload = safeParse(message.structuredPayload) as
      | { prompt?: string; type?: CopilotQuestion['type']; options?: string[] }
      | null;
    if (!payload?.prompt) continue;
    const topic = questionTopic(payload.prompt, payload.type, payload.options);
    if (!topics.includes(topic)) topics.push(topic);
  }
  return topics;
}

/** Which question subject settles which readiness dimension. */
const DIMENSION_TOPIC: Record<PlanningDimension, QuestionTopic> = {
  DESIRED_OUTCOME: 'TARGET',
  WEEKLY_CAPACITY: 'FREQUENCY',
  TIMEFRAME: 'DEADLINE',
  BASELINE: 'EXPERIENCE',
  CONSTRAINTS: 'CONSTRAINT',
  PREFERENCES: 'FORMAT',
};

/**
 * The readiness gate for a stored session.
 *
 * The same evaluation applyTurn enforces, computed on demand — the session
 * snapshot and the generate route must agree with the interview about whether
 * there is enough to plan from.
 */
export function sessionReadiness(session: {
  initialGoalText: string;
  structuredContext: string;
  messages: SessionMessage[];
  questionCount: number;
}): PlanReadiness {
  return evaluatePlanReadiness({
    goalText: session.initialGoalText,
    context: toPlainObject(parseContext(session.structuredContext, session.initialGoalText)),
    answeredTopics: askedTopics(session.messages),
    questionCount: session.questionCount,
  });
}

async function runInterviewTurn(
  session: CopilotSession & { messages: SessionMessage[] },
): Promise<{ result: InterviewResponse; preferences: Array<{ key: string; value: string }> }> {
  const context = parseContext(session.structuredContext, session.initialGoalText);
  const asked = parseJson<string[]>(session.askedQuestionIds, []);

  // Which memories are visible is decided from the user's own words, never from
  // the category the model reported — see ai/category.ts for why.
  const gate = memoryGateCategory(session.initialGoalText, session.category);
  const preferences = await getPreferencesForPrompt(session.userId, gate.category);

  // Quote the model the same budget applyTurn will hold it to. It is only advice
  // either way, but advice that contradicts the enforcement produces a model that
  // asks a fifth question and a backend that throws it away.
  const budget = questionBudget(session.initialGoalText);

  let result: InterviewResponse;
  try {
    result = await chatJson(
      {
      purpose: 'INTERVIEW',
      promptVersion: PROMPT_VERSIONS.interview,
      userId: session.userId,
      sessionId: session.id,
      // Interview turns are simple; reasoning would only add latency.
      thinking: false,
      temperature: 0.4,
      maxTokens: 900,
      // Measured: median 2.9s, p90 7.6s, p99 18.5s. A 20s cap sat exactly on p99
      // and killed calls that were about to succeed; 25s still catches a genuine
      // hang (the observed outlier was 44s) without clipping the tail.
      // This is an interactive button, so never leave it spinning through two
      // minute-long attempts. Normal responses finish well inside this budget;
      // a provider outage falls back to a plan the user can edit.
      timeoutMs: 6_000,
      retryTransient: false,
      messages: [
        {
          role: 'system',
          content: interviewSystemPrompt({
            questionCount: session.questionCount,
            minQuestions: budget.min,
            maxQuestions: budget.max,
            settled: budget.stated,
          }),
        },
        {
          role: 'user',
          content: interviewUserPrompt({
            initialGoal: session.initialGoalText,
            context: toPlainObject(context),
            askedQuestionIds: asked,
            answered: answeredPairs(session.messages),
            transcript: session.messages.slice(-TRANSCRIPT_WINDOW),
            knownPreferences: preferences,
          }),
        },
      ],
      },
      interviewResponseSchema,
    );
  } catch (err) {
    if (!(err instanceof AiProviderError) || !['BAD_RESPONSE', 'TIMEOUT'].includes(err.kind)) throw err;
    const priorTopics = askedTopics(session.messages);
    const sufficiency = assessPlanningSufficiency(session.initialGoalText, priorTopics);
    if (sufficiency.enough) {
      result = {
          state: 'READY_TO_GENERATE',
          assistantMessage: "That's enough to build a conservative plan.",
          question: null,
          category: session.category as InterviewResponse['category'],
        };
    } else {
      const fallbackQuestion = essentialFallbackQuestion(
        session.initialGoalText,
        [...budget.stated, ...priorTopics],
        sufficiency.highestImpactMissing,
      );
      result = {
          state: 'NEEDS_MORE_INFORMATION',
          assistantMessage: fallbackQuestion.prompt,
          question: fallbackQuestion,
          category: session.category as InterviewResponse['category'],
        };
    }
  }
  return { result, preferences };
}

/**
 * Apply the model's turn to the session, enforcing the backend's own limits on
 * how the interview may progress.
 */
async function applyTurn(
  session: CopilotSession & { messages: SessionMessage[] },
  result: InterviewResponse,
  injectedPreferences: Array<{ key: string; value: string }> = [],
): Promise<InterviewTurn> {
  const context = parseContext(session.structuredContext, session.initialGoalText);
  applyModelExtraction(
    context,
    result.extractedContext as Record<string, unknown> | undefined,
    injectedPreferences,
    (result.corrections ?? {}) as Record<string, unknown>,
  );
  const asked = parseJson<string[]>(session.askedQuestionIds, []);

  let question = result.question ?? null;
  let state = result.state;

  // How much interview this request has earned. Someone who opened with "read 20
  // pages every evening on weekdays" gets a plan, not a questionnaire.
  const budget = questionBudget(session.initialGoalText);
  const priorTopics = askedTopics(session.messages);
  // The readiness gate, computed from the user's own words and answers so far.
  // This is the product decision layer, independent of what the model claims.
  const readiness = evaluatePlanReadiness({
    goalText: session.initialGoalText,
    context: toPlainObject(context),
    answeredTopics: priorTopics,
    questionCount: session.questionCount,
  });
  // Detailed prompts generate directly even when the model tries to pad the
  // interview — but only when the gate agrees there is enough to plan from.
  if (session.questionCount === 0 && readiness.ready) {
    question = null;
    state = 'READY_TO_GENERATE';
  }
  if (question && questionDomainMismatch(question, session.initialGoalText)) {
    question = null;
    state = 'READY_TO_GENERATE';
  }

  // For a small set of logically blocking ambiguities, the first question must
  // address the blocker. A generic preference question cannot resolve it.
  let forcedBlockingQuestion = false;
  const text = session.initialGoalText.toLowerCase();
  const currencyTokens=[...new Set([
    ...[...session.initialGoalText.matchAll(/\b(USD|EUR|GBP|GEL)\b/gi)].map((match)=>match[1].toUpperCase()),
    ...(session.initialGoalText.includes('$')?['USD']:[]),
    ...(session.initialGoalText.includes('€')?['EUR']:[]),
    ...(session.initialGoalText.includes('£')?['GBP']:[]),
  ])];
  if (session.questionCount===0 && currencyTokens.length>1) {
    question={
      id:'exchange_rate_assumption',type:'FREE_TEXT',optional:false,
      prompt:`What ${currencyTokens.join('/')} exchange rate should the plan use as a changeable planning assumption?`,
      allowCustomAnswer:true,
    };
    state='NEEDS_MORE_INFORMATION';
    forcedBlockingQuestion=true;
  } else if (budget.requiresClarification && session.questionCount === 0) {
    // The deterministic conflict detector — requested weekly days exceeding the
    // named/allowed days — is the general trigger. A contradiction no preference
    // question can resolve must be the first thing asked about, regardless of
    // how the goal happened to word it.
    const conflict = parseExplicitGoalConstraints(text, todayIn('UTC'));
    if (conflict.exactWeekly !== undefined && conflict.allowedDays?.length
        && conflict.exactWeekly > conflict.allowedDays.length) {
      question = {
        id: 'resolve_frequency_conflict', type: 'FREE_TEXT', optional: false,
        prompt: `You asked for ${conflict.exactWeekly} different days in the week, but only ${conflict.allowedDays.length} day(s) are available. Would you like to reduce the frequency, allow two sessions on one day, or make another weekday available?`,
        allowCustomAnswer: true,
      };
      state = 'NEEDS_MORE_INFORMATION';
      forcedBlockingQuestion = true;
    } else if (/budget/.test(text) && /contractor/.test(text) && /move out|occupied/.test(text)) {
      question = {
        id: 'resolve_remodel_decisions', type: 'FREE_TEXT', optional: false,
        prompt: 'What budget, contractor status, and move-out or occupied-home constraints should the remodel plan use?',
        allowCustomAnswer: true,
      };
      state = 'NEEDS_MORE_INFORMATION';
      forcedBlockingQuestion = true;
    }
  }

  // The model does not get to ask the same thing twice — and "the same thing" means
  // the same subject, not the same id. Three runs of "which days suit you?" under
  // three fresh ids is what the id check alone let through, and the user answered
  // them differently each time, so the plan was built on a contradiction.
  const redundant = question && !forcedBlockingQuestion
    ? redundancyReason(question, {
        askedIds: asked,
        askedTopics: priorTopics,
        stated: budget.stated,
      })
    : null;
  if (redundant) question = null;

  // The model does not get to declare the interview finished before the
  // readiness gate agrees. What it may not end, the gate downgrades — and the
  // hard cap below still absolutely terminates the interview, so a user who
  // keeps answering without ever satisfying the gate is not trapped forever.
  if (state === 'READY_TO_GENERATE' && !readiness.ready) {
    state = 'NEEDS_MORE_INFORMATION';
  }
  if (session.questionCount >= Math.min(budget.max, HARD_MAX_QUESTIONS)) {
    state = 'READY_TO_GENERATE';
    question = null;
  }
  let fallbackQuestionInjected = false;
  if (!question && state === 'NEEDS_MORE_INFORMATION') {
    if (!readiness.ready) {
      // Aim the deterministic fallback at the first unsatisfied blocking
      // dimension, so the next answer is one that actually unblocks planning.
      const firstMissing = readiness.missing[0] ?? null;
      question = essentialFallbackQuestion(
        session.initialGoalText,
        [...budget.stated, ...priorTopics],
        firstMissing ? DIMENSION_TOPIC[firstMissing] : null,
      );
      fallbackQuestionInjected = true;
    } else {
      state = 'READY_TO_GENERATE';
    }
  }

  // Let the user give every answer that is true for them. The model is asked to do
  // this itself and does not reliably: "what time of day do you read?" came back as
  // a radio group, forcing someone who reads morning *and* night to discard half
  // their answer.
  if (question) question = promoteMultiSelect(question);
  // And never trapped by the options it did offer — every single-select can be
  // answered in the user's own words, whatever the model claimed.
  if (question) question = ensureCustomAnswer(question);

  const nextCount = question ? session.questionCount + 1 : session.questionCount;
  const nextAsked = question ? [...asked, question.id] : asked;
  const status = state === 'READY_TO_GENERATE' ? 'READY_TO_GENERATE' : 'INTERVIEWING';

  // A suppressed question must not leave its message behind. Without this the user
  // saw the question text with nothing to answer it with. Questions can be
  // suppressed for several reasons (redundancy, readiness, domain mismatch or the
  // question cap), so key this off the final question rather than one reason.
  const questionWasSuppressed = result.question !== null && question === null;
  const assistantMessage = fallbackQuestionInjected
    ? question?.prompt ?? 'I need a little more detail before I can make this plan genuinely useful.'
    : questionWasSuppressed && state === 'READY_TO_GENERATE'
    ? "That's everything I need."
    : result.assistantMessage;

  await prisma.copilotMessage.create({
    data: {
      sessionId: session.id,
      role: 'assistant',
      content: assistantMessage,
      structuredPayload: question ? JSON.stringify(question) : null,
    },
  });

  const updated = await prisma.copilotSession.update({
    where: { id: session.id },
    data: {
      status,
      structuredContext: serializeContext(context),
      askedQuestionIds: JSON.stringify(nextAsked),
      questionCount: nextCount,
      category: result.category ?? session.category,
      // Every applied turn moves the interview on. A generate request that
      // quotes an older revision is planning from a picture that no longer
      // exists, and is refused for exactly that reason.
      revision: { increment: 1 },
    },
  });

  return {
    sessionId: updated.id,
    status: updated.status,
    assistantMessage,
    question,
    questionCount: nextCount,
    // The budget's ceiling, which is now actually enforced, so "3 of ~5" can no
    // longer become 9. Ending early is a pleasant surprise; a bar that moves its own
    // goalpost upward is the thing being fixed. With nothing outstanding the total is
    // what was asked, which lets the bar finish rather than stall short.
    estimatedTotal: question ? budget.max : nextCount,
    context: toPlainObject(context),
    provenance: describeProvenance(context),
    canGenerate: status === 'READY_TO_GENERATE',
    readiness,
    revision: updated.revision,
  };
}

/**
 * The question the interview is currently waiting on, read off the transcript.
 *
 * The same rule the session snapshot uses: the last assistant message that
 * carries a structured question, and only while the session is still
 * interviewing. Null otherwise — there is nothing to preserve.
 */
function pendingQuestion(
  session: CopilotSession & { messages: SessionMessage[] },
): CopilotQuestion | null {
  if (session.status !== 'INTERVIEWING') return null;
  const last = [...session.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.structuredPayload);
  if (!last?.structuredPayload) return null;
  try {
    return JSON.parse(last.structuredPayload) as CopilotQuestion;
  } catch {
    return null;
  }
}

/**
 * A turn that changed nothing.
 *
 * Used by the interruption path: the transcript, the question count and the
 * revision are untouched, the pending question is handed back exactly as it
 * was, and the assistant message is the interruption reply. A generate request
 * quoting the pre-interruption revision stays valid, because nothing moved.
 */
function interruptionTurn(
  session: CopilotSession & { messages: SessionMessage[] },
  question: CopilotQuestion,
  assistantMessage: string,
): InterviewTurn {
  const context = parseContext(session.structuredContext, session.initialGoalText);
  return {
    sessionId: session.id,
    status: session.status,
    assistantMessage,
    question,
    questionCount: session.questionCount,
    estimatedTotal: questionBudget(session.initialGoalText).max,
    context: toPlainObject(context),
    provenance: describeProvenance(context),
    canGenerate: session.status === 'READY_TO_GENERATE',
    readiness: sessionReadiness(session),
    revision: session.revision,
  };
}

export async function startSession(userId: string, goalText: string): Promise<InterviewTurn> {
  const session = await prisma.copilotSession.create({
    data: {
      userId,
      initialGoalText: goalText.trim(),
      // goalIntent is written once here and is not rewritable by anything later.
      structuredContext: serializeContext(createContext(goalText.trim())),
      expiresAt: new Date(Date.now() + SESSION_TTL_HOURS * 3600_000),
      messages: { create: { role: 'user', content: goalText.trim() } },
    },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });

  await recordEvent({ userId, type: 'SESSION_STARTED', sessionId: session.id });

  try {
    const { result, preferences } = await runInterviewTurn(session);
    return applyTurn(session, result, preferences);
  } catch (err) {
    if (!(err instanceof AiProviderError) || err.kind === 'AUTH') throw err;
    return applyTurn(session, unavailableFallback());
  }
}

export async function answerQuestion(
  sessionId: string,
  userId: string,
  input: { questionId: string; answer?: unknown; skipped?: boolean },
): Promise<InterviewTurn> {
  const session = await loadSession(sessionId, userId);
  if (session.status !== 'INTERVIEWING' && session.status !== 'READY_TO_GENERATE') {
    throw badRequest('This session is no longer accepting answers', 'SESSION_CLOSED');
  }

  // Interruption support: a product-mechanics question typed where an interview
  // answer is expected ("What happens if I miss one?") must not consume the
  // turn and kill the interview. The deterministic classifier decides, the
  // pending question is returned untouched, and the honest reply says real
  // product answers are coming. Only PRODUCT_HELP interrupts — a status
  // question is still a legitimate free-text answer.
  const pending = pendingQuestion(session);
  if (
    !input.skipped &&
    pending &&
    typeof input.answer === 'string' &&
    classifyIntentDeterministic(input.answer).intent === 'PRODUCT_HELP'
  ) {
    return interruptionTurn(session, pending, PRODUCT_HELP_STUB);
  }

  const answerText = input.skipped ? '(skipped)' : formatAnswer(input.answer);

  await prisma.copilotMessage.create({
    data: {
      sessionId: session.id,
      role: 'user',
      content: answerText,
      structuredPayload: JSON.stringify({ questionId: input.questionId, answer: input.answer }),
    },
  });

  // Record the literal answer at the highest authority there is. It does not
  // depend on the model choosing to extract it, and nothing weaker can overwrite
  // it. A later answer to the same question replaces the earlier one, so a
  // correction works without special-casing.
  if (!input.skipped && input.answer !== null && input.answer !== undefined) {
    const context = parseContext(session.structuredContext, session.initialGoalText);
    const askedQuestion = [...session.messages]
      .reverse()
      .map((m) => (m.structuredPayload ? safeParse(m.structuredPayload) : null))
      .find((p) => p?.id === input.questionId);

    // A frequency-conflict resolution is stored with the correction signal its
    // words imply ("3" → "Make it 3 days per week"): the transcript keeps the
    // raw answer, but the recorded value must read as the deliberate
    // re-schedule it is, so the contradiction detector accepts it and
    // parseExplicitGoalConstraints applies it answer-last as the plan total.
    recordAnswer(context, {
      key: input.questionId,
      questionId: input.questionId,
      question: askedQuestion?.prompt,
      value: input.questionId === RESOLVE_FREQUENCY_CONFLICT_ID
        ? withCorrectionSignal(input.answer)
        : input.answer,
    });
    await prisma.copilotSession.update({
      where: { id: session.id },
      data: { structuredContext: serializeContext(context) },
    });
  }

  const refreshed = await prisma.copilotSession.findUniqueOrThrow({
    where: { id: session.id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });

  await recordEvent({ userId, type: 'QUESTION_ANSWERED', sessionId: session.id });

  try {
    const { result, preferences } = await runInterviewTurn(refreshed);
    return applyTurn(refreshed, result, preferences);
  } catch (err) {
    if (!(err instanceof AiProviderError) || err.kind === 'AUTH') throw err;
    return applyTurn(refreshed, unavailableFallback());
  }
}

function unavailableFallback(): InterviewResponse {
  return {
    state: 'READY_TO_GENERATE',
    assistantMessage:
      'I have enough to create a simple starting plan. You can edit every detail before creating it.',
    question: null,
    extractedContext: {},
    corrections: {},
    category: null,
  };
}

/** Human-readable rendering of a structured answer, for the transcript. */
export function formatAnswer(answer: unknown): string {
  if (Array.isArray(answer)) return answer.map((a) => String(a)).join(', ');
  if (answer === null || answer === undefined) return '(no answer)';
  return String(answer);
}

export async function cancelSession(sessionId: string, userId: string) {
  const session = await prisma.copilotSession.findUnique({ where: { id: sessionId } });
  if (!session) throw notFound('Session not found');
  if (session.userId !== userId) throw forbidden();
  await prisma.copilotSession.update({ where: { id: sessionId }, data: { status: 'CANCELLED' } });
  await recordEvent({ userId, type: 'SESSION_CANCELLED', sessionId });
}

/** Unfinished sessions the user could pick back up. */
export async function resumableSessions(userId: string) {
  return prisma.copilotSession.findMany({
    where: {
      userId,
      status: { in: ['INTERVIEWING', 'READY_TO_GENERATE', 'DRAFT_GENERATED'] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { updatedAt: 'desc' },
    take: 5,
    select: {
      id: true,
      initialGoalText: true,
      status: true,
      questionCount: true,
      updatedAt: true,
    },
  });
}
