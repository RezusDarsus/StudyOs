import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isDayString, isTimeString, isValidTimezone, todayIn } from '../domain/dates.js';
import {
  GOAL_CATEGORY,
  GOAL_STATUS,
  GOAL_VISIBILITY,
  LEADERBOARD_MODE,
  RECURRENCE_TYPE,
  TARGET_TYPE,
} from '../domain/enums.js';
import { validateRecurrence, type RecurrenceConfig } from '../domain/recurrence.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { notify } from '../services/notifications.js';
import { buildAdjustmentOffers } from '../services/adjustments.js';
import {
  buildLeaderboard,
  loadGoalForUser,
  participantSummary,
} from '../services/goals.js';
import { buildScoreInput, ensureOccurrences, goalToday, scheduleOf } from '../services/occurrences.js';
import { findGoalByCode, issueInviteCode, revokeInviteCode } from '../services/invite-codes.js';
import { loadPlansForGoal, progressionSummary } from '../services/progression.js';
import { feedbackSummariesForGoal } from '../services/task-feedback.js';
import { scoreDays } from '../domain/scoring.js';

const dayString = z.string().refine(isDayString, 'Expected a YYYY-MM-DD date');

const recurrenceConfigSchema = z
  .object({
    weekdays: z.array(z.number().int()).optional(),
    timesPerWeek: z.number().int().optional(),
    allowedWeekdays: z.array(z.number().int()).optional(),
    excludedWeekdays: z.array(z.number().int()).optional(),
    intervalDays: z.number().int().optional(),
    dayOfMonth: z.union([z.number().int(), z.literal('LAST')]).optional(),
    intervalMonths: z.number().int().optional(),
    activeFrom: dayString.optional(),
    activeUntil: dayString.optional(),
    excludedMonths: z.array(z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)).optional(),
  })
  .default({});

const taskSchema = z.object({
  title: z.string().trim().min(1, 'Give the task a name').max(120),
  description: z.string().trim().max(500).default(''),
  recurrenceType: z.enum(RECURRENCE_TYPE),
  recurrenceConfig: recurrenceConfigSchema,
  reward: z.number().int().min(0).max(1000).default(10),
  startDate: dayString.optional(),
  endDate: dayString.nullish(),
  reminderTime: z
    .string()
    .refine(isTimeString, 'Use HH:MM')
    .nullish(),
});

const createGoalSchema = z.object({
  title: z.string().trim().min(1, 'Give your goal a name').max(120),
  description: z.string().trim().max(1000).default(''),
  category: z.enum(GOAL_CATEGORY),
  visibility: z.enum(GOAL_VISIBILITY).default('PRIVATE'),
  targetType: z.enum(TARGET_TYPE),
  targetValue: z.number().int().min(1).max(100000).nullish(),
  startDate: dayString.optional(),
  deadline: dayString.nullish(),
  timezone: z.string().optional(),
  tasks: z.array(taskSchema).max(30).default([]),
});

function validateTargetShape(input: z.infer<typeof createGoalSchema>) {
  if ((input.targetType === 'QUANTITY' || input.targetType === 'WEEKLY_TARGET') && !input.targetValue) {
    throw badRequest('That target type needs a target value', 'TARGET_VALUE_REQUIRED');
  }
  if (input.targetType === 'DEADLINE' && !input.deadline) {
    throw badRequest('A deadline goal needs a deadline date', 'DEADLINE_REQUIRED');
  }
  if (input.deadline && input.startDate && input.deadline < input.startDate) {
    throw badRequest('The deadline cannot be before the start date', 'DEADLINE_BEFORE_START');
  }
}

export default async function goalRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ list / create

  app.get('/goals', { preHandler: app.requireAuth }, async (req) => {
    const query = z
      .object({ status: z.enum(GOAL_STATUS).optional() })
      .parse(req.query ?? {});
    const userId = req.user!.id;

    const participations = await prisma.goalParticipant.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        goal: query.status ? { status: query.status } : undefined,
      },
      include: { goal: { include: { _count: { select: { participants: true, tasks: true } } } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      goals: await Promise.all(
        participations.map(async ({ goal, ...participant }) => {
          await ensureOccurrences(goal.id, [participant.id]);
          const today = goalToday(goal);
          const summary = await participantSummary(goal, participant, today);
          return {
            ...serializeGoal(goal),
            participantCount: goal._count.participants,
            taskCount: goal._count.tasks,
            progress: summary.progress.percent,
            streak: summary.streak.current,
            todayCompleted: summary.today.completed,
            todayRequired: summary.today.required,
          };
        }),
      ),
    };
  });

  app.post('/goals', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = createGoalSchema.parse(req.body);
    const userId = req.user!.id;

    const profile = await prisma.profile.findUnique({ where: { userId } });
    const timezone =
      body.timezone && isValidTimezone(body.timezone)
        ? body.timezone
        : (profile?.timezone ?? 'UTC');
    const startDate = body.startDate ?? todayIn(timezone);

    validateTargetShape({ ...body, startDate });
    for (const task of body.tasks) {
      validateRecurrence(task.recurrenceType, task.recurrenceConfig as RecurrenceConfig);
    }

    const goal = await prisma.goal.create({
      data: {
        ownerId: userId,
        title: body.title,
        description: body.description,
        category: body.category,
        visibility: body.visibility,
        targetType: body.targetType,
        targetValue: body.targetValue ?? null,
        timezone,
        startDate,
        deadline: body.deadline ?? null,
        participants: {
          create: { userId, role: 'OWNER', joinedOn: startDate },
        },
        tasks: {
          create: body.tasks.map((task) => ({
            title: task.title,
            description: task.description,
            recurrenceType: task.recurrenceType,
            recurrenceConfig: JSON.stringify(task.recurrenceConfig ?? {}),
            reward: task.reward,
            startDate: task.startDate ?? startDate,
            endDate: task.endDate ?? body.deadline ?? null,
            reminderTime: task.reminderTime ?? null,
          })),
        },
      },
    });

    // Private goals are shareable by design, so give every new private goal a
    // revocable code immediately instead of waiting for the owner to discover the
    // Share link action.
    if (goal.visibility === 'PRIVATE') {
      await issueInviteCode(goal.id);
    }

    await ensureOccurrences(goal.id);
    reply.status(201);
    return { goal: serializeGoal(goal) };
  });

  // ------------------------------------------------------------ single goal

  app.get('/goals/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.id;
    const { goal, participant, isOwner } = await loadGoalForUser(id, userId, 'read');

    // Backfill codes for private goals created before automatic code generation was
    // added. Only the owner ever receives this value in the response.
    if (isOwner && goal.visibility === 'PRIVATE' && !goal.inviteCode) {
      goal.inviteCode = await issueInviteCode(goal.id);
    }

    if (participant) await ensureOccurrences(goal.id, [participant.id]);
    const today = goalToday(goal);
    const tasks = await prisma.taskDefinition.findMany({
      where: { goalId: goal.id, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    // Which of these tasks climb a ladder, fetched once for the whole goal so the
    // task list can show "Stage 2 of 4" without a request per row.
    const plans = await loadPlansForGoal(goal.id);
    const planByTask = new Map(plans.map((p) => [p.taskDefinitionId, p]));

    // How each task has been feeling to *this* participant. Absent for a visitor
    // reading a public goal — there is nobody whose ratings those would be.
    const difficultyByTask = participant
      ? await feedbackSummariesForGoal(goal.id, participant.id, today)
      : new Map();

    let me = null;
    let history: Array<{ day: string; percent: number | null; completed: number; required: number }> = [];
    if (participant) {
      const summary = await participantSummary(goal, participant, today);
      const input = await buildScoreInput(goal, participant, today, tasks);
      history = scoreDays(input).slice(-30);
      me = {
        participantId: participant.id,
        progress: summary.progress,
        streak: summary.streak,
        today: summary.today,
        average: summary.average,
      };
    }

    return {
      goal: {
        ...serializeGoal(goal),
        owner: {
          id: goal.owner.id,
          name: goal.owner.name,
          avatarEmoji: goal.owner.profile?.avatarEmoji ?? '🐱',
        },
        participantCount: goal._count.participants,
        isOwner,
        isParticipant: Boolean(participant),
        // Only the owner ever receives the code itself.
        inviteCode: isOwner ? goal.inviteCode : null,
      },
      tasks: tasks.map((task) => {
        const plan = planByTask.get(task.id);
        return {
          ...serializeTask(task),
          progression: plan ? progressionSummary(plan) : null,
          difficulty: difficultyByTask.get(task.id) ?? null,
        };
      }),
      participants: goal.participants
        .filter((p) => p.status === 'ACTIVE')
        .map((p) => ({
          id: p.id,
          userId: p.userId,
          name: p.user.name,
          avatarEmoji: p.user.profile?.avatarEmoji ?? '🐱',
          role: p.role,
          joinedOn: p.joinedOn,
          isMe: p.userId === userId,
        })),
      me,
      history,
      today,
    };
  });

  /**
   * Changes worth offering, derived from how the participant has rated their days.
   *
   * A read, and a cheap one: no model is called, so this works with the Copilot off
   * and costs nothing to poll. Every offer points at the progression endpoints —
   * there is no apply route here, because there is no adjustment the user could not
   * already make by hand, and inventing a second one would be a second way to change
   * a goal that has to be secured all over again.
   */
  app.get('/goals/:id/adjustments', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return await buildAdjustmentOffers(id, req.user!.id);
  });

  app.patch('/goals/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(1000).optional(),
        category: z.enum(GOAL_CATEGORY).optional(),
        visibility: z.enum(GOAL_VISIBILITY).optional(),
        status: z.enum(GOAL_STATUS).optional(),
        deadline: dayString.nullish(),
      })
      .parse(req.body);

    const { goal } = await loadGoalForUser(id, req.user!.id, 'own');
    if (body.deadline && body.deadline < goal.startDate) {
      throw badRequest('The deadline cannot be before the start date', 'DEADLINE_BEFORE_START');
    }

    const updated = await prisma.goal.update({ where: { id }, data: body });
    return { goal: serializeGoal(updated) };
  });

  app.delete('/goals/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadGoalForUser(id, req.user!.id, 'own');
    await prisma.goal.delete({ where: { id } });
    return { ok: true };
  });

  // ------------------------------------------------------------ tasks

  app.post('/goals/:id/tasks', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = taskSchema.parse(req.body);
    const { goal } = await loadGoalForUser(id, req.user!.id, 'own');
    validateRecurrence(body.recurrenceType, body.recurrenceConfig as RecurrenceConfig);

    const task = await prisma.taskDefinition.create({
      data: {
        goalId: goal.id,
        title: body.title,
        description: body.description,
        recurrenceType: body.recurrenceType,
        recurrenceConfig: JSON.stringify(body.recurrenceConfig ?? {}),
        reward: body.reward,
        startDate: body.startDate ?? goalToday(goal),
        endDate: body.endDate ?? goal.deadline,
        reminderTime: body.reminderTime ?? null,
      },
    });

    await ensureOccurrences(goal.id);
    reply.status(201);
    return { task: serializeTask(task) };
  });

  // ------------------------------------------------------------ participants

  app.post('/goals/:id/join', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.id;

    const goal = await prisma.goal.findUnique({ where: { id } });
    if (!goal) throw notFound('Goal not found');
    // Only public challenges are joinable directly; private ones need an invite.
    if (goal.visibility !== 'PUBLIC') throw notFound('Goal not found');
    if (goal.status !== 'ACTIVE') throw badRequest('This challenge is no longer active', 'NOT_ACTIVE');

    const existing = await prisma.goalParticipant.findUnique({
      where: { goalId_userId: { goalId: id, userId } },
    });
    if (existing?.status === 'ACTIVE') throw conflict('You have already joined', 'ALREADY_JOINED');

    const today = goalToday(goal);
    // Joining never touches the other participants — they keep their own progress.
    const participant = existing
      ? await prisma.goalParticipant.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', leftOn: null, joinedOn: today },
        })
      : await prisma.goalParticipant.create({
          data: { goalId: id, userId, role: 'MEMBER', joinedOn: today },
        });

    await ensureOccurrences(id, [participant.id]);
    if (goal.ownerId !== userId) {
      await notify({
        userId: goal.ownerId,
        type: 'FRIEND',
        title: `${req.user!.name} joined ${goal.title}`,
        data: { goalId: goal.id },
      });
    }
    return { ok: true, participantId: participant.id };
  });

  app.post('/goals/:id/leave', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { goal, participant, isOwner } = await loadGoalForUser(id, req.user!.id, 'participate');
    if (isOwner) throw badRequest('The owner cannot leave their own goal', 'OWNER_CANNOT_LEAVE');

    await prisma.goalParticipant.update({
      where: { id: participant!.id },
      data: { status: 'LEFT', leftOn: goalToday(goal) },
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ leaderboard

  app.get('/goals/:id/leaderboard', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mode } = z
      .object({ mode: z.enum(LEADERBOARD_MODE).default('daily') })
      .parse(req.query ?? {});

    // Reading a leaderboard requires the same access as reading the goal.
    await loadGoalForUser(id, req.user!.id, 'read');
    const board = await buildLeaderboard(id, mode);

    return {
      ...board,
      entries: board.entries.map((entry) => ({ ...entry, isMe: entry.userId === req.user!.id })),
    };
  });

  // ------------------------------------------------------- shareable code

  /**
   * Create or rotate the goal's share code. Owner only.
   * Rotating invalidates the previous link, which is how a leaked code is killed.
   */
  app.post('/goals/:id/invite-code', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadGoalForUser(id, req.user!.id, 'own');
    const code = await issueInviteCode(id);
    return { code };
  });

  app.delete('/goals/:id/invite-code', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadGoalForUser(id, req.user!.id, 'own');
    await revokeInviteCode(id);
    return { ok: true };
  });

  /**
   * Preview a shared goal. Deliberately UNAUTHENTICATED: the whole point of the
   * link is that someone without an account can open it, see what they are being
   * invited to, and then sign up.
   *
   * Only what a share card needs is exposed — never participants, progress,
   * leaderboards or anyone's personal data.
   */
  app.get('/join/:code', async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const goal = await findGoalByCode(code);
    if (!goal) throw notFound('That invite link is invalid or has been revoked');
    if (goal.status !== 'ACTIVE') throw badRequest('This goal is no longer active', 'NOT_ACTIVE');

    let alreadyJoined = false;
    if (req.user) {
      const participant = await prisma.goalParticipant.findUnique({
        where: { goalId_userId: { goalId: goal.id, userId: req.user.id } },
      });
      alreadyJoined = participant?.status === 'ACTIVE';
    }

    return {
      goal: {
        id: goal.id,
        title: goal.title,
        description: goal.description,
        category: goal.category,
        visibility: goal.visibility,
        participantCount: goal._count.participants,
        taskCount: goal._count.tasks,
        startDate: goal.startDate,
        deadline: goal.deadline,
        ownerName: goal.owner.name,
        ownerAvatar: goal.owner.profile?.avatarEmoji ?? '🐱',
      },
      alreadyJoined,
    };
  });

  /** Redeem a share code. Works for a private goal — the code IS the grant. */
  app.post('/join/:code', { preHandler: app.requireAuth }, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const userId = req.user!.id;

    const goal = await findGoalByCode(code);
    if (!goal) throw notFound('That invite link is invalid or has been revoked');
    if (goal.status !== 'ACTIVE') throw badRequest('This goal is no longer active', 'NOT_ACTIVE');

    const existing = await prisma.goalParticipant.findUnique({
      where: { goalId_userId: { goalId: goal.id, userId } },
    });
    if (existing?.status === 'ACTIVE') {
      return { ok: true, goalId: goal.id, alreadyJoined: true };
    }

    const today = goalToday(goal);
    // Joining never disturbs the existing participants' progress.
    const participant = existing
      ? await prisma.goalParticipant.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', leftOn: null, joinedOn: today },
        })
      : await prisma.goalParticipant.create({
          data: { goalId: goal.id, userId, role: 'MEMBER', joinedOn: today },
        });

    await ensureOccurrences(goal.id, [participant.id]);
    if (goal.ownerId !== userId) {
      await notify({
        userId: goal.ownerId,
        type: 'FRIEND',
        title: `${req.user!.name} joined ${goal.title}`,
        body: 'via your invite link',
        data: { goalId: goal.id },
      });
    }
    return { ok: true, goalId: goal.id, alreadyJoined: false };
  });

  // ------------------------------------------------------------ invitations

  app.post('/goals/:id/invite', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { userIds } = z.object({ userIds: z.array(z.string()).min(1).max(20) }).parse(req.body);
    const inviterId = req.user!.id;

    const { goal } = await loadGoalForUser(id, inviterId, 'participate');

    // You may only invite people you are actually friends with.
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { userAId: inviterId, userBId: { in: userIds } },
          { userBId: inviterId, userAId: { in: userIds } },
        ],
      },
    });
    const friendIds = new Set(
      friendships.map((f) => (f.userAId === inviterId ? f.userBId : f.userAId)),
    );
    const invitable = userIds.filter((uid) => friendIds.has(uid));
    if (invitable.length === 0) throw forbidden('You can only invite your friends');

    const created: string[] = [];
    for (const inviteeId of invitable) {
      const already = await prisma.goalParticipant.findUnique({
        where: { goalId_userId: { goalId: id, userId: inviteeId } },
      });
      if (already?.status === 'ACTIVE') continue;

      const invitation = await prisma.goalInvitation.upsert({
        where: { goalId_inviteeId: { goalId: id, inviteeId } },
        create: { goalId: id, inviterId, inviteeId, status: 'PENDING' },
        update: { status: 'PENDING', inviterId, respondedAt: null },
      });
      await notify({
        userId: inviteeId,
        type: 'FRIEND',
        title: `${req.user!.name} invited you to ${goal.title}`,
        body: goal.description,
        // The invitee cannot open a private goal until they accept this invitation.
        // Deep-link the notification to the invitation itself instead of only the goal.
        data: { goalId: goal.id, invitationId: invitation.id },
      });
      created.push(inviteeId);
    }

    return { ok: true, invited: created };
  });
}

// ------------------------------------------------------------------ shaping

function serializeGoal(goal: {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  category: string;
  visibility: string;
  status: string;
  targetType: string;
  targetValue: number | null;
  timezone: string;
  startDate: string;
  deadline: string | null;
  createdAt: Date;
}) {
  return {
    id: goal.id,
    ownerId: goal.ownerId,
    title: goal.title,
    description: goal.description,
    category: goal.category,
    visibility: goal.visibility,
    status: goal.status,
    targetType: goal.targetType,
    targetValue: goal.targetValue,
    timezone: goal.timezone,
    startDate: goal.startDate,
    deadline: goal.deadline,
    createdAt: goal.createdAt,
  };
}

function serializeTask(task: Parameters<typeof scheduleOf>[0]) {
  return {
    id: task.id,
    goalId: task.goalId,
    title: task.title,
    description: task.description,
    recurrenceType: task.recurrenceType,
    recurrenceConfig: JSON.parse(task.recurrenceConfig || '{}'),
    reward: task.reward,
    startDate: task.startDate,
    endDate: task.endDate,
    reminderTime: task.reminderTime,
  };
}
