// Storing and reading back "how did that feel?".
//
// The store is deliberately thin. Nothing here decides anything: it records what
// the user said about a day they have already lived, and hands the raw ratings to
// domain/feedback.ts to be summarised. Anything that acts on a summary — a Copilot
// suggestion, an offer to ease a task off — does so somewhere else, behind an
// explicit confirmation.

import { addDays, compareDays, type DayString } from '../domain/dates.js';
import { DIFFICULTY_RATING, type DifficultyRating } from '../domain/enums.js';
import {
  FEEDBACK_WINDOW_DAYS,
  summarizeFeedback,
  type FeedbackSummary,
} from '../domain/feedback.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { goalToday } from './occurrences.js';

export function isDifficultyRating(value: string): value is DifficultyRating {
  return (DIFFICULTY_RATING as readonly string[]).includes(value);
}

/**
 * Find the occurrence being rated and prove it is the caller's to rate.
 *
 * The occurrence id is the only thing taken from the request. Everything the row
 * is then written with — participant, task, day — is read from the database, so a
 * client cannot rate someone else's task, cannot claim a different participant id,
 * and cannot decide which day its rating lands on.
 */
async function loadRatableOccurrence(occurrenceId: string, userId: string) {
  const occurrence = await prisma.taskOccurrence.findUnique({
    where: { id: occurrenceId },
    include: { participant: { include: { goal: true } } },
  });
  if (!occurrence) throw notFound('Task not found');
  if (occurrence.participant.userId !== userId) throw forbidden('That is not your task');

  const today = goalToday(occurrence.participant.goal);
  // A day that has not arrived cannot have felt like anything yet. Same guard the
  // complete endpoint uses, for the same reason.
  if (compareDays(occurrence.dueDate, today) > 0) {
    throw badRequest('That day has not happened yet', 'NOT_DUE_YET');
  }

  return { occurrence, today };
}

/**
 * Record — or change — how a task felt on one day.
 *
 * An upsert rather than an insert: people mis-tap, and reconsider. The unique
 * index on the occurrence is what makes the second tap a correction instead of a
 * second vote skewing the count.
 */
export async function recordFeedback(input: {
  occurrenceId: string;
  userId: string;
  rating: DifficultyRating;
  note?: string;
}) {
  const { occurrence } = await loadRatableOccurrence(input.occurrenceId, input.userId);
  const note = (input.note ?? '').trim().slice(0, 500);

  const existing = await prisma.taskFeedback.findUnique({
    where: { taskOccurrenceId: occurrence.id },
    select: { rating: true },
  });

  // A note explains a rating; it does not outlive one. Switching from "too hard —
  // knees" to "too easy" and keeping the note would leave the Copilot quoting
  // "knees" as a reason the task is too easy. Same rating and no new note, though,
  // and the note stands: nothing was said to replace it.
  const nextNote =
    input.note !== undefined ? note : existing && existing.rating !== input.rating ? '' : undefined;

  const feedback = await prisma.taskFeedback.upsert({
    where: { taskOccurrenceId: occurrence.id },
    create: {
      taskOccurrenceId: occurrence.id,
      taskDefinitionId: occurrence.taskDefinitionId,
      participantId: occurrence.participantId,
      day: occurrence.dueDate,
      rating: input.rating,
      note,
    },
    update: { rating: input.rating, note: nextNote },
  });

  return {
    occurrenceId: occurrence.id,
    day: feedback.day,
    rating: feedback.rating as DifficultyRating,
    note: feedback.note,
  };
}

/** Withdraw a rating entirely, for the mis-tap that should not have been logged. */
export async function clearFeedback(input: { occurrenceId: string; userId: string }) {
  const { occurrence } = await loadRatableOccurrence(input.occurrenceId, input.userId);
  await prisma.taskFeedback.deleteMany({ where: { taskOccurrenceId: occurrence.id } });
  return { occurrenceId: occurrence.id, rating: null };
}

/**
 * What the participant said about each of a goal's tasks lately, keyed by task id.
 *
 * One query for the whole goal: the goal detail page and the Copilot both want
 * every task at once, and a request per row would be silly.
 */
export async function feedbackSummariesForGoal(
  goalId: string,
  participantId: string,
  today: DayString,
): Promise<Map<string, FeedbackSummary>> {
  const rows = await prisma.taskFeedback.findMany({
    where: {
      participantId,
      taskDefinition: { goalId },
      day: { gte: addDays(today, -(FEEDBACK_WINDOW_DAYS - 1)), lte: today },
    },
    select: { taskDefinitionId: true, day: true, rating: true },
  });

  const byTask = new Map<string, Array<{ day: DayString; rating: DifficultyRating }>>();
  for (const row of rows) {
    // A rating written before the vocabulary changed, or by hand. Dropped rather
    // than counted as something it is not.
    if (!isDifficultyRating(row.rating)) continue;
    const list = byTask.get(row.taskDefinitionId) ?? [];
    list.push({ day: row.day, rating: row.rating });
    byTask.set(row.taskDefinitionId, list);
  }

  const summaries = new Map<string, FeedbackSummary>();
  for (const [taskId, entries] of byTask) {
    summaries.set(taskId, summarizeFeedback(entries, today));
  }
  return summaries;
}

/**
 * The ratings attached to a specific set of days, keyed by occurrence id.
 *
 * Used by the Today list, which shows the answer beside the question — a rating
 * already given should read as given, not be asked for again after a refresh.
 */
export async function feedbackByOccurrence(
  occurrenceIds: string[],
): Promise<Map<string, DifficultyRating>> {
  if (occurrenceIds.length === 0) return new Map();
  const rows = await prisma.taskFeedback.findMany({
    where: { taskOccurrenceId: { in: occurrenceIds } },
    select: { taskOccurrenceId: true, rating: true },
  });
  const map = new Map<string, DifficultyRating>();
  for (const row of rows) {
    if (isDifficultyRating(row.rating)) map.set(row.taskOccurrenceId, row.rating);
  }
  return map;
}
