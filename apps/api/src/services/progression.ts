// Progression service — the database side of a task that gets harder on purpose.
//
// The pure rules live in domain/progression.ts. This module's job is the part that
// has to be trustworthy rather than clever:
//
//  * It re-derives every verdict from the database. A caller — including the
//    Copilot — can ask for ADVANCE, but it only happens if the numbers agree.
//  * It stamps stage targets onto occurrences, and restamps FUTURE days only.
//    Yesterday keeps the number it asked for on the day. Today does too: the user
//    has already seen it, and moving the goalposts mid-day is its own small
//    betrayal.
//  * Every change writes a ProgressionDecision with the evidence attached.

import type { Goal, ProgressionPlan, ProgressionStage } from '@prisma/client';
import { type DayString, addDays, todayIn } from '../domain/dates.js';
import {
  authorizeAction,
  reviewProgression,
  stageAt,
  stageLabel,
  validateStages,
  type ActionAuthorization,
  type ProgressionEvidence,
  type ProgressionStageInput,
  type ProgressionVerdict,
} from '../domain/progression.js';
import {
  PROGRESSION_METRIC,
  PROGRESSION_SOURCE,
  type ProgressionAction,
  type ProgressionMetric,
  type ProgressionSource,
} from '../domain/enums.js';
import { badRequest, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

/** How far back a review looks when the stage has been held longer than this. */
const MAX_REVIEW_WINDOW_DAYS = 28;

export interface PlanWithStages extends ProgressionPlan {
  stages: ProgressionStage[];
}

function toStageInputs(stages: ProgressionStage[]): ProgressionStageInput[] {
  return stages
    .map((s) => ({ stageIndex: s.stageIndex, target: s.target, minDays: s.minDays }))
    .sort((a, b) => a.stageIndex - b.stageIndex);
}

// --------------------------------------------------------------- creation

export interface StageDraft {
  target: number;
  label?: string;
  minDays?: number;
}

export interface CreatePlanInput {
  taskDefinitionId: string;
  metricType: string;
  unitLabel?: string;
  stages: StageDraft[];
  advanceThreshold?: number;
  reduceThreshold?: number;
}

/**
 * Attach a progression ladder to an existing task. The task keeps working exactly
 * as it did — this only adds a target to each day.
 */
export async function createProgressionPlan(input: CreatePlanInput): Promise<PlanWithStages> {
  if (!PROGRESSION_METRIC.includes(input.metricType as ProgressionMetric)) {
    throw badRequest(`Unknown progression metric "${input.metricType}"`);
  }

  const task = await prisma.taskDefinition.findUnique({
    where: { id: input.taskDefinitionId },
    include: { goal: true, progression: true },
  });
  if (!task) throw notFound('Task not found');
  if (task.progression) throw badRequest('This task already has a progression plan');

  const stages: ProgressionStageInput[] = input.stages.map((s, i) => ({
    stageIndex: i,
    target: s.target,
    minDays: s.minDays ?? 7,
  }));
  const errors = validateStages(stages);
  if (errors.length > 0) throw badRequest(errors.join(' '));

  const advanceThreshold = clampPercent(input.advanceThreshold ?? 80);
  const reduceThreshold = clampPercent(input.reduceThreshold ?? 40);
  if (reduceThreshold >= advanceThreshold) {
    throw badRequest('The reduce threshold must be below the advance threshold');
  }

  const today = todayIn(task.goal.timezone);

  const plan = await prisma.progressionPlan.create({
    data: {
      taskDefinitionId: task.id,
      metricType: input.metricType,
      unitLabel: input.unitLabel ?? '',
      advanceThreshold,
      reduceThreshold,
      // Tomorrow, not today, and not the task's start date. Stamping only touches
      // days after today, so tomorrow is the first day that will actually ask for
      // stage 0's target — and a task that has been running for months therefore
      // cannot advance on history it accumulated before the ladder existed.
      stageStartedOn: addDays(today, 1),
      stages: {
        create: input.stages.map((s, i) => ({
          stageIndex: i,
          target: s.target,
          label: s.label ?? '',
          minDays: s.minDays ?? 7,
        })),
      },
    },
    include: { stages: true },
  });

  await stampFutureOccurrences(plan, task.goal.timezone);
  return plan;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

// --------------------------------------------------------------- stamping

/**
 * Write the current stage's target onto every occurrence AFTER today.
 *
 * Deliberately exclusive of today. "Past task history must never be rewritten",
 * and a day the user has already been shown counts as history the moment it
 * starts. So a stage change takes effect tomorrow.
 */
export async function stampFutureOccurrences(
  plan: PlanWithStages,
  timezone: string,
  now = new Date(),
): Promise<number> {
  const stage = stageAt(toStageInputs(plan.stages), plan.currentStageIndex);
  if (!stage) return 0;

  const firstAffectedDay = addDays(todayIn(timezone, now), 1);

  const result = await prisma.taskOccurrence.updateMany({
    where: {
      taskDefinitionId: plan.taskDefinitionId,
      dueDate: { gte: firstAffectedDay },
    },
    data: { progressionStageIndex: stage.stageIndex, progressionTarget: stage.target },
  });
  return result.count;
}

/**
 * The stamp a newly materialised occurrence should carry. Called by
 * ensureOccurrences so a day is born with its target already on it.
 */
export function stampForNewOccurrence(
  plan: PlanWithStages | null,
): { progressionStageIndex: number; progressionTarget: number } | null {
  if (!plan || plan.status !== 'ACTIVE') return null;
  const stage = stageAt(toStageInputs(plan.stages), plan.currentStageIndex);
  if (!stage) return null;
  return { progressionStageIndex: stage.stageIndex, progressionTarget: stage.target };
}

// --------------------------------------------------------------- reviewing

/**
 * Count how the participant has actually done at the current stage.
 *
 * The window starts when the stage started, so the evidence is about the target
 * being judged and not about an easier one the user cleared weeks ago.
 */
export async function gatherEvidence(
  plan: ProgressionPlan,
  participantId: string,
  today: DayString,
): Promise<ProgressionEvidence> {
  const windowStart =
    plan.stageStartedOn > addDays(today, -MAX_REVIEW_WINDOW_DAYS)
      ? plan.stageStartedOn
      : addDays(today, -MAX_REVIEW_WINDOW_DAYS);

  // Yesterday is the last day that can be judged: today is still in progress, and
  // counting it would drag every rate down by one unfinished task.
  const windowEnd = addDays(today, -1);

  if (windowEnd < windowStart) {
    return { windowStart, windowEnd: windowStart, eligibleCount: 0, completedCount: 0 };
  }

  const occurrences = await prisma.taskOccurrence.findMany({
    where: {
      taskDefinitionId: plan.taskDefinitionId,
      participantId,
      dueDate: { gte: windowStart, lte: windowEnd },
    },
    select: { status: true },
  });

  return {
    windowStart,
    windowEnd,
    eligibleCount: occurrences.filter((o) => o.status !== 'SKIPPED').length,
    completedCount: occurrences.filter((o) => o.status === 'COMPLETED').length,
  };
}

/**
 * Work out what should happen to a plan, and record the conclusion — without
 * applying it. This is what the Copilot and the nightly review both call; whether
 * anything actually changes is decided in `applyDecision`.
 */
export async function reviewPlan(
  plan: PlanWithStages,
  participantId: string,
  goal: Pick<Goal, 'timezone'>,
  now = new Date(),
): Promise<{ verdict: ProgressionVerdict; evidence: ProgressionEvidence }> {
  const today = todayIn(goal.timezone, now);
  const evidence = await gatherEvidence(plan, participantId, today);

  const verdict = reviewProgression({
    stages: toStageInputs(plan.stages),
    currentStageIndex: plan.currentStageIndex,
    stageStartedOn: plan.stageStartedOn,
    today,
    advanceThreshold: plan.advanceThreshold,
    reduceThreshold: plan.reduceThreshold,
    evidence,
  });

  return { verdict, evidence };
}

// --------------------------------------------------------------- applying

export interface ApplyDecisionInput {
  planId: string;
  participantId: string;
  action: ProgressionAction;
  source: ProgressionSource;
  /** Set when the user has explicitly agreed to an ASK_USER proposal. */
  userConfirmed?: boolean;
}

/**
 * The only path that can move a plan's stage.
 *
 * The requested action is checked against a freshly computed verdict rather than
 * trusted. That is what stops a plan advancing on poor completion no matter who
 * asks — a bug, a stale UI, or a model that decided the user "seems motivated".
 *
 * The one intentional exception is an explicit, confirmed user choice: people are
 * allowed to make their own goals harder, and refusing that would be paternalistic.
 * It is still recorded as source=USER with the real numbers attached.
 */
export async function applyDecision(input: ApplyDecisionInput): Promise<{
  plan: PlanWithStages;
  applied: boolean;
  verdict: ProgressionVerdict;
  reason: string;
}> {
  if (!PROGRESSION_SOURCE.includes(input.source)) {
    throw badRequest(`Unknown decision source "${input.source}"`);
  }

  const plan = await prisma.progressionPlan.findUnique({
    where: { id: input.planId },
    include: { stages: true, taskDefinition: { include: { goal: true } } },
  });
  if (!plan) throw notFound('Progression plan not found');
  if (plan.status !== 'ACTIVE') throw badRequest('This progression plan is no longer active');

  const goal = plan.taskDefinition.goal;
  const { verdict, evidence } = await reviewPlan(plan, input.participantId, goal);

  // The requested action is checked against a verdict computed here and now, from
  // the database. Nothing the caller sends can substitute for it.
  const auth = authorizeAction(
    { action: input.action, source: input.source, userConfirmed: input.userConfirmed },
    verdict,
  );
  const target = auth.allowed ? auth.toStageIndex : plan.currentStageIndex;
  const withinLadder = target >= 0 && target < plan.stages.length;
  const moves = auth.allowed && withinLadder && target !== plan.currentStageIndex;

  const today = todayIn(goal.timezone);

  const decision = await prisma.progressionDecision.create({
    data: {
      planId: plan.id,
      action: input.action,
      fromStageIndex: plan.currentStageIndex,
      toStageIndex: moves ? target : plan.currentStageIndex,
      windowStart: evidence.windowStart,
      windowEnd: evidence.windowEnd,
      completedCount: evidence.completedCount,
      eligibleCount: evidence.eligibleCount,
      completionRate: verdict.completionRate,
      source: input.source,
      reason: decisionReason(input, verdict, auth),
      // An unapplied row is a proposal. ASK_USER, COPILOT suggestions and refusals
      // all land here, which is what keeps "do not auto apply" true by construction.
      appliedAt: moves ? new Date() : null,
    },
  });

  if (!moves) {
    return { plan, applied: false, verdict, reason: decision.reason };
  }

  const updated = await prisma.progressionPlan.update({
    where: { id: plan.id },
    data: {
      currentStageIndex: target,
      // The clock restarts, and it restarts tomorrow — the same day the new target
      // first appears on an occurrence. Dating it today would count today against
      // the new stage while today's task still asks for the old number.
      stageStartedOn: addDays(today, 1),
      lastReviewedOn: today,
    },
    include: { stages: true },
  });

  await stampFutureOccurrences(updated, goal.timezone);

  return { plan: updated, applied: true, verdict, reason: decision.reason };
}

// --------------------------------------------------------------- reading

/**
 * What goes in the audit trail.
 *
 * When the review and the request agree, the review's own wording is the honest
 * account. When they disagree and the change happened anyway, saying "87% —
 * ready for 25" would be a lie: the numbers did not justify it, the user did. So
 * an override records that it was an override, and a refusal records why.
 */
function decisionReason(
  input: ApplyDecisionInput,
  verdict: ProgressionVerdict,
  auth: ActionAuthorization,
): string {
  if (!auth.allowed) return `${input.action} was not applied. ${auth.refusal}`;
  if (input.action === verdict.action) return verdict.reason;
  if (input.action === 'STAY' || input.action === 'ASK_USER') return verdict.reason;
  return `${input.action} chosen by the user over a ${verdict.action} review. ${verdict.reason}`;
}

/** Everything the UI needs to render a progression, including where it stands. */
export async function loadPlanForTask(taskDefinitionId: string): Promise<PlanWithStages | null> {
  return prisma.progressionPlan.findUnique({
    where: { taskDefinitionId },
    include: { stages: { orderBy: { stageIndex: 'asc' } } },
  });
}

export async function loadPlansForGoal(goalId: string): Promise<PlanWithStages[]> {
  return prisma.progressionPlan.findMany({
    where: { taskDefinition: { goalId, archivedAt: null } },
    include: { stages: { orderBy: { stageIndex: 'asc' } } },
  });
}

// ----------------------------------------------------------- serialisation

/**
 * The whole ladder, with each stage marked done, current or still to come. Lives
 * here rather than in the route so the goal detail payload and the progression
 * endpoints describe a plan the same way.
 */
export function serializeProgression(plan: PlanWithStages) {
  const stages = [...plan.stages].sort((a, b) => a.stageIndex - b.stageIndex);
  return {
    ...progressionSummary(plan),
    stageStartedOn: plan.stageStartedOn,
    advanceThreshold: plan.advanceThreshold,
    reduceThreshold: plan.reduceThreshold,
    stages: stages.map((s) => ({
      stageIndex: s.stageIndex,
      target: s.target,
      label: s.label,
      minDays: s.minDays,
      state:
        s.stageIndex < plan.currentStageIndex
          ? 'DONE'
          : s.stageIndex === plan.currentStageIndex
            ? 'CURRENT'
            : 'UPCOMING',
    })),
  };
}

/** Enough to show a chip on a task row — no stage list, no thresholds. */
export function progressionSummary(plan: PlanWithStages) {
  const stages = [...plan.stages].sort((a, b) => a.stageIndex - b.stageIndex);
  const current = stages.find((s) => s.stageIndex === plan.currentStageIndex) ?? null;
  return {
    id: plan.id,
    taskId: plan.taskDefinitionId,
    metricType: plan.metricType,
    unitLabel: plan.unitLabel,
    status: plan.status,
    currentStageIndex: plan.currentStageIndex,
    stageCount: stages.length,
    stageLabel: stageLabel(plan.currentStageIndex, stages.length),
    currentTarget: current?.target ?? null,
  };
}
