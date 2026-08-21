import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isDayString, isTimeString } from '../domain/dates.js';
import { validateRecurrence, type RecurrenceConfig } from '../domain/recurrence.js';
import { stageLabel } from '../domain/progression.js';
import { computeStreak, dailyScore } from '../domain/scoring.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { loadUserDay, totalsFor } from '../services/daily.js';
import { evaluateAchievements, grantReward, revertRewardFor } from '../services/engagement.js';
import { notify } from '../services/notifications.js';
import { loadGoalForUser } from '../services/goals.js';
import { buildScoreInput, ensureOccurrences, goalToday } from '../services/occurrences.js';
import {
  clearFeedback,
  feedbackByOccurrence,
  isDifficultyRating,
  recordFeedback,
} from '../services/task-feedback.js';

export default async function taskRoutes(app: FastifyInstance) {
  /**
   * Everything the Home screen needs to answer "what should I do today?".
   * Grouped by goal, because that is how the dashboard presents it.
   *
   * The numbers come from services/daily.ts, which the 08:00 and 20:30 notification
   * jobs also read — so a summary can never quote a figure this screen disagrees with.
   */
  app.get('/today', { preHandler: app.requireAuth }, async (req) => {
    const days = await loadUserDay(req.user!.id);
    const summary = totalsFor(days);

    const groups = await Promise.all(
      days.map(async (day) => {
        // What the user already said about today, so a rating given an hour ago
        // reads as given rather than being asked for a second time.
        const ratings = await feedbackByOccurrence(day.occurrences.map((o) => o.id));

        const items = day.occurrences
          .map((o) => {
            const plan = o.taskDefinition.progression;
            return {
              occurrenceId: o.id,
              taskId: o.taskDefinitionId,
              title: o.taskDefinition.title,
              description: o.taskDefinition.description,
              reward: o.taskDefinition.reward,
              reminderTime: o.taskDefinition.reminderTime,
              status: o.status,
              dueDate: o.dueDate,
              /** TOO_EASY | JUST_RIGHT | TOO_HARD, or null if unrated. */
              feedback: ratings.get(o.id) ?? null,
              // The target this day was stamped with, not the plan's current one.
              // On a day generated before an advance, these disagree — and the
              // stamp is the honest answer to "what was I asked to do today?".
              progression:
                plan && o.progressionTarget !== null
                  ? {
                      target: o.progressionTarget,
                      unitLabel: plan.unitLabel,
                      metricType: plan.metricType,
                      stageLabel: stageLabel(
                        o.progressionStageIndex ?? plan.currentStageIndex,
                        plan.stages.length,
                      ),
                    }
                  : null,
            };
          })
          .sort((a, b) => (a.reminderTime ?? '99:99').localeCompare(b.reminderTime ?? '99:99'));

        return {
          goalId: day.goal.id,
          goalTitle: day.goal.title,
          category: day.goal.category,
          visibility: day.goal.visibility,
          streak: day.streak.current,
          today: day.today,
          tasks: items,
        };
      }),
    );

    return {
      groups: groups.filter((g) => g.tasks.length > 0),
      summary: {
        required: summary.required,
        completed: summary.completed,
        percent: summary.percent,
        coinsToday: summary.coinsToday,
        streak: summary.streak,
      },
    };
  });

  // ------------------------------------------------------- complete / undo

  app.post('/task-occurrences/:id/complete', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.id;

    const occurrence = await prisma.taskOccurrence.findUnique({
      where: { id },
      include: { participant: { include: { goal: true } }, taskDefinition: true },
    });
    if (!occurrence) throw notFound('Task not found');
    // A participant may only ever touch their own occurrences.
    if (occurrence.participant.userId !== userId) throw forbidden('That is not your task');
    if (occurrence.participant.status !== 'ACTIVE') throw forbidden('You have left this goal');

    const goal = occurrence.participant.goal;
    const today = goalToday(goal);
    if (occurrence.dueDate > today) throw badRequest('That task is not due yet', 'NOT_DUE_YET');

    if (occurrence.status === 'COMPLETED') {
      return { ok: true, alreadyCompleted: true, reward: 0 };
    }

    await prisma.taskOccurrence.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    const reward = occurrence.taskDefinition.reward;
    if (reward > 0) {
      await grantReward({
        userId,
        amount: reward,
        reason: 'TASK_COMPLETED',
        goalId: goal.id,
        taskOccurrenceId: occurrence.id,
      });
    }

    // Recompute from the single source of truth rather than incrementing counters.
    const input = await buildScoreInput(goal, occurrence.participant, today);
    const streak = computeStreak(input, today);
    const score = dailyScore(input, today);

    await prisma.goalParticipant.update({
      where: { id: occurrence.participantId },
      data: {
        currentStreak: streak.current,
        bestStreak: Math.max(streak.best, occurrence.participant.bestStreak),
      },
    });
    const profile = await prisma.profile.findUnique({ where: { userId } });
    if (profile && streak.best > profile.bestStreak) {
      await prisma.profile.update({ where: { userId }, data: { bestStreak: streak.best } });
    }

    const unlocked = await evaluateAchievements(userId, streak.current);

    if (score.required > 0 && score.completed === score.required) {
      await notify({
        userId,
        type: 'PROGRESS',
        title: `${goal.title}: today is done`,
        data: { goalId: goal.id },
      });
    }

    return { ok: true, reward, streak: streak.current, today: score, unlocked };
  });

  app.post('/task-occurrences/:id/undo', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.id;

    const occurrence = await prisma.taskOccurrence.findUnique({
      where: { id },
      include: { participant: { include: { goal: true } } },
    });
    if (!occurrence) throw notFound('Task not found');
    if (occurrence.participant.userId !== userId) throw forbidden('That is not your task');
    if (occurrence.status !== 'COMPLETED') return { ok: true, reward: 0 };

    await prisma.taskOccurrence.update({
      where: { id },
      data: { status: 'PENDING', completedAt: null },
    });
    const reverted = await revertRewardFor(occurrence.id);

    const goal = occurrence.participant.goal;
    const today = goalToday(goal);
    const input = await buildScoreInput(goal, occurrence.participant, today);
    const streak = computeStreak(input, today);

    await prisma.goalParticipant.update({
      where: { id: occurrence.participantId },
      data: { currentStreak: streak.current },
    });

    return { ok: true, reward: -(reverted?.amount ?? 0), streak: streak.current };
  });

  app.post('/task-occurrences/:id/skip', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const occurrence = await prisma.taskOccurrence.findUnique({
      where: { id },
      include: { participant: true },
    });
    if (!occurrence) throw notFound('Task not found');
    if (occurrence.participant.userId !== req.user!.id) throw forbidden('That is not your task');
    if (occurrence.status === 'COMPLETED') {
      throw badRequest('Undo the completion before skipping', 'ALREADY_COMPLETED');
    }

    await prisma.taskOccurrence.update({ where: { id }, data: { status: 'SKIPPED' } });
    return { ok: true };
  });

  // ------------------------------------------------------- difficulty feedback
  //
  // Hung off the occurrence, not the task definition, so the day being rated is
  // whatever day that row is — never a value the client gets to name. Rating a day
  // changes nothing on its own: it is evidence the Copilot may cite and the
  // progression review deliberately ignores.

  app.post('/task-occurrences/:id/feedback', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        rating: z.string().refine(isDifficultyRating, 'Unknown rating'),
        note: z.string().trim().max(500).optional(),
      })
      .parse(req.body);

    const feedback = await recordFeedback({
      occurrenceId: id,
      userId: req.user!.id,
      rating: body.rating,
      note: body.note,
    });
    // Said out loud in the response because it is the whole contract of this
    // endpoint: the plan is untouched, and the client should not redraw as if
    // something moved.
    return { ok: true, feedback, changedPlan: false };
  });

  app.delete('/task-occurrences/:id/feedback', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await clearFeedback({ occurrenceId: id, userId: req.user!.id });
    return { ok: true, feedback: null, changedPlan: false };
  });

  // ------------------------------------------------------- task definitions

  app.patch('/tasks/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(500).optional(),
        reward: z.number().int().min(0).max(1000).optional(),
        reminderTime: z.string().refine(isTimeString, 'Use HH:MM').nullish(),
        endDate: z.string().refine(isDayString).nullish(),
        recurrenceType: z.string().optional(),
        recurrenceConfig: z.record(z.unknown()).optional(),
      })
      .parse(req.body);

    const task = await prisma.taskDefinition.findUnique({ where: { id } });
    if (!task) throw notFound('Task not found');
    await loadGoalForUser(task.goalId, req.user!.id, 'own');

    if (body.recurrenceType) {
      validateRecurrence(
        body.recurrenceType as never,
        (body.recurrenceConfig ?? {}) as RecurrenceConfig,
      );
    }

    const updated = await prisma.taskDefinition.update({
      where: { id },
      data: {
        ...body,
        recurrenceConfig: body.recurrenceConfig
          ? JSON.stringify(body.recurrenceConfig)
          : undefined,
      },
    });

    // A changed schedule can add future days; drop stale future PENDING rows first.
    if (body.recurrenceType || body.recurrenceConfig || body.endDate !== undefined) {
      const goal = await prisma.goal.findUnique({ where: { id: task.goalId } });
      if (goal) {
        await prisma.taskOccurrence.deleteMany({
          where: { taskDefinitionId: id, status: 'PENDING', dueDate: { gt: goalToday(goal) } },
        });
        await ensureOccurrences(task.goalId);
      }
    }

    return { task: { ...updated, recurrenceConfig: JSON.parse(updated.recurrenceConfig || '{}') } };
  });

  app.delete('/tasks/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const task = await prisma.taskDefinition.findUnique({ where: { id } });
    if (!task) throw notFound('Task not found');
    await loadGoalForUser(task.goalId, req.user!.id, 'own');

    // Archive rather than delete: completed history stays intact for streaks and
    // the average leaderboard, but no new occurrences are generated.
    await prisma.taskDefinition.update({ where: { id }, data: { archivedAt: new Date() } });
    await prisma.taskOccurrence.deleteMany({
      where: { taskDefinitionId: id, status: 'PENDING' },
    });
    return { ok: true };
  });
}
