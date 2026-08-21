import { prisma } from '../lib/prisma.js';
import { notify } from './notifications.js';

/** Coins needed per level. Deliberately simple — motivation, not an economy. */
const COINS_PER_LEVEL = 500;

export const levelFor = (totalCoins: number) => Math.floor(totalCoins / COINS_PER_LEVEL) + 1;

export const levelProgress = (totalCoins: number) => ({
  level: levelFor(totalCoins),
  intoLevel: totalCoins % COINS_PER_LEVEL,
  perLevel: COINS_PER_LEVEL,
  percent: Math.round(((totalCoins % COINS_PER_LEVEL) / COINS_PER_LEVEL) * 100),
});

/** Award coins and keep the denormalised profile total in step. */
export async function grantReward(opts: {
  userId: string;
  amount: number;
  reason: string;
  goalId?: string;
  taskOccurrenceId?: string;
}) {
  const { userId, amount, reason, goalId, taskOccurrenceId } = opts;
  const [transaction] = await prisma.$transaction([
    prisma.rewardTransaction.create({
      data: { userId, amount, reason, goalId, taskOccurrenceId },
    }),
    prisma.profile.update({
      where: { userId },
      data: { totalCoins: { increment: amount } },
    }),
  ]);

  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (profile) {
    const level = levelFor(profile.totalCoins);
    if (level !== profile.level) {
      await prisma.profile.update({ where: { userId }, data: { level } });
    }
  }
  return transaction;
}

/** Reverse the reward for an occurrence exactly once, when a completion is undone. */
export async function revertRewardFor(taskOccurrenceId: string) {
  const existing = await prisma.rewardTransaction.findUnique({ where: { taskOccurrenceId } });
  if (!existing) return null;

  await prisma.$transaction([
    prisma.rewardTransaction.delete({ where: { id: existing.id } }),
    prisma.profile.update({
      where: { userId: existing.userId },
      data: { totalCoins: { decrement: existing.amount } },
    }),
  ]);

  const profile = await prisma.profile.findUnique({ where: { userId: existing.userId } });
  if (profile) {
    // Never let a revert push the balance negative.
    if (profile.totalCoins < 0) {
      await prisma.profile.update({ where: { userId: existing.userId }, data: { totalCoins: 0 } });
    }
    await prisma.profile.update({
      where: { userId: existing.userId },
      data: { level: levelFor(Math.max(0, profile.totalCoins)) },
    });
  }
  return existing;
}

// ------------------------------------------------------------- achievements

export const ACHIEVEMENTS = [
  { code: 'FIRST_TASK', title: 'First Step', description: 'Complete your first task', icon: '✅', reward: 25 },
  { code: 'STREAK_7', title: '7-Day Streak', description: 'Keep a goal alive for 7 days', icon: '🔥', reward: 100 },
  { code: 'STREAK_30', title: '30-Day Streak', description: 'Keep a goal alive for 30 days', icon: '🏆', reward: 500 },
  { code: 'TASKS_30', title: 'Consistent', description: 'Complete 30 tasks', icon: '💪', reward: 150 },
  { code: 'FIRST_GOAL_DONE', title: 'Finisher', description: 'Complete your first goal', icon: '🎯', reward: 200 },
  { code: 'FIRST_FRIEND_CHALLENGE', title: 'Better Together', description: 'Share a goal with a friend', icon: '🤝', reward: 100 },
] as const;

export type AchievementCode = (typeof ACHIEVEMENTS)[number]['code'];

/** Unlock an achievement if it is not already held. Returns it when newly unlocked. */
export async function unlockAchievement(userId: string, code: AchievementCode) {
  const achievement = await prisma.achievement.findUnique({ where: { code } });
  if (!achievement) return null;

  const already = await prisma.userAchievement.findUnique({
    where: { userId_achievementId: { userId, achievementId: achievement.id } },
  });
  if (already) return null;

  await prisma.userAchievement.create({ data: { userId, achievementId: achievement.id } });
  if (achievement.reward > 0) {
    await grantReward({ userId, amount: achievement.reward, reason: 'ACHIEVEMENT' });
  }
  await notify({
    userId,
    type: 'ACHIEVEMENT',
    title: `You unlocked ${achievement.title}`,
    body: achievement.description,
    data: { achievementCode: achievement.code },
  });
  return achievement;
}

/** Re-evaluate the achievements that a task completion can trigger. */
export async function evaluateAchievements(userId: string, currentStreak: number) {
  const unlocked: string[] = [];

  const completedCount = await prisma.taskOccurrence.count({
    where: { status: 'COMPLETED', participant: { userId } },
  });

  const push = async (code: AchievementCode) => {
    const got = await unlockAchievement(userId, code);
    if (got) unlocked.push(got.code);
  };

  if (completedCount >= 1) await push('FIRST_TASK');
  if (completedCount >= 30) await push('TASKS_30');
  if (currentStreak >= 7) await push('STREAK_7');
  if (currentStreak >= 30) await push('STREAK_30');

  const sharedGoals = await prisma.goalParticipant.count({
    where: { userId, status: 'ACTIVE', goal: { participants: { some: { userId: { not: userId } } } } },
  });
  if (sharedGoals > 0) await push('FIRST_FRIEND_CHALLENGE');

  return unlocked;
}
