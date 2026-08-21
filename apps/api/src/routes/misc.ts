import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isTimeString, isValidTimezone } from '../domain/dates.js';
import { GOAL_CATEGORY } from '../domain/enums.js';
import { prisma } from '../lib/prisma.js';
import { levelProgress } from '../services/engagement.js';
import { loadGoalForUser, participantSummary } from '../services/goals.js';
import { notificationPayload } from '../services/notifications.js';
import { goalToday } from '../services/occurrences.js';
import { publicUser } from './auth.js';

const timeOfDay = z.string().refine(isTimeString, 'Use HH:MM, 24-hour');

export default async function miscRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ discover

  /** Public challenges only. A private goal can never appear here. */
  app.get('/discover', { preHandler: app.requireAuth }, async (req) => {
    const { q, category } = z
      .object({
        q: z.string().trim().max(80).optional(),
        category: z.enum(GOAL_CATEGORY).optional(),
      })
      .parse(req.query ?? {});

    const goals = await prisma.goal.findMany({
      where: {
        visibility: 'PUBLIC',
        status: 'ACTIVE',
        ...(category ? { category } : {}),
        ...(q ? { OR: [{ title: { contains: q } }, { description: { contains: q } }] } : {}),
      },
      include: {
        owner: { include: { profile: true } },
        _count: { select: { participants: true, tasks: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 60,
    });

    const myParticipations = await prisma.goalParticipant.findMany({
      where: { userId: req.user!.id, status: 'ACTIVE', goalId: { in: goals.map((g) => g.id) } },
      select: { goalId: true },
    });
    const joined = new Set(myParticipations.map((p) => p.goalId));

    return {
      challenges: goals.map((goal) => ({
        id: goal.id,
        title: goal.title,
        description: goal.description,
        category: goal.category,
        participantCount: goal._count.participants,
        taskCount: goal._count.tasks,
        startDate: goal.startDate,
        deadline: goal.deadline,
        owner: {
          id: goal.owner.id,
          name: goal.owner.name,
          avatarEmoji: goal.owner.profile?.avatarEmoji ?? '🐱',
        },
        hasJoined: joined.has(goal.id),
      })),
      categories: GOAL_CATEGORY,
    };
  });

  // ------------------------------------------------------------ notifications

  app.get('/notifications', { preHandler: app.requireAuth }, async (req) => {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });
    return {
      notifications: notifications.map(notificationPayload),
      unread: notifications.filter((n) => !n.readAt).length,
    };
  });

  app.post('/notifications/read', { preHandler: app.requireAuth }, async (req) => {
    const { ids } = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ profile

  app.get('/profile', { preHandler: app.requireAuth }, async (req) => {
    return profilePayload(req.user!.id, req.user!.id);
  });

  app.get('/users/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return profilePayload(id, req.user!.id);
  });

  app.patch('/profile', { preHandler: app.requireAuth }, async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(60).optional(),
        avatarEmoji: z.string().trim().min(1).max(8).optional(),
        bio: z.string().trim().max(300).optional(),
        timezone: z.string().optional(),
        notifications: z
          .object({
            taskReminders: z.boolean().optional(),
            friendActivity: z.boolean().optional(),
            leaderboardUpdates: z.boolean().optional(),
            achievements: z.boolean().optional(),
            morningSummary: z.boolean().optional(),
            eveningCheck: z.boolean().optional(),
            // Read in the profile's own timezone, so no offset is accepted or needed.
            morningTime: timeOfDay.optional(),
            eveningTime: timeOfDay.optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const userId = req.user!.id;
    if (body.name) await prisma.user.update({ where: { id: userId }, data: { name: body.name } });

    await prisma.profile.update({
      where: { userId },
      data: {
        avatarEmoji: body.avatarEmoji,
        bio: body.bio,
        timezone: body.timezone && isValidTimezone(body.timezone) ? body.timezone : undefined,
        notifyTaskReminders: body.notifications?.taskReminders,
        notifyFriendActivity: body.notifications?.friendActivity,
        notifyLeaderboardUpdate: body.notifications?.leaderboardUpdates,
        notifyAchievements: body.notifications?.achievements,
        notifyMorningSummary: body.notifications?.morningSummary,
        notifyEveningCheck: body.notifications?.eveningCheck,
        morningTime: body.notifications?.morningTime,
        eveningTime: body.notifications?.eveningTime,
      },
    });

    return { user: await publicUser(userId) };
  });

  // ------------------------------------------------------------ rewards

  app.get('/rewards', { preHandler: app.requireAuth }, async (req) => {
    const userId = req.user!.id;
    const [profile, transactions, achievements, unlocked] = await Promise.all([
      prisma.profile.findUnique({ where: { userId } }),
      prisma.rewardTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 40,
        include: { goal: { select: { title: true } } },
      }),
      prisma.achievement.findMany({ orderBy: { reward: 'asc' } }),
      prisma.userAchievement.findMany({ where: { userId } }),
    ]);

    const unlockedIds = new Map(unlocked.map((u) => [u.achievementId, u.unlockedAt]));
    const coins = profile?.totalCoins ?? 0;

    return {
      ...levelProgress(coins),
      totalCoins: coins,
      transactions: transactions.map((t) => ({
        id: t.id,
        amount: t.amount,
        reason: t.reason,
        goalTitle: t.goal?.title ?? null,
        createdAt: t.createdAt,
      })),
      achievements: achievements.map((a) => ({
        code: a.code,
        title: a.title,
        description: a.description,
        icon: a.icon,
        reward: a.reward,
        unlockedAt: unlockedIds.get(a.id) ?? null,
      })),
    };
  });
}

/** Profile view. Private goals of another user are never included. */
async function profilePayload(targetId: string, viewerId: string) {
  const user = await publicUser(targetId, viewerId);
  if (!user) return { user: null };

  const isSelf = targetId === viewerId;

  const participations = await prisma.goalParticipant.findMany({
    where: { userId: targetId, status: 'ACTIVE' },
    include: { goal: true },
  });

  const visible = participations.filter(({ goal }) => isSelf || goal.visibility === 'PUBLIC');

  const goals = await Promise.all(
    visible.map(async ({ goal, ...participant }) => {
      const today = goalToday(goal);
      const summary = await participantSummary(goal, participant, today);
      return {
        id: goal.id,
        title: goal.title,
        category: goal.category,
        status: goal.status,
        visibility: goal.visibility,
        progress: summary.progress.percent,
        streak: summary.streak.current,
      };
    }),
  );

  const unlocked = await prisma.userAchievement.findMany({
    where: { userId: targetId },
    include: { achievement: true },
    orderBy: { unlockedAt: 'desc' },
  });

  return {
    user,
    isSelf,
    activeGoals: goals.filter((g) => g.status === 'ACTIVE'),
    completedGoals: goals.filter((g) => g.status === 'COMPLETED'),
    hiddenPrivateGoals: isSelf ? 0 : participations.length - visible.length,
    achievements: unlocked.map((u) => ({
      code: u.achievement.code,
      title: u.achievement.title,
      description: u.achievement.description,
      icon: u.achievement.icon,
      unlockedAt: u.unlockedAt,
    })),
  };
}

// Re-exported so route modules can reuse the same access gate in tests.
export { loadGoalForUser };
