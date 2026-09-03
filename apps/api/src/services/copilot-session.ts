import type { CopilotSession } from '@prisma/client';
import { chatJson } from '../ai/client.js';
import { AiProviderError } from '../ai/provider.js';
import {
  PROMPT_VERSIONS,
  interviewSystemPrompt,
  interviewUserPrompt,
} from '../ai/prompts.js';
import {
  type CopilotQuestion,
} from '../ai/schemas.js';
import { interviewResponseSchemaAst, type InterviewResponseAst } from '../ai/schemas.js';
import { requirementFragmentSchema } from '../ai/requirements/extract-schema.js';
import {
  promoteMultiSelect,
  ensureCustomAnswer,
  questionTopic,
  type QuestionTopic,
} from '../ai/interview-plan.js';
import {
  applyModelExtraction,
  createContext,
  currentSessionFacts,
  describeProvenance,
  inferredValues,
  literalAnswers,
  parseContext,
  parseRequirementState,
  recordAnswer,
  serializeContext,
  toPlainObject,
} from '../ai/context.js';
import { classifyIntentDeterministic, PRODUCT_HELP_STUB } from '../ai/intent-router.js';
import {
  emptyRequirementState,
  estimateRemainingAskable,
  evaluateAstReadiness,
  ingestExtraction,
  markExtractionFailed,
  toPlanReadiness,
  deterministicGapResolution,
  type PlanReadiness,
  type RequirementState,
} from '../ai/requirements/index.js';
import type { RequirementFragment } from '../ai/requirements/extract-schema.js';
import { memoryGateCategory } from '../ai/category.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { getPreferencesForPrompt } from './preferences.js';
import { recordEvent } from './copilot-analytics.js';
import { REQUIREMENT_AST_EXTRACTION_INSTRUCTIONS } from '../ai/prompts.js';

// Interview limits are enforced by the backend, not by trusting the model to
// stop. A chatty model cannot trap the user in an endless questionnaire.
//
// HARD_MAX_QUESTIONS is the absolute ceiling — the only question-count rule
// in the system. Readiness is never a function of the count (the AST gate
// owns it); the cap exists so a user who keeps answering without ever
// satisfying the gate is not trapped forever.
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
  /** Stage 5: a HIGH gap remains and the budget allows one more question. */
  shouldAsk?: boolean;
  /** Rev.3/Rev.4: the server-owned force policy — same predicate as the
   * accepted-force rule in the generate route. The client never decides. */
  canForce?: boolean;
  /** Rev.3 (R1): true when the current turn's extraction failed — the state
   * is stale; generation is refused until the next successful ingest. */
  extractionFailed?: boolean;
  /** Stage 5: compact AST state summary for the client. */
  requirements?: {
    ready: boolean;
    shouldAsk: boolean;
    activeRecords: number;
    conflicts: Array<{ kind: string; description: string }>;
    pending: number;
    missing: string[];
  };
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

// -------------------------------------------------------------- Stage 5 (AST)

/** The interview turn number of a session: 0 for the opening, N after N answers. */
function astGroundingFor(
  session: { initialGoalText: string; questionCount: number },
  answer?: { questionId: string; text: string },
): { turn: number; message?: string; answer?: { questionId: string; text: string }; at: string } {
  const at = new Date().toISOString();
  if (session.questionCount === 0) {
    return { turn: 0, message: session.initialGoalText, at };
  }
  return { turn: session.questionCount, answer, at };
}

/** Compact AST summary for API payloads. */
function requirementsSummary(
  state: RequirementState,
  questionCount: number,
): NonNullable<InterviewTurn['requirements']> {
  const readiness = evaluateAstReadiness(state, {
    questionCount,
    maxQuestions: HARD_MAX_QUESTIONS,
  });
  return {
    ready: readiness.ready,
    shouldAsk: readiness.shouldAsk,
    activeRecords: state.records.filter((r) => r.status === 'ACTIVE').length,
    conflicts: readiness.conflicts.map((c) => ({ kind: c.kind, description: c.description })),
    pending: readiness.pending.length,
    missing: readiness.missing,
  };
}

function appendRequirementsInstructions(systemPrompt: string): string {
  return `${systemPrompt}\n\n${REQUIREMENT_AST_EXTRACTION_INSTRUCTIONS}`;
}

/**
 * The readiness gate for a stored session — Stage-6 canonical: derived from
 * the authoritative AST (ACTIVE atoms only), never from question counting or
 * re-parsed prose. The session snapshot and the generate route share this,
 * so the gates can never disagree.
 */
export function sessionReadiness(session: {
  initialGoalText: string;
  structuredContext: string;
  messages: SessionMessage[];
  questionCount: number;
}): PlanReadiness {
  const state = parseRequirementState(session.structuredContext);
  const ast = evaluateAstReadiness(state, {
    questionCount: session.questionCount,
    maxQuestions: HARD_MAX_QUESTIONS,
  });
  return toPlanReadiness(ast);
}

/**
 * Canonical byte form of a requirement state for equality checks:
 * object keys sorted deterministically, so two parses of the same payload
 * compare equal regardless of property insertion order.
 */
function canonicalState(state: RequirementState): string {
  const sortDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sortDeep(v)]),
      );
    }
    return value;
  };
  return JSON.stringify(sortDeep(state));
}

async function runInterviewTurn(
  session: CopilotSession & { messages: SessionMessage[] },
): Promise<{
  result: InterviewResponseAst | null;
  preferences: Array<{ key: string; value: string }>;
  providerFailed: boolean;
}> {
  const context = parseContext(session.structuredContext, session.initialGoalText);
  const asked = parseJson<string[]>(session.askedQuestionIds, []);

  // Which memories are visible is decided from the user's own words, never from
  // the category the model reported — see ai/category.ts for why.
  const gate = memoryGateCategory(session.initialGoalText, session.category);
  const preferences = await getPreferencesForPrompt(session.userId, gate.category);

  const systemPrompt = appendRequirementsInstructions(
    interviewSystemPrompt({
      questionCount: session.questionCount,
      minQuestions: 0,
      maxQuestions: HARD_MAX_QUESTIONS,
      settled: [],
    }),
  );

  try {
    const result = (await chatJson(
      {
        purpose: 'INTERVIEW',
        promptVersion: PROMPT_VERSIONS.interview,
        userId: session.userId,
        sessionId: session.id,
        // Interview turns are simple; reasoning would only add latency.
        thinking: false,
        temperature: 0.4,
        maxTokens: 1400,
        // The cap must sit ABOVE the provider's observed latency tail, or it
        // kills calls that were about to succeed. History: 25s was calibrated
        // to a 44s outlier; b985069 then raised it to 60s because NVIDIA can
        // take longer than 25s under normal load; f6eb683 later dropped it to
        // 6s while tuning fallback latency, which made EVERY interview turn
        // time out (P1 — "I want to read more" failed 5/5) with the provider
        // perfectly healthy. Re-measured 2026-09-02: median ~12s, p90 ~34s,
        // p95 ~40s, max 47s. 60s covers the whole observed tail, matches the
        // goal-chat calls, and a timeout is a single bounded wait (retryTransient
        // is false; the second attempt exists only for schema repair), inside
        // the "never leave it spinning through two minute-long attempts"
        // ceiling and far under nginx's 300s. Never lower this without new
        // measurements.
        timeoutMs: 60_000,
        retryTransient: false,
        messages: [
          { role: 'system', content: systemPrompt },
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
      interviewResponseSchemaAst,
      // Model budget: one extraction/gap call, at most ONE schema repair. No
      // uncontrolled model loops.
      { maxAttempts: 2 },
    )) as InterviewResponseAst;
    return { result, preferences, providerFailed: false };
  } catch (err) {
    // R1 containment: an extraction failure is surfaced as the typed provider
    // error it is (after the bounded budget). The caller marks the state stale
    // and never concludes from the pre-turn AST.
    if (!(err instanceof AiProviderError) || !['BAD_RESPONSE', 'TIMEOUT'].includes(err.kind)) throw err;
    return { result: null, preferences, providerFailed: true };
  }
}

/**
 * The one turn applier: deterministic merge of the extraction fragment into
 * the RequirementState, the AST gate, deterministic question selection, and
 * persistence. `response === null` (or `extractionFailed`) marks a failed
 * extraction — the state is stale for generation until the next successful
 * ingest (R1).
 */
async function applyTurn(
  session: CopilotSession & { messages: SessionMessage[] },
  input: {
    /** The full model response, or null when extraction failed. */
    response: InterviewResponseAst | null;
    injectedPreferences?: Array<{ key: string; value: string }>;
    currentAnswer?: { questionId: string; text: string };
    /** Force the stale path even when a fragment exists (deterministic-only turn). */
    extractionFailed?: boolean;
    assistantMessageOverride?: string;
  },
): Promise<InterviewTurn> {
  const context = parseContext(session.structuredContext, session.initialGoalText);
  applyModelExtraction(
    context,
    input.response?.extractedContext as Record<string, unknown> | undefined,
    input.injectedPreferences ?? [],
    (input.response?.corrections ?? {}) as Record<string, unknown>,
  );
  const asked = parseJson<string[]>(session.askedQuestionIds, []);

  // Deterministic merge: atoms, groups, pending ambiguities and grounded
  // unmodeled evidence — the single source of planning truth. meta marks the
  // state fresh or stale (R1).
  const existing = parseRequirementState(session.structuredContext);
  const grounding = astGroundingFor(session, input.currentAnswer);
  let requirementState: RequirementState;
  if (input.response === null || input.extractionFailed) {
    requirementState = markExtractionFailed(existing);
  } else {
    requirementState = ingestExtraction(existing, input.response.requirements, grounding).state;
  }
  context.requirements = requirementState;

  // ---- AST gate (the only decision layer)
  const astReadiness = evaluateAstReadiness(requirementState, {
    questionCount: session.questionCount,
    maxQuestions: HARD_MAX_QUESTIONS,
  });
  const readiness = toPlanReadiness(astReadiness);

  let question: CopilotQuestion | null = null;
  let state: 'INTERVIEWING' | 'READY_TO_GENERATE' = 'INTERVIEWING';
  let assistantMessage = input.assistantMessageOverride ?? input.response?.assistantMessage ?? '';

  if (input.response === null || input.extractionFailed) {
    // R1: a failed extraction can never conclude. The pending question is
    // re-presented; a generate request is refused until a successful ingest.
    question = pendingQuestion(session);
    state = 'INTERVIEWING';
    assistantMessage =
      input.assistantMessageOverride ??
      "I couldn't process that just now — your answer is saved. Try again in a moment.";
  } else if (session.questionCount >= HARD_MAX_QUESTIONS) {
    // The absolute ceiling terminates the interview no matter what. Same
    // coherence rule as the concluded branch (RC-P1-E): a discarded model
    // question never survives as the visible message.
    question = null;
    state = 'READY_TO_GENERATE';
    if (input.response?.question || /\?\s*$/.test(assistantMessage.trim())) {
      assistantMessage = "That's everything I need.";
    }
  } else if (astReadiness.conflicts.length || astReadiness.pending.length || !astReadiness.ready) {
    // BLOCKING: the deterministic question for the top blocker replaces
    // whatever the model asked — a generic question cannot resolve it.
    question = astReadiness.nextQuestion;
    state = 'INTERVIEWING';
    assistantMessage = question?.prompt ?? assistantMessage;
  } else if (astReadiness.shouldAsk) {
    // ready AND a HIGH gap AND budget left: keep asking — with the
    // deterministic gap question, so the next answer is guaranteed to fill
    // the highest-value gap.
    question = astReadiness.nextQuestion;
    state = 'INTERVIEWING';
    assistantMessage = question?.prompt ?? assistantMessage;
  } else {
    // The gate concluded. The model may have asked a discretionary question
    // in the same breath (RC-P1-E) — the gate discards the question OBJECT,
    // and discarding must be coherent: the visible message cannot keep asking
    // it, or the UI shows an unanswerable question next to Build Plan. The
    // safe replacement is the fixed wrap-up; the model's non-question prose
    // (a wrap-up of its own) survives only when it does not ask anything.
    question = null;
    state = 'READY_TO_GENERATE';
    if (input.response?.question || /\?\s*$/.test(assistantMessage.trim())) {
      assistantMessage = "That's everything I need.";
    }
  }

  const status = state === 'READY_TO_GENERATE' ? 'READY_TO_GENERATE' : 'INTERVIEWING';
  const nextCount = question ? session.questionCount + 1 : session.questionCount;
  const nextAsked = question ? [...asked, question.id] : asked;

  if (!assistantMessage) {
    assistantMessage = question?.prompt ?? "That's everything I need.";
  }

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
      category: input.response?.category ?? session.category,
      // Every applied turn moves the interview on. A generate request that
      // quotes an older revision is planning from a picture that no longer
      // exists, and is refused for exactly that reason.
      revision: { increment: 1 },
    },
  });

  // Rev.4: the progress estimate counts the distinct askable clarifications
  // remaining (conflict + pending + blocking/HIGH gap ids), clamped to the
  // remaining HARD_MAX budget. Purely presentational — never readiness.
  const remaining = estimateRemainingAskable(astReadiness, nextCount, HARD_MAX_QUESTIONS);
  const estimatedTotal = question ? nextCount + remaining : nextCount;

  return {
    sessionId: updated.id,
    status: updated.status,
    assistantMessage,
    question,
    questionCount: nextCount,
    estimatedTotal,
    context: toPlainObject(context),
    provenance: describeProvenance(context),
    canGenerate: status === 'READY_TO_GENERATE',
    readiness,
    revision: updated.revision,
    shouldAsk: astReadiness.shouldAsk,
    canForce: canForceGenerate(updated, requirementState),
    extractionFailed: input.response === null || input.extractionFailed === true,
    requirements: requirementsSummary(requirementState, nextCount),
  };
}

/**
 * The single force-generation policy (Rev.3 §A3 / Rev.4 §B2): the SAME
 * predicate for the returned `canForce` and the accepted-force rule in the
 * generate route. Force is only for the safely-incomplete class — never for
 * stale state, unresolved conflicts, pending resolutions or load-bearing
 * quarantines. Post-claim safety/feasibility/contract gates always run.
 */
export function canForceGenerate(
  session: { questionCount: number; status: string },
  requirementState: RequirementState,
): boolean {
  if (session.status === 'READY_TO_GENERATE') return false; // nothing to force
  if (session.questionCount < 2) return false; // anti-impulse floor
  if (requirementState.meta?.lastTurnExtraction === 'failed') return false; // R1
  return evaluateAstReadiness(requirementState, {
    questionCount: session.questionCount,
    maxQuestions: HARD_MAX_QUESTIONS,
  }).forceEligible;
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

export async function startSession(userId: string, goalText: string): Promise<InterviewTurn> {
  const session = await prisma.copilotSession.create({
    data: {
      userId,
      initialGoalText: goalText.trim(),
      // goalIntent is written once here and is not rewritable by anything later.
      structuredContext: serializeContext({
        ...createContext(goalText.trim()),
        requirements: emptyRequirementState(),
      }),
      expiresAt: new Date(Date.now() + SESSION_TTL_HOURS * 3600_000),
      messages: { create: { role: 'user', content: goalText.trim() } },
    },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });

  await recordEvent({ userId, type: 'SESSION_STARTED', sessionId: session.id });

  const { result, preferences, providerFailed } = await runInterviewTurn(session);
  if (providerFailed || result === null) {
    // R1: typed provider failure — the session exists with the goal text
    // recorded (answers-saved), the state is stale, nothing is concluded.
    return applyTurn(session, {
      response: null,
      extractionFailed: true,
      injectedPreferences: preferences,
    });
  }
  return applyTurn(session, { response: result, injectedPreferences: preferences });
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
  // product answers are coming. Nothing is written, nothing is ingested, and
  // the revision does not move.
  const pending = pendingQuestion(session);
  if (
    !input.skipped &&
    pending &&
    typeof input.answer === 'string' &&
    classifyIntentDeterministic(input.answer).intent === 'PRODUCT_HELP'
  ) {
    const context = parseContext(session.structuredContext, session.initialGoalText);
    return {
      sessionId: session.id,
      status: session.status,
      assistantMessage: PRODUCT_HELP_STUB,
      question: pending,
      questionCount: session.questionCount,
      estimatedTotal: session.questionCount + estimateRemainingAskable(
        evaluateAstReadiness(parseRequirementState(session.structuredContext), {
          questionCount: session.questionCount,
          maxQuestions: HARD_MAX_QUESTIONS,
        }),
        session.questionCount,
        HARD_MAX_QUESTIONS,
      ),
      context: toPlainObject(context),
      provenance: describeProvenance(context),
      canGenerate: session.status === 'READY_TO_GENERATE',
      readiness: sessionReadiness(session),
      revision: session.revision,
      canForce: canForceGenerate(session, parseRequirementState(session.structuredContext)),
    };
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

    recordAnswer(context, {
      key: input.questionId,
      questionId: input.questionId,
      question: askedQuestion?.prompt,
      value: input.answer,
    });

    // Deterministic GapResolution (Rev.3): a structured answer to one of the
    // three registered gap questions is parsed and ingested WITHOUT a model —
    // its resolution contract is the parser. This is the current turn's
    // authoritative ingest; the model turn (if it runs) re-affirms it.
    const pendingForAnswer = [...session.messages]
      .reverse()
      .map((m) => (m.structuredPayload ? safeParse(m.structuredPayload) : null))
      .find((p) => p?.id === input.questionId);
    // RC-P1-F: the timeframe validity check observes the user's timezone —
    // the same `todayIn` the draft validator will apply later, so a date the
    // interview accepts is a date the draft keeps.
    const [userProfile] = await prisma.$queryRaw<Array<{ timezone: string | null }>>`
      SELECT timezone FROM "Profile" WHERE "userId" = ${session.userId}
    `.catch(() => [{ timezone: null }] as Array<{ timezone: string | null }>);
    const resolution = deterministicGapResolution(input.questionId, input.answer, {
      timezone: userProfile?.timezone ?? 'UTC',
    });
    if (resolution && pendingForAnswer) {
      const state = parseRequirementState(session.structuredContext);
      const { state: next } = ingestExtraction(
        state,
        requirementFragmentSchema.parse({
          atoms: [{
            property: resolution.property,
            scope: resolution.scope,
            relation: resolution.relation,
            value: resolution.value,
            strength: 'REQUIRED',
            source: 'stated',
            evidence: answerText,
          }],
        }),
        astGroundingFor(session, { questionId: input.questionId, text: answerText }),
      );
      context.requirements = next;
    }

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

  const { result, preferences, providerFailed } = await runInterviewTurn(refreshed);
  const groundingAnswer = { questionId: input.questionId, text: input.skipped ? '' : answerText };

  if (providerFailed || result === null) {
    // R1: the extraction failed after the bounded budget. The current turn is
    // still "processed" when its answer was deterministically ingested above —
    // the gate may run on that state. Otherwise the state is stale: no
    // conclusion, pending question re-presented, typed retryable failure.
    // The comparison is on the STORED BYTES, never on object identity: a
    // fresh parse of the same payload would make !== always true.
    const stateNow = parseRequirementState(refreshed.structuredContext);
    const deterministicallyIngested = stateNow.meta?.lastTurnExtraction === 'ok' &&
      JSON.stringify(canonicalState(stateNow)) !==
        JSON.stringify(canonicalState(parseRequirementState(session.structuredContext)));
    if (deterministicallyIngested) {
      return applyTurn(refreshed, {
        response: null,
        extractionFailed: false,
        currentAnswer: groundingAnswer,
        assistantMessageOverride:
          "That's recorded — the service hiccuped on my end, but your answer is in.",
      });
    }
    return applyTurn(refreshed, {
      response: null,
      extractionFailed: true,
      currentAnswer: groundingAnswer,
    });
  }
  return applyTurn(refreshed, {
    response: result,
    injectedPreferences: preferences,
    currentAnswer: groundingAnswer,
  });
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
