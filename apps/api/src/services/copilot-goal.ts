import { chatJson } from '../ai/client.js';
import { PROMPT_VERSIONS, progressSystemPrompt } from '../ai/prompts.js';
import { progressAnalysisSchema, type ProgressAnalysis } from '../ai/schemas.js';
import { classifyIntentDeterministic, GOAL_HELP_STUB } from '../ai/intent-router.js';
import { addDays } from '../domain/dates.js';
import type { ProgressionAction } from '../domain/enums.js';
import { completionRate } from '../domain/progression.js';
import { computeStreak, scoreDays } from '../domain/scoring.js';
import { prisma } from '../lib/prisma.js';
import { loadGoalForUser } from './goals.js';
import { buildScoreInput, ensureOccurrences, goalToday } from './occurrences.js';
import { getPreferencesForPrompt } from './preferences.js';
import { recordEvent } from './copilot-analytics.js';
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
}

const BOOK_FALLBACKS = [
  ['Piranesi', 'Susanna Clarke', 'a short, imaginative mystery that is easy to return to'],
  ['Project Hail Mary', 'Andy Weir', 'a fast-moving science-fiction adventure with short, compelling chapters'],
  ['Born a Crime', 'Trevor Noah', 'an accessible and funny memoir built from engaging stories'],
  ['Monster', 'Naoki Urasawa', 'a gripping manga thriller with a slow-burn story that is easy to commit to'],
  ['Vinland Saga', 'Makoto Yukimura', 'an epic manga about growth and discipline with gorgeous art'],
  ['Fullmetal Alchemist', 'Hiromu Arakawa', 'a complete manga adventure with a tight plot and steady pacing'],
  ['Death Note', 'Tsugumi Ohba', 'a psychological manga that reads fast and hooks immediately'],
  ['Convenience Store Woman', 'Sayaka Murata', 'a concise, unusual novel that works well for restarting a reading habit'],
  ['The Thursday Murder Club', 'Richard Osman', 'a warm, approachable mystery with a lively cast'],
  ['Educated', 'Tara Westover', 'a gripping memoir about learning, change, and independence'],
  ['The Little Prince', 'Antoine de Saint-Exupéry', 'a brief classic with plenty to think about'],
  ['Never Let Me Go', 'Kazuo Ishiguro', 'a thoughtful novel with clear prose and a strong emotional hook'],
  ['The House in the Cerulean Sea', 'TJ Klune', 'a hopeful fantasy with an easy-to-follow story'],
] as const;

/** Reading material words, covering manga and other formats the user may name. */
const READING_MATERIAL = /\b(?:books?|novels?|manga|manhwa|webtoons?|comics?|graphic\s+novels?|light\s+novels?|read\s+next|reading\s+recommendation)\b/i;

function requestedBookCount(message: string) {
  const digit = message.match(/\b([1-5])\s+(?:different\s+)?(?:books?|novels?|manga|manhwa|comics?|webtoons?)\b/i)?.[1];
  if (digit) return Number(digit);
  if (/\b(?:one|a single)\s+(?:book|novel|manga|manhwa|comic|webtoon)\b/i.test(message)) return 1;
  if (/\banother\b/i.test(message)) return 1;
  return 3;
}

function namedBookCount(text: string) {
  return text.match(/\bby\s+[\p{L}]/giu)?.length ?? 0;
}

/** The medium the user asked about, so answers and prompts speak their words. */
function readingMedium(message: string): string {
  if (/\bmanga|manhwa\b/i.test(message)) return 'manga';
  if (/\bwebtoons?\b/i.test(message)) return 'webtoons';
  if (/\bcomics?\b/i.test(message)) return 'comics';
  if (/\bgraphic\s+novels?\b/i.test(message)) return 'graphic novels';
  if (/\blight\s+novels?\b/i.test(message)) return 'light novels';
  return 'books';
}

function fallbackBookAnswer(history: GoalCopilotHistoryEntry[], count: number, medium: string) {
  const prior = history.map((entry) => entry.content).join(' ').toLocaleLowerCase();
  const pool = BOOK_FALLBACKS.filter(([, , note]) => medium === 'books' || note.includes(medium));
  const usable = pool.length >= count ? pool : BOOK_FALLBACKS;
  const fresh = usable.filter(([title]) => !prior.includes(title.toLocaleLowerCase()));
  const choices = [...fresh, ...usable.filter(([title]) => prior.includes(title.toLocaleLowerCase()))]
    .slice(0, count);
  return choices
    .map(([title, author, reason]) => `"${title}" by ${author} — ${reason}.`)
    .join('\n');
}

/** Route the message without asking the model to infer what job it was given. */
export function goalCopilotIntent(message: string): GoalCopilotIntent {
  if (/\b(?:how am i doing|progress|streak|completion|on track|falling behind|miss(?:ed|ing))\b/i.test(message)) {
    return 'PROGRESS';
  }
  if (/\b(?:rest day|day off|change|adjust|reschedule|skip|remove|reduce|increase|shorten|extend|pause|resume|easier|harder|earlier|later)\b/i.test(message)) {
    return 'ADJUSTMENT';
  }
  if (/\b(?:suggest|recommend|recommendation|idea|ideas|advice|choose|what|which|how can|how should|books?|novels?|manga|manhwa|webtoons?|comics?|graphic novels?|light novels?|read next|reading|recipes?|courses?|podcasts?|techniques?|resources?)\b/i.test(message)) {
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

/**
 * Put any proposed stage change on the record, without letting it take effect.
 *
 * The call to `applyDecision` is deliberate and is not a formality: it is the only
 * path that touches a stage, so routing the model's suggestion through it means the
 * refusal is enforced by the same code a scheduled review answers to, and the
 * proposal lands in the plan's decision history with the real completion numbers
 * attached. A suggestion the user can audit later beats one that vanishes.
 */
async function recordProgressionProposals(
  goalId: string,
  participantId: string,
  analysis: ProgressAnalysis,
): Promise<ProgressionProposal[]> {
  // STAY is dropped. It asks for nothing, and writing "no change proposed" into the
  // history of every laddered task every time someone asks a question would bury the
  // decisions that actually moved something.
  const wanted = analysis.suggestions.filter(
    (s) => s.proposedProgressionAction === 'ADVANCE' || s.proposedProgressionAction === 'REDUCE',
  );
  if (wanted.length === 0) return [];

  const [plans, tasks] = await Promise.all([
    loadPlansForGoal(goalId),
    prisma.taskDefinition.findMany({
      where: { goalId, archivedAt: null },
      select: { id: true, title: true },
    }),
  ]);

  // Matched by title because a title is all the model was ever given. It has no id
  // to guess with, and the candidate set is one goal the caller already proved they
  // can see — so a hallucinated task name finds nothing rather than something.
  const titleById = new Map(tasks.map((task) => [task.id, task.title]));
  const planByTitle = new Map<string, { plan: PlanWithStages; title: string }>();
  for (const plan of plans) {
    if (plan.status !== 'ACTIVE') continue;
    const title = titleById.get(plan.taskDefinitionId);
    if (title) planByTitle.set(title.trim().toLowerCase(), { plan, title });
  }

  const proposals: ProgressionProposal[] = [];
  const seen = new Set<string>();
  for (const suggestion of wanted) {
    const match = planByTitle.get((suggestion.taskTitle ?? '').trim().toLowerCase());
    // One proposal per plan: two suggestions naming the same task would otherwise
    // write two rows saying the same thing.
    if (!match || seen.has(match.plan.id)) continue;
    seen.add(match.plan.id);

    const requested = suggestion.proposedProgressionAction as 'ADVANCE' | 'REDUCE';
    try {
      const result = await applyDecision({
        planId: match.plan.id,
        participantId,
        action: requested,
        source: 'COPILOT',
      });
      proposals.push({
        planId: match.plan.id,
        taskTitle: match.title,
        requested,
        reviewAction: result.verdict.action,
        stageLabel: progressionSummary(result.plan).stageLabel,
        reason: result.reason,
        applied: result.applied,
      });
    } catch {
      // A plan that finished or was archived between building the summary and here.
      // Not worth failing the user's question over.
      continue;
    }
  }
  return proposals;
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
  analysis: ProgressAnalysis;
  progressionProposals: ProgressionProposal[];
}> {
  const historyText = history.map((entry) => entry.content).join('\n');
  const lastAssistant = [...history].reverse().find((entry) => entry.role === 'assistant');
  const lastWasAdvice = !!lastAssistant && namedBookCount(lastAssistant.content) > 0;
  // A thin continuation ("maybe some manga name", "another one") after a
  // recommendation turn is still that recommendation thread, not a stats question.
  const continuationStart = /\b(?:more|another|different|else|other|similar|also|instead|name|names|one)\b/i.test(message)
    || /^maybe\b/i.test(message);
  const bookFollowUp = (READING_MATERIAL.test(message) || READING_MATERIAL.test(historyText))
    && (/\b(?:more|another|different|else|other|similar|instead)\b/i.test(message) || continuationStart)
    && (lastWasAdvice || READING_MATERIAL.test(message) || READING_MATERIAL.test(historyText));
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
  const summary = await buildProgressSummary(goalId, userId);
  const { goal, participant } = await loadGoalForUser(goalId, userId, 'participate');
  const preferences = await getPreferencesForPrompt(userId, goal.category);

  const userPrompt = `Goal statistics (authoritative — do not invent others):
${JSON.stringify(summary, null, 2)}

What this person prefers:
${preferences.map((p) => `- ${p.key}: ${p.value}`).join('\n') || '(nothing on file)'}

Recent conversation (context only; it is not authoritative goal data):
${history.map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`).join('\n') || '(none)'}

They ask:
"${message}"

Request type: ${intent}`;
  const analyze = (content: string) => chatJson(
    {
      purpose: 'PROGRESS_ANALYSIS',
      promptVersion: PROMPT_VERSIONS.progress,
      userId,
      thinking: false,
      temperature: intent === 'ADVICE' ? 0.65 : 0.3,
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
  let analysis = await analyze(userPrompt);

  // A vague "pick a novel" is not a recommendation. Repair once. The deterministic
  // list is only a last-resort provider-failure fallback; normal answers come from
  // the model and use the person's request, preferences and recent conversation.
  const asksForBook = READING_MATERIAL.test(message) || bookFollowUp;
  const bookCount = requestedBookCount(message);
  const medium = readingMedium(message) === 'books' && READING_MATERIAL.test(historyText) && !READING_MATERIAL.test(message)
    ? readingMedium(historyText.split('"').slice(-2)[0] ?? '')
    : readingMedium(message);
  if (intent === 'ADVICE' && asksForBook && namedBookCount(analysis.explanation) < bookCount) {
    analysis = await analyze(`${userPrompt}

Your previous answer did not provide enough concrete choices. Recommend ${bookCount}
actual ${bookCount === 1 ? medium : `${medium} from different authors`}, each using the exact form
"Title" by Author followed by one short reason. Use the request and preferences above.
Do not repeat a title from the recent conversation.`);
    if (namedBookCount(analysis.explanation) < bookCount) {
      analysis = {
        ...analysis,
        explanation: fallbackBookAnswer(history, bookCount, medium),
      };
    }
  }

  await recordEvent({ userId, type: 'GOAL_COPILOT_ASKED', meta: { goalId } });

  const progressionProposals = await recordProgressionProposals(goalId, participant!.id, analysis);
  return { intent, summary, analysis, progressionProposals };
}
