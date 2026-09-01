import type { Goal, GoalParticipant, TaskDefinition } from '@prisma/client';
import type { DbClient } from '../capabilities/types.js';
import { type DayString, addDays, maxDay, minDay, todayIn } from '../domain/dates.js';
import { occurrenceDays, parseRecurrenceConfig, type TaskSchedule } from '../domain/recurrence.js';
import type { ParticipantScoreInput } from '../domain/scoring.js';
import type { RecurrenceType } from '../domain/enums.js';
import { prisma } from '../lib/prisma.js';
import { stampForNewOccurrence } from './progression.js';

/** How far ahead of today occurrences are materialised. */
const LOOKAHEAD_DAYS = 14;

export function scheduleOf(task: TaskDefinition): TaskSchedule {
  return {
    recurrenceType: task.recurrenceType as RecurrenceType,
    recurrenceConfig: parseRecurrenceConfig(task.recurrenceConfig),
    startDate: task.startDate,
    endDate: task.endDate,
  };
}

/** The current challenge day for a goal, in the goal's own timezone. */
export function goalToday(goal: Pick<Goal, 'timezone'>, now = new Date()): DayString {
  return todayIn(goal.timezone, now);
}

/**
 * The window a participant is scored over: never before the goal started or
 * before they joined, never after they left or after the deadline.
 */
export function scoringWindow(
  goal: Pick<Goal, 'startDate' | 'deadline'>,
  participant: Pick<GoalParticipant, 'joinedOn' | 'leftOn'>,
  today: DayString,
): { from: DayString; to: DayString } {
  const from = maxDay(goal.startDate, participant.joinedOn);
  let to = today;
  if (participant.leftOn) to = minDay(to, participant.leftOn);
  if (goal.deadline) to = minDay(to, goal.deadline);
  return { from, to };
}

/**
 * Materialise the TaskOccurrence rows a participant should have.
 *
 * Occurrences are generated lazily (on read) rather than by a cron job, so the
 * app has no background scheduler to keep alive and a participant who joins mid
 * challenge immediately gets their own rows — never anyone else's.
 */
export async function ensureOccurrences(
  goalId: string,
  participantIds?: string[],
  now = new Date(),
  client: DbClient = prisma,
): Promise<void> {
  const goal = await client.goal.findUnique({
    where: { id: goalId },
    include: {
      // The progression plan comes along for the ride so each new day can be born
      // with its stage target already stamped on it.
      tasks: {
        where: { archivedAt: null },
        include: { progression: { include: { stages: true } } },
      },
      participants: participantIds
        ? { where: { id: { in: participantIds }, status: 'ACTIVE' } }
        : { where: { status: 'ACTIVE' } },
    },
  });
  if (!goal || goal.tasks.length === 0 || goal.participants.length === 0) return;

  const today = goalToday(goal, now);
  const horizon = addDays(today, LOOKAHEAD_DAYS);

  const rows: Array<{
    taskDefinitionId: string;
    participantId: string;
    dueDate: DayString;
    progressionStageIndex?: number;
    progressionTarget?: number;
  }> = [];

  for (const participant of goal.participants) {
    const from = maxDay(goal.startDate, participant.joinedOn);
    let to = horizon;
    if (participant.leftOn) to = minDay(to, participant.leftOn);
    if (goal.deadline) to = minDay(to, goal.deadline);
    if (to < from) continue;

    for (const task of goal.tasks) {
      const stamp = stampForNewOccurrence(task.progression);
      for (const dueDate of occurrenceDays(scheduleOf(task), from, to)) {
        rows.push({
          taskDefinitionId: task.id,
          participantId: participant.id,
          dueDate,
          ...(stamp ?? {}),
        });
      }
    }
  }

  if (rows.length === 0) return;

  // Read the already-materialised rows once and filter them out here rather than
  // relying on createMany's `skipDuplicates`. Both work on PostgreSQL; this keeps the
  // insert an all-or-nothing statement and makes "how many were actually new?"
  // answerable, which matters because this runs on every read of a day. The unique
  // index remains the real guard against duplicates.
  const existing = await client.taskOccurrence.findMany({
    where: {
      participantId: { in: goal.participants.map((p) => p.id) },
      taskDefinitionId: { in: goal.tasks.map((t) => t.id) },
    },
    select: { taskDefinitionId: true, participantId: true, dueDate: true },
  });
  const seen = new Set(
    existing.map((o) => `${o.taskDefinitionId}|${o.participantId}|${o.dueDate}`),
  );

  const missing = rows.filter(
    (r) => !seen.has(`${r.taskDefinitionId}|${r.participantId}|${r.dueDate}`),
  );
  if (missing.length === 0) return;

  await client.taskOccurrence.createMany({ data: missing });
}

/**
 * Assemble the pure scoring input for one participant. Everything the product
 * shows about progress — today's percentage, goal progress, streaks and both
 * leaderboards — is derived from this one shape.
 */
export async function buildScoreInput(
  goal: Pick<Goal, 'id' | 'startDate' | 'deadline' | 'timezone'>,
  participant: Pick<GoalParticipant, 'id' | 'joinedOn' | 'leftOn'>,
  today: DayString,
  tasks?: TaskDefinition[],
): Promise<ParticipantScoreInput> {
  const taskRows =
    tasks ??
    (await prisma.taskDefinition.findMany({ where: { goalId: goal.id, archivedAt: null } }));

  const completed = await prisma.taskOccurrence.findMany({
    where: { participantId: participant.id, status: 'COMPLETED' },
    select: { taskDefinitionId: true, dueDate: true },
  });

  const { from, to } = scoringWindow(goal, participant, today);

  return {
    tasks: taskRows.map((task) => ({ taskId: task.id, schedule: scheduleOf(task) })),
    completions: completed.map((o) => ({ taskId: o.taskDefinitionId, day: o.dueDate })),
    from,
    to,
  };
}
