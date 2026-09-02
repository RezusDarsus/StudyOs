import { chatJson } from '../ai/client.js';
import { PROMPT_VERSIONS, progressSystemPrompt } from '../ai/prompts.js';
import {
  progressAnalysisSchema,
  progressAnalysisSchemaV7,
  type ProgressAnalysis,
  type ProgressAnalysisV7,
} from '../ai/schemas.js';
import { classifyIntentDeterministic, GOAL_HELP_STUB } from '../ai/intent-router.js';
import { addDays } from '../domain/dates.js';
import { randomUUID } from 'node:crypto';
import type { ProgressionAction } from '../domain/enums.js';
import { completionRate } from '../domain/progression.js';
import { computeStreak, scoreDays } from '../domain/scoring.js';
import { getRuntimeKnowledge, portMemo } from '../ai/runtime-knowledge.js';
import { prisma } from '../lib/prisma.js';
import { loadGoalForUser } from './goals.js';
import { buildScoreInput, ensureOccurrences, goalToday } from './occurrences.js';
import { extractPreferences, getPreferencesForPrompt } from './preferences.js';
import { recordEvent } from './copilot-analytics.js';
import {
  normalizeRecommendations,
  priorRecommendationIdentities,
  RecommendationValidationError,
  recommendationIdentity,
  serializePriorRecommendations,
  validateRecommendationTurn,
  type StructuredRecommendation,
} from './copilot-recommendations.js';
import {
  loadGoalHasRecommendations,
  loadKnownIdentities,
  loadRecentRecommendationContext,
  persistRecommendedEvents,
} from './recommendation-history.js';
import { feedbackSummariesForGoal } from './task-feedback.js';
import {
  applyDecision,
  gatherEvidence,
  loadPlansForGoal,
  progressionSummary,
  type PlanWithStages,
} from './progression.js';

/** What the model is told about a task that climbs a ladder. */
interface ScheduledProgression {
  stageLabel: string;
  currentTarget: number | null;
  unitLabel: string;
  /** Completion at the CURRENT step only — the number an advance depends on. */
  completedAtThisStage: number;
  scheduledAtThisStage: number;
  completionRateAtThisStage: number;
  advanceThreshold: number;
  atFinalStage: boolean;
}

/**
 * How the person says a task has been feeling, for a task they have said anything
 * about. Deliberately just the aggregate: their free-text notes are shown back to
 * them in the interface but never sent here, because a note is text a user typed and
 * everything in this object is read by the model as fact.
 */
interface ScheduledDifficulty {
  /** TOO_EASY | JUST_RIGHT | TOO_HARD | MIXED. Absent rather than UNKNOWN. */
  felt: string;
  ratedDays: number;
}


/**
 * A deterministic, aggregated summary of how a goal is going.
 *
 * The model never sees the database. It gets these numbers — computed by the same
 * Phase 1 scoring engine the UI uses — so it cannot invent statistics, and the
 * request stays small regardless of how much history exists.
 */
export interface GoalProgressSummary {
  goalTitle: string;
  category: string;
  periodDays: number;
  eligibleTaskOccurrences: number;
  completedTaskOccurrences: number;
  completionRate: number;
  currentStreak: number;
  bestStreak: number;
  mostMissedTasks: Array<{ title: string; missRate: number; scheduled: number }>;
  schedule: Array<{
    title: string;
    recurrence: string;
    minutes: number | null;
    time: string | null;
    progression: ScheduledProgression | null;
    difficulty: ScheduledDifficulty | null;
  }>;
}

export type GoalCopilotIntent = 'PROGRESS' | 'ADVICE' | 'ADJUSTMENT' | 'PRODUCT_HELP';

export interface GoalCopilotHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  /**
   * The structured recommendations that came back with this turn, as the
   * client mirrored them. The only recommendation memory this pipeline has —
   * explanation prose is never scraped for identity. Absent on user entries;
   * nullish is tolerated because that is what a nullish parse yields.
   */
  recommendations?: StructuredRecommendation[] | null;
}

/** A regex that matches nothing — the generic degradation for a runtime
 *  lexicon that is absent. Deliberately domain-neutral: no migrated vocabulary
 *  may be reached for as a fallback, and no topic may keep routing on
 *  hardcoded words. */
const NEVER_MATCH = /(?!x)x/;

/** How much recent conversation the background preference extraction sees —
 *  bounded the same way the interview pipeline bounds its transcript window. */
const TRANSCRIPT_WINDOW = 20;

/** Reading-material topic words, from the runtime port only. An absent pack is
 *  the generic never-match degradation — never an inline vocabulary. */
export function readingMaterial(): RegExp {
  return portMemo(getRuntimeKnowledge(), 'recommendation-material', () =>
    getRuntimeKnowledge().getLexicon('recommendation-material').patterns[0]?.regex ?? NEVER_MATCH);
}

/** Route the message without asking the model to infer what job it was given.
 *  The topic-noun segment is runtime data (the port); the structural advice
 *  verbs (suggest/recommend/…/how should) and the PROGRESS/ADJUSTMENT schedule
 *  frames are core mechanics. */
function advicePattern(): RegExp {
  return portMemo(getRuntimeKnowledge(), 'goal-advice-pattern', () => {
    // Degradation is generic and structural-only: an absent topic segment
    // leaves the core advice verbs routing and adds no empty alternative
    // (which would match every word boundary).
    const topic = getRuntimeKnowledge().getLexicon('recommendation-topic').patterns[0]?.entry.phrase ?? '';
    return new RegExp(
      `\\b(?:suggest|recommend|recommendation|idea|ideas|advice|choose|what|which|how can|how should${topic ? `|${topic}` : ''})\\b`,
      'i',
    );
  });
}

export function goalCopilotIntent(message: string): GoalCopilotIntent {
  if (/\b(?:how am i doing|progress|streak|completion|on track|falling behind|miss(?:ed|ing))\b/i.test(message)) {
    return 'PROGRESS';
  }
  if (/\b(?:rest day|day off|change|adjust|reschedule|skip|remove|reduce|increase|shorten|extend|pause|resume|easier|harder|earlier|later)\b/i.test(message)) {
    return 'ADJUSTMENT';
  }
  if (advicePattern().test(message)) {
    return 'ADVICE';
  }
  return 'PROGRESS';
}

export async function buildProgressSummary(
  goalId: string,
  userId: string,
  periodDays = 14,
): Promise<GoalProgressSummary> {
  const { goal, participant } = await loadGoalForUser(goalId, userId, 'participate');
  await ensureOccurrences(goalId, [participant!.id]);

  const today = goalToday(goal);
  const tasks = await prisma.taskDefinition.findMany({
    where: { goalId, archivedAt: null },
  });
  const input = await buildScoreInput(goal, participant!, today, tasks);

  const windowStart = addDays(today, -(periodDays - 1));
  const days = scoreDays(input).filter((d) => d.day >= windowStart);

  const eligible = days.reduce((sum, d) => sum + d.required, 0);
  const completed = days.reduce((sum, d) => sum + d.completed, 0);
  const streak = computeStreak(input, today);

  // Per-task miss rates, so the Copilot can name the task actually being dropped.
  const occurrences = await prisma.taskOccurrence.findMany({
    where: {
      participantId: participant!.id,
      dueDate: { gte: windowStart, lte: today },
    },
    include: { taskDefinition: { select: { title: true } } },
  });

  const byTask = new Map<string, { scheduled: number; done: number }>();
  for (const occurrence of occurrences) {
    const key = occurrence.taskDefinition.title;
    const row = byTask.get(key) ?? { scheduled: 0, done: 0 };
    row.scheduled++;
    if (occurrence.status === 'COMPLETED') row.done++;
    byTask.set(key, row);
  }

  const mostMissedTasks = [...byTask.entries()]
    .map(([title, row]) => ({
      title,
      scheduled: row.scheduled,
      missRate: row.scheduled === 0 ? 0 : Math.round((1 - row.done / row.scheduled) * 100) / 100,
    }))
    .filter((row) => row.missRate > 0)
    .sort((a, b) => b.missRate - a.missRate)
    .slice(0, 3);

  // Build-up state, counted over the current step rather than the whole period —
  // a ladder is judged on the target it is asking for now.
  const plans = await loadPlansForGoal(goalId);
  const progressionByTask = new Map<string, ScheduledProgression>();
  for (const plan of plans) {
    if (plan.status !== 'ACTIVE') continue;
    const evidence = await gatherEvidence(plan, participant!.id, today);
    const summary = progressionSummary(plan);
    progressionByTask.set(plan.taskDefinitionId, {
      stageLabel: summary.stageLabel,
      currentTarget: summary.currentTarget,
      unitLabel: summary.unitLabel,
      completedAtThisStage: evidence.completedCount,
      scheduledAtThisStage: evidence.eligibleCount,
      completionRateAtThisStage: completionRate(evidence),
      advanceThreshold: plan.advanceThreshold,
      atFinalStage: summary.currentStageIndex >= summary.stageCount - 1,
    });
  }

  // How the tasks have been feeling, which is a different question from whether they
  // got done and often has a different answer. UNKNOWN is dropped rather than sent:
  // a task with two ratings behind it has told us nothing yet, and passing "unknown"
  // invites the model to remark on it.
  const difficultyByTask = await feedbackSummariesForGoal(goalId, participant!.id, today);
  const feltByTask = new Map<string, ScheduledDifficulty>();
  for (const [taskId, summary] of difficultyByTask) {
    if (summary.signal === 'UNKNOWN') continue;
    feltByTask.set(taskId, { felt: summary.signal, ratedDays: summary.sampleSize });
  }

  return {
    goalTitle: goal.title,
    category: goal.category,
    periodDays,
    eligibleTaskOccurrences: eligible,
    completedTaskOccurrences: completed,
    completionRate: eligible === 0 ? 0 : Math.round((completed / eligible) * 100) / 100,
    currentStreak: streak.current,
    bestStreak: streak.best,
    mostMissedTasks,
    schedule: tasks.map((task) => ({
      // Stage 4: server-owned stable reference. The model may echo this back in
      // a suggestion; the executor validates it against the goal's own tasks.
      taskId: task.id,
      title: task.title,
      recurrence: `${task.recurrenceType} ${task.recurrenceConfig}`,
      minutes: null,
      time: task.reminderTime,
      progression: progressionByTask.get(task.id) ?? null,
      difficulty: feltByTask.get(task.id) ?? null,
    })),
  };
}

/**
 * A stage change the Copilot suggested and the app declined to make for it.
 *
 * Every one of these carries `applied: false` by construction: `authorizeAction`
 * refuses COPILOT as a source outright, agreement with the review included. They
 * exist so the panel can show "the Copilot thinks you're ready for stage 3" beside
 * a button only a person can press.
 */
export interface ProgressionProposal {
  planId: string;
  taskTitle: string;
  /** What the model asked for. */
  requested: ProgressionAction;
  /** What the numbers say, recomputed from the database — not from the model. */
  reviewAction: ProgressionAction;
  stageLabel: string;
  /** The refusal, in the same words the decision history records. */
  reason: string;
  applied: boolean;
}

/** A zeroed summary for the PRODUCT_HELP stub — no statistics are read, none invented. */
function stubSummary(goal: { title: string; category: string }): GoalProgressSummary {
  return {
    goalTitle: goal.title,
    category: goal.category,
    periodDays: 14,
    eligibleTaskOccurrences: 0,
    completedTaskOccurrences: 0,
    completionRate: 0,
    currentStreak: 0,
    bestStreak: 0,
    mostMissedTasks: [],
    schedule: [],
  };
}

/**
 * The structured ADVICE pipeline: validate the structured collection,
 * repair once with the violations stated, revalidate, then fail typed.
 *
 * This function is the whole of Stage 1's behavior change, kept as one region
 * so the source-boundary test can prove it never references any legacy
 * recommendation content — no catalogs, no prose scraping. Everything here is
 * deterministic except the two model calls.
 *
 * Stage 2 extends it in exactly two ways, both gated by their own settings:
 * `resolveDurableKnown` unions durable event history into the seen-identity
 * set (UNION semantics — the client mirror keeps contributing), and the
 * caller persists the fresh items after success.
 */
async function runStructuredAdviceTurn(input: {
  analysis: ProgressAnalysisV7;
  analyze: (content: string) => Promise<ProgressAnalysisV7>;
  userPrompt: string;
  priorIdentities: ReadonlySet<string>;
  resolveDurableKnown?: (
    candidates: readonly StructuredRecommendation[],
  ) => Promise<ReadonlySet<string>>;
}): Promise<ProgressAnalysis & { historyPersisted?: boolean }> {
  const validate = async (analysis: ProgressAnalysisV7) => {
    let priorIdentities = input.priorIdentities;
    if (input.resolveDurableKnown) {
      // Full-history duplicate protection without unbounded reads: only the
      // candidate identity keys are looked up, on the (userId, identityKey)
      // index. A Stage 1 mirrored item and a durable event reject alike.
      const candidates = normalizeRecommendations(analysis.recommendations);
      const durableKnown = await input.resolveDurableKnown(candidates);
      if (durableKnown.size > 0) {
        priorIdentities = new Set([...priorIdentities, ...durableKnown]);
      }
    }
    return validateRecommendationTurn({ analysis, priorIdentities });
  };

  let result = await validate(input.analysis);
  if (result.violations.length === 0) {
    return { ...input.analysis, recommendations: result.items };
  }
  // Exactly one targeted repair, stating the violation class. No catalog, no
  // fallback content: an unrepairable turn fails as RECOMMENDATIONS_INVALID.
  const repair = await input.analyze(
    `${input.userPrompt}

Your previous reply was rejected: ${result.violations.join(' ')} Return the corrected JSON object now, following the RECOMMENDATIONS contract.`,
  );
  result = await validate(repair);
  if (result.violations.length > 0) {
    throw new RecommendationValidationError(result.violations);
  }
  return { ...repair, recommendations: result.items };
}

/**
 * Ask the Copilot about an existing goal.
 *
 * Returns an explanation and optional *proposals*. Nothing is applied — changing
 * a live goal's schedule needs explicit confirmation, because it affects future
 * occurrences and the user's streak.
 */
export async function askGoalCopilot(
  goalId: string,
  userId: string,
  message: string,
  history: GoalCopilotHistoryEntry[] = [],
): Promise<{
  intent: GoalCopilotIntent;
  summary: GoalProgressSummary;
  analysis: ProgressAnalysis & { historyPersisted?: boolean };
  progressionProposals: ProgressionProposal[];
}> {
  const historyText = history.map((entry) => entry.content).join('\n');
  const lastAssistant = [...history].reverse().find((entry) => entry.role === 'assistant');
  // A thin continuation ("another one", "more like that") after a
  // recommendation turn is still that recommendation thread, not a stats question.
  const continuationStart = /\b(?:more|another|different|else|other|similar|also|instead|name|names|one)\b/i.test(message)
    || /^maybe\b/i.test(message);
  // Durable recommendation context participates BEFORE continuation routing,
  // so "another one" stays in the recommendation thread across sessions with
  // no client history. The signal is deliberately goal-scoped — "the user has
  // recommendations somewhere" never manufactures a thread — and it is only
  // queried when the message already looks like a continuation, so ordinary
  // turns pay nothing.
  const durableGoalSignal =
    continuationStart || readingMaterial().test(message)
      ? await loadGoalHasRecommendations(goalId)
      : false;
  // Continuation detection uses the structured mirror and the durable goal
  // context only — recommendation identity is never scraped from prose.
  const lastHadRecommendations = (lastAssistant?.recommendations?.length ?? 0) > 0;
  const lastWasAdvice = lastHadRecommendations || durableGoalSignal;
  const bookFollowUp = (readingMaterial().test(message) || readingMaterial().test(historyText))
    && (/\b(?:more|another|different|else|other|similar|instead)\b/i.test(message) || continuationStart)
    && (lastWasAdvice || readingMaterial().test(message) || readingMaterial().test(historyText));
  // Interruption: a product-mechanics question in goal chat gets the honest
  // stub, not a model improvising statistics it was never given. No summary is
  // computed, no tokens spent; the UI renders the explanation without the stat
  // cards. Real product answers come in a later phase.
  if (classifyIntentDeterministic(message).intent === 'PRODUCT_HELP') {
    const { goal } = await loadGoalForUser(goalId, userId, 'participate');
    return {
      intent: 'PRODUCT_HELP',
      summary: stubSummary(goal),
      analysis: { explanation: GOAL_HELP_STUB, suggestions: [] },
      progressionProposals: [],
    };
  }
  const thinContinuation = lastWasAdvice && continuationStart
    && !/\b(?:how am i doing|progress|streak|completion|behind|miss(?:ed|ing)|done)\b/i.test(message);
  const intent = bookFollowUp || thinContinuation ? 'ADVICE' : goalCopilotIntent(message);
  // Continuation routing uses structured/durable signals; topic words come
  // from the runtime port. The structural advice verbs are core mechanics.
  const structuredTurn = intent === 'ADVICE';
  const summary = await buildProgressSummary(goalId, userId);
  const { goal, participant } = await loadGoalForUser(goalId, userId, 'participate');
  const preferences = await getPreferencesForPrompt(userId, goal.category);

  // Two defenses against repeats: this block (generation avoids them) and the
  // deterministic validator (which removes them anyway). Stage 2 feeds the
  // block from durable memory first — the latest event per identity, server
  // side — and lets the client's structured mirror contribute anything the
  // events do not already cover. Built from structured data only; prose is
  // never parsed. Reads only happen when the read setting is on.
  const readEnabled = structuredTurn;
  const durableContext = readEnabled ? await loadRecentRecommendationContext(userId) : [];
  const contextSource = durableContext.length
    ? [
        {
          recommendations: durableContext.map(
            ({ entityType, displayName, attribution }) => ({ entityType, displayName, attribution }),
          ),
        },
      ]
    : [];
  const priorBlock = structuredTurn ? serializePriorRecommendations([...history, ...contextSource]) : '';
  const userPrompt = `Goal statistics (authoritative — do not invent others):
${JSON.stringify(summary, null, 2)}

What this person prefers:
${preferences.map((p) => `- ${p.key}: ${p.value}`).join('\n') || '(nothing on file)'}

Recent conversation (context only; it is not authoritative goal data):
${history.map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`).join('\n') || '(none)'}${priorBlock}

They ask:
"${message}"

Request type: ${intent}`;
  const analyze = (content: string): Promise<ProgressAnalysis> =>
    structuredTurn
      ? chatJson(
          {
            purpose: 'PROGRESS_ANALYSIS',
            promptVersion: PROMPT_VERSIONS.progressStructured,
            userId,
            thinking: false,
            temperature: 0.65,
            maxTokens: 2000,
            timeoutMs: 60_000,
            messages: [
              { role: 'system', content: progressSystemPrompt({ structuredRecommendations: true }) },
              { role: 'user', content },
            ],
          },
          progressAnalysisSchemaV7,
        )
      : chatJson(
          {
            purpose: 'PROGRESS_ANALYSIS',
            promptVersion: PROMPT_VERSIONS.progress,
            userId,
            thinking: false,
            temperature: 0.3,
            maxTokens: 2000,
            timeoutMs: 60_000,
            messages: [
              { role: 'system', content: progressSystemPrompt() },
              {
                role: 'user',
                content,
              },
            ],
          },
          progressAnalysisSchema,
        );

  let analysis: ProgressAnalysis & { historyPersisted?: boolean };
  if (structuredTurn) {
    analysis = await runStructuredAdviceTurn({
      analysis: (await analyze(userPrompt)) as ProgressAnalysisV7,
      analyze: (content) => analyze(content) as Promise<ProgressAnalysisV7>,
      userPrompt,
      priorIdentities: priorRecommendationIdentities(history),
      resolveDurableKnown: readEnabled
        ? (candidates) => loadKnownIdentities(userId, candidates.map(recommendationIdentity))
        : undefined,
    });
    // Durable recommendation history is part of the request (write mode
    // "required" semantics are canonical since Stage 2 burn-in): a persistence
    // failure is the typed retryable 503, never a silently forgotten answer.
    const persisted = await persistRecommendedEvents(userId, goalId, analysis.recommendations ?? []);
    analysis = { ...analysis, historyPersisted: persisted.committed };
  } else {
    analysis = await analyze(userPrompt);
  }

  await recordEvent({ userId, type: 'GOAL_COPILOT_ASKED', meta: { goalId } });

  // Stage 4 canonical path: proposal recording routes through the registry
  // (stable-ID resolution, claim, transaction, audit). This is the service-flow
  // entrypoint — the Copilot proposes, the user applies via the ordinary
  // /progression/decision route.
  const { executeCapability } = await import('../capabilities/executor.js');
  const outcome = await executeCapability<{ proposals: unknown[]; unresolved: number }>(
    { userId, confirmed: true, correlationId: randomUUID() },
    {
      capability: 'progression.propose_from_suggestion',
      input: {
        goalId,
        suggestions: (analysis.suggestions ?? []).map((s) => ({
          taskId: s.taskId ?? null,
          taskTitle: s.taskTitle ?? null,
          proposedRecurrence: s.proposedRecurrence ?? null,
          proposedMinutes: s.proposedMinutes ?? null,
          proposedProgressionAction: s.proposedProgressionAction ?? null,
        })),
      },
    },
  );
  const proposals = (outcome.status === 'failed' ? [] : outcome.result.proposals) as never[];

  // Learn durable preferences from the exchange in the background — the same
  // non-blocking, non-fatal contract the draft pipeline uses. Goal chat has no
  // CopilotSession, so no sessionId. The transcript is capped to the recent
  // window, mirroring how the interview pipeline bounds what it sends.
  void extractPreferences({
    userId,
    category: goal.category,
    transcript: [
      ...history.slice(-TRANSCRIPT_WINDOW),
      { role: 'user', content: message },
      { role: 'assistant', content: analysis.explanation },
    ],
  });

  return { intent, summary, analysis, progressionProposals: proposals };
}
