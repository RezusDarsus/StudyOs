import { chatJson } from '../ai/client.js';
import { PROMPT_VERSIONS, progressSystemPrompt } from '../ai/prompts.js';
import { progressAnalysisSchema, type ProgressAnalysis } from '../ai/schemas.js';
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
): Promise<{
  summary: GoalProgressSummary;
  analysis: ProgressAnalysis;
  progressionProposals: ProgressionProposal[];
}> {
  const summary = await buildProgressSummary(goalId, userId);
  const { goal, participant } = await loadGoalForUser(goalId, userId, 'participate');
  const preferences = await getPreferencesForPrompt(userId, goal.category);

  const analysis = await chatJson(
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
          content: `Goal statistics (authoritative — do not invent others):
${JSON.stringify(summary, null, 2)}

What this person prefers:
${preferences.map((p) => `- ${p.key}: ${p.value}`).join('\n') || '(nothing on file)'}

They ask:
"${message}"`,
        },
      ],
    },
    progressAnalysisSchema,
  );

  await recordEvent({ userId, type: 'GOAL_COPILOT_ASKED', meta: { goalId } });

  const progressionProposals = await recordProgressionProposals(goalId, participant!.id, analysis);
  return { summary, analysis, progressionProposals };
}
