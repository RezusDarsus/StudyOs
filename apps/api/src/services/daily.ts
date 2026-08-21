// What one user owes today, across every goal they are in.
//
// Extracted so the Home screen and the scheduled notification jobs read the same
// numbers. A morning summary that says three tasks while /today shows four is worse
// than no summary at all, and the only way to guarantee they agree is for both to
// come from here.
//
// This returns raw material, not a payload: the route decorates it with difficulty
// ratings and progression labels, and the jobs only count. Neither shape belongs in
// the other's response.

import type { Goal, GoalParticipant, ProgressionPlan, ProgressionStage, TaskDefinition, TaskOccurrence } from '@prisma/client';
import type { DayString } from '../domain/dates.js';
import { availableTasksOn, computeStreak, dailyScore } from '../domain/scoring.js';
import type { DayScore, ParticipantScoreInput, StreakResult } from '../domain/scoring.js';
import { prisma } from '../lib/prisma.js';
import { buildScoreInput, ensureOccurrences, goalToday } from './occurrences.js';

type OccurrenceWithTask = TaskOccurrence & {
  taskDefinition: TaskDefinition & {
    progression: (ProgressionPlan & { stages: ProgressionStage[] }) | null;
  };
};

export interface GoalDay {
  goal: Goal;
  participant: GoalParticipant;
  /**
   * The current day in the *goal's* timezone, which is not necessarily the user's.
   * Someone in Tbilisi can join a challenge run out of Los Angeles; which occurrences
   * are due is the goal's question, and it answers it in its own zone.
   */
  today: DayString;
  tasks: TaskDefinition[];
  input: ParticipantScoreInput;
  score: DayScore;
  streak: StreakResult;
  /**
   * Today's occurrences, already filtered to what is actually being asked of the user:
   * scheduled-and-available, plus anything already completed. A TIMES_PER_WEEK task
   * whose quota is met has a row for today and is not being asked for.
   */
  occurrences: OccurrenceWithTask[];
  availableIds: Set<string>;
}

/**
 * Every active goal this user is in, with today's state resolved.
 *
 * Materialises missing occurrences on the way through, exactly as the Home screen
 * does — which is what makes the 08:00 job the first reader of a new day for most
 * users, and why it must generate rather than assume they exist.
 */
export async function loadUserDay(userId: string, now = new Date()): Promise<GoalDay[]> {
  const participations = await prisma.goalParticipant.findMany({
    where: { userId, status: 'ACTIVE', goal: { status: 'ACTIVE' } },
    include: { goal: true },
  });

  return Promise.all(
    participations.map(async ({ goal, ...participant }) => {
      await ensureOccurrences(goal.id, [participant.id], now);
      const today = goalToday(goal, now);

      const tasks = await prisma.taskDefinition.findMany({
        where: { goalId: goal.id, archivedAt: null },
      });
      const input = await buildScoreInput(goal, participant, today, tasks);
      const availableIds = new Set(availableTasksOn(input, today));

      const rows = await prisma.taskOccurrence.findMany({
        where: { participantId: participant.id, dueDate: today },
        include: {
          taskDefinition: { include: { progression: { include: { stages: true } } } },
        },
      });

      return {
        goal,
        participant,
        today,
        tasks,
        input,
        score: dailyScore(input, today),
        streak: computeStreak(input, today),
        occurrences: rows.filter(
          (o) => availableIds.has(o.taskDefinitionId) || o.status === 'COMPLETED',
        ),
        availableIds,
      };
    }),
  );
}

export interface DayTotals {
  required: number;
  completed: number;
  /** null when nothing is scheduled anywhere today — "nothing due", never 0%. */
  percent: number | null;
  /** Scheduled, still not done, and not skipped. What a nudge would be about. */
  remaining: number;
  coinsToday: number;
  /** The longest current streak across their goals. */
  streak: number;
}

/** Roll a user's goals up into the numbers the dashboard header and the jobs both use. */
export function totalsFor(days: GoalDay[]): DayTotals {
  let required = 0;
  let completed = 0;
  let coinsToday = 0;
  let streak = 0;

  for (const day of days) {
    required += day.score.required;
    completed += day.score.completed;
    streak = Math.max(streak, day.streak.current);
    for (const occurrence of day.occurrences) {
      if (occurrence.status === 'COMPLETED') coinsToday += occurrence.taskDefinition.reward;
    }
  }

  return {
    required,
    completed,
    percent: required === 0 ? null : Math.round((completed / required) * 100),
    // Counted from `required`/`completed` rather than by filtering occurrences, because
    // those are the numbers the product shows. A TIMES_PER_WEEK task can have a PENDING
    // row today without being required today, and counting it would nag about a task
    // the user is not behind on.
    remaining: Math.max(0, required - completed),
    coinsToday,
    streak,
  };
}

/** Goals with something still outstanding today, most-behind first. */
export function outstandingGoals(days: GoalDay[]): Array<{ title: string; remaining: number; goalId: string }> {
  return days
    .map((day) => ({
      goalId: day.goal.id,
      title: day.goal.title,
      remaining: Math.max(0, day.score.required - day.score.completed),
    }))
    .filter((g) => g.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining || a.title.localeCompare(b.title));
}
