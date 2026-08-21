// Assembling the difficulty-derived offers for one goal.
//
// This is the read side of "the plan could change". It gathers three things the app
// already knows — how each task has been rated, where its ladder stands, and what a
// numeric review makes of that — hands them to the pure rules in
// domain/adjustment.ts, and returns whatever comes back.
//
// Nothing here writes. Applying an offer happens through the progression endpoints
// the user could already reach by hand, which is the point: there is no second,
// AI-shaped route into someone's goal, and the path that does the changing is the
// one that already refuses an advance the numbers do not support and leaves finished
// days exactly as they were.
//
// No model is called. The offers are the same whether the Copilot is switched on,
// switched off, or out of credit.

import {
  deriveAdjustments,
  type AdjustmentInput,
  type AdjustmentOffer,
  type LadderState,
} from '../domain/adjustment.js';
import type { DayString } from '../domain/dates.js';
import { prisma } from '../lib/prisma.js';
import { loadGoalForUser } from './goals.js';
import { ensureOccurrences, goalToday } from './occurrences.js';
import { loadPlansForGoal, reviewPlan } from './progression.js';
import { feedbackSummariesForGoal } from './task-feedback.js';

export interface AdjustmentOffers {
  today: DayString;
  offers: AdjustmentOffer[];
  /**
   * Whether the caller is allowed to act on them. A TaskDefinition and its ladder
   * are shared by everyone in the goal, so only the owner may move a stage — the
   * ratings behind the offer, though, are the caller's own.
   */
  canApply: boolean;
}

export async function buildAdjustmentOffers(
  goalId: string,
  userId: string,
): Promise<AdjustmentOffers> {
  // Participation is proved here, from the session. Nothing downstream takes a
  // participant or user id from the request.
  const { goal, participant, isOwner } = await loadGoalForUser(goalId, userId, 'participate');
  await ensureOccurrences(goalId, [participant!.id]);

  const today = goalToday(goal);
  const [tasks, difficulty, plans] = await Promise.all([
    prisma.taskDefinition.findMany({ where: { goalId, archivedAt: null } }),
    feedbackSummariesForGoal(goalId, participant!.id, today),
    loadPlansForGoal(goalId),
  ]);

  const planByTask = new Map(
    plans.filter((plan) => plan.status === 'ACTIVE').map((plan) => [plan.taskDefinitionId, plan]),
  );

  const inputs: AdjustmentInput[] = [];
  for (const task of tasks) {
    const summary = difficulty.get(task.id) ?? null;
    const plan = planByTask.get(task.id);

    // Reviewing costs a query per ladder, so it is skipped for a task with nothing
    // to say — an unrated task cannot produce an offer whatever its numbers are.
    let ladder: LadderState | null = null;
    if (plan && summary) {
      const { verdict } = await reviewPlan(plan, participant!.id, goal);
      const stages = [...plan.stages].sort((a, b) => a.stageIndex - b.stageIndex);
      const index = plan.currentStageIndex;
      ladder = {
        reviewAction: verdict.action,
        completionRate: verdict.completionRate,
        atFirstStage: index <= 0,
        atFinalStage: index >= stages.length - 1,
        previousTarget: stages.find((s) => s.stageIndex === index - 1)?.target ?? null,
        nextTarget: stages.find((s) => s.stageIndex === index + 1)?.target ?? null,
        unitLabel: plan.unitLabel,
      };
    }

    inputs.push({ taskId: task.id, taskTitle: task.title, difficulty: summary, ladder });
  }

  return { today, offers: deriveAdjustments(inputs), canApply: isOwner };
}
