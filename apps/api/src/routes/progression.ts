import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROGRESSION_METRIC } from '../domain/enums.js';
import { badRequest, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { loadGoalForUser } from '../services/goals.js';
import { goalToday } from '../services/occurrences.js';
import {
  applyDecision,
  createProgressionPlan,
  loadPlanForTask,
  reviewPlan,
  serializeProgression,
} from '../services/progression.js';

/**
 * Progression endpoints.
 *
 * The read endpoints are open to any participant, because seeing the ladder is
 * part of understanding the goal. Creating or changing one is the owner's, since
 * in a shared challenge a stage change affects everyone's tasks.
 *
 * There is deliberately no endpoint that applies a Copilot suggestion. The
 * Copilot proposes through /review; the user applies through /decision, and that
 * request carries source=USER because it came from a person pressing a button.
 */
export default async function progressionRoutes(app: FastifyInstance) {
  /** The participant row used to score a review, for the calling user. */
  async function participantFor(goalId: string, userId: string) {
    const participant = await prisma.goalParticipant.findFirst({
      where: { goalId, userId, status: 'ACTIVE' },
    });
    if (!participant) throw badRequest('Join the goal before reviewing its progression');
    return participant;
  }

  async function loadTask(taskId: string, userId: string, need: 'read' | 'own') {
    const task = await prisma.taskDefinition.findUnique({ where: { id: taskId } });
    if (!task) throw notFound('Task not found');
    const { goal } = await loadGoalForUser(task.goalId, userId, need);
    return { task, goal };
  }

  // ------------------------------------------------------------------ read

  app.get('/tasks/:id/progression', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadTask(id, req.user!.id, 'read');

    const plan = await loadPlanForTask(id);
    if (!plan) return { progression: null, history: [] };

    // The audit trail, most recent first. Unapplied rows are proposals and are
    // labelled as such rather than hidden.
    const history = await prisma.progressionDecision.findMany({
      where: { planId: plan.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      progression: serializeProgression(plan),
      history: history.map((d) => ({
        id: d.id,
        action: d.action,
        fromStageIndex: d.fromStageIndex,
        toStageIndex: d.toStageIndex,
        completionRate: d.completionRate,
        completedCount: d.completedCount,
        eligibleCount: d.eligibleCount,
        windowStart: d.windowStart,
        windowEnd: d.windowEnd,
        source: d.source,
        reason: d.reason,
        applied: d.appliedAt !== null,
        createdAt: d.createdAt,
      })),
    };
  });

  /**
   * What a review would conclude right now. Read-only on purpose: this is what the
   * progression card and the Copilot both quote, and neither of them may change a
   * stage by asking about it.
   */
  app.get('/tasks/:id/progression/review', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { task, goal } = await loadTask(id, req.user!.id, 'read');

    const plan = await loadPlanForTask(id);
    if (!plan) throw notFound('This task has no progression plan');

    const participant = await participantFor(task.goalId, req.user!.id);
    const { verdict, evidence } = await reviewPlan(plan, participant.id, goal);

    return {
      progression: serializeProgression(plan),
      review: {
        ...verdict,
        ...evidence,
        // Nothing has happened yet, and the client should say so.
        applied: false,
        needsConfirmation: verdict.action === 'ASK_USER',
      },
    };
  });

  // ---------------------------------------------------------------- create

  app.post('/tasks/:id/progression', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        metricType: z.enum(PROGRESSION_METRIC),
        unitLabel: z.string().trim().max(16).optional(),
        advanceThreshold: z.number().int().min(1).max(100).optional(),
        reduceThreshold: z.number().int().min(0).max(99).optional(),
        stages: z
          .array(
            z.object({
              target: z.number().int().min(1).max(100_000),
              label: z.string().trim().max(80).optional(),
              minDays: z.number().int().min(1).max(90).optional(),
            }),
          )
          .min(2)
          .max(12),
      })
      .parse(req.body);

    await loadTask(id, req.user!.id, 'own');
    const plan = await createProgressionPlan({ taskDefinitionId: id, ...body });
    return { progression: serializeProgression(plan) };
  });

  app.delete('/tasks/:id/progression', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { goal } = await loadTask(id, req.user!.id, 'own');

    const plan = await loadPlanForTask(id);
    if (!plan) return { ok: true };

    await prisma.progressionPlan.delete({ where: { id: plan.id } });

    // Clear the stamps from days that have not happened yet. Past days keep
    // theirs: the task really did ask for that number at the time.
    await prisma.taskOccurrence.updateMany({
      where: { taskDefinitionId: id, dueDate: { gt: goalToday(goal) } },
      data: { progressionStageIndex: null, progressionTarget: null },
    });

    return { ok: true };
  });

  // ----------------------------------------------------------------- apply

  /**
   * Apply an action. The body is a request, not an instruction: the service
   * recomputes the verdict from the database and refuses anything the numbers do
   * not support, so a stale screen or a confident model cannot force an advance.
   */
  app.post('/tasks/:id/progression/decision', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        action: z.enum(['ADVANCE', 'STAY', 'REDUCE', 'ASK_USER']),
        /** Required to move a plan against a STAY or ASK_USER verdict. */
        confirmed: z.boolean().optional(),
      })
      .parse(req.body);

    // Only the owner may move the ladder: the TaskDefinition is shared, so a stage
    // change alters the task for every participant in the goal.
    const { task } = await loadTask(id, req.user!.id, 'own');

    const plan = await loadPlanForTask(id);
    if (!plan) throw notFound('This task has no progression plan');

    const participant = await participantFor(task.goalId, req.user!.id);

    const result = await applyDecision({
      planId: plan.id,
      participantId: participant.id,
      action: body.action,
      // The route is reached by a signed-in person pressing a button. Nothing here
      // can claim to be the Copilot or a scheduled job.
      source: 'USER',
      userConfirmed: body.confirmed === true,
    });

    return {
      applied: result.applied,
      reason: result.reason,
      review: result.verdict,
      progression: serializeProgression(result.plan),
    };
  });
}
