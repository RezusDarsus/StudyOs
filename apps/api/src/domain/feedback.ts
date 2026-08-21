// Turning "too easy / just right / too hard" into something a suggestion can be
// built on.
//
// The whole file is pure. It reads no database and reaches no conclusion about what
// should happen — it only says what the user has been telling us, and how firmly.
// Deciding what to *do* about that is a separate, deliberate step: see
// services/task-feedback.ts for the store and services/copilot-goal.ts for the
// suggestions. Progression reviews (domain/progression.ts) never consult this at
// all: a stage moves on completion numbers, not on how a day felt.

import { addDays, compareDays, type DayString } from './dates.js';
import type { DifficultyRating } from './enums.js';

/**
 * How far back a signal is drawn from. Three weeks is long enough to cover a
 * few of even a weekly task's occurrences, and short enough that a task which was
 * genuinely hard in January is not still held against it in March.
 */
export const FEEDBACK_WINDOW_DAYS = 21;

/**
 * Ratings needed before the signal is called confident. Matches MIN_EVIDENCE in
 * the progression review for the same reason: two data points are an anecdote, and
 * suggesting a change off an anecdote is how a coach loses trust.
 */
export const MIN_FEEDBACK = 3;

/**
 * Share of the window that must agree. At 0.6 a run of three needs all three or
 * two-of-three to speak, and a genuinely mixed picture reports itself as mixed
 * instead of being rounded into a recommendation.
 */
export const FEEDBACK_MAJORITY = 0.6;

export interface FeedbackEntry {
  day: DayString;
  rating: DifficultyRating;
}

/**
 * What the ratings add up to.
 *
 * `MIXED` is a real answer, not a failure: it means the user has said different
 * things on different days and the honest response is to ask rather than to act.
 * `UNKNOWN` means there is not enough to go on yet.
 */
export type FeedbackSignal = 'TOO_EASY' | 'JUST_RIGHT' | 'TOO_HARD' | 'MIXED' | 'UNKNOWN';

export interface FeedbackSummary {
  /** Ratings inside the window. */
  sampleSize: number;
  counts: Record<DifficultyRating, number>;
  /** The most recent rating, whatever the aggregate says. */
  latest: { day: DayString; rating: DifficultyRating } | null;
  /** Whichever rating leads, even when it leads by too little to be trusted. */
  dominant: DifficultyRating | null;
  /** The reading a suggestion may be built on. */
  signal: FeedbackSignal;
  windowStart: DayString;
  windowEnd: DayString;
}

const EMPTY_COUNTS = (): Record<DifficultyRating, number> => ({
  TOO_EASY: 0,
  JUST_RIGHT: 0,
  TOO_HARD: 0,
});

/**
 * Summarise one task's recent ratings.
 *
 * `today` is included in the window. Unlike a progression review — which ends
 * yesterday because today is still in progress — a rating is only ever given about
 * a day the user has already lived through, so today's is as valid as any.
 */
export function summarizeFeedback(entries: FeedbackEntry[], today: DayString): FeedbackSummary {
  const windowStart = addDays(today, -(FEEDBACK_WINDOW_DAYS - 1));
  const inWindow = entries.filter(
    (entry) => compareDays(entry.day, windowStart) >= 0 && compareDays(entry.day, today) <= 0,
  );

  const counts = EMPTY_COUNTS();
  for (const entry of inWindow) counts[entry.rating] += 1;

  const latest = inWindow.reduce<FeedbackEntry | null>(
    (best, entry) => (best === null || compareDays(entry.day, best.day) > 0 ? entry : best),
    null,
  );

  // Ties resolve to JUST_RIGHT when it is one of the tied ratings. Half easy and
  // half hard is not evidence for either direction, and reporting it as "too hard"
  // because TOO_HARD happens to sort later would be an accident dressed as a
  // finding. It still fails the majority test below, so it changes nothing — this
  // only keeps `dominant` from being misleading when it is read on its own.
  const ranked = (['JUST_RIGHT', 'TOO_EASY', 'TOO_HARD'] as const)
    .map((rating) => ({ rating, count: counts[rating] }))
    .sort((a, b) => b.count - a.count);
  const dominant = ranked[0].count > 0 ? ranked[0].rating : null;

  let signal: FeedbackSignal = 'UNKNOWN';
  if (inWindow.length >= MIN_FEEDBACK && dominant) {
    signal = ranked[0].count / inWindow.length >= FEEDBACK_MAJORITY ? dominant : 'MIXED';
  }

  return {
    sampleSize: inWindow.length,
    counts,
    latest: latest && { day: latest.day, rating: latest.rating },
    dominant,
    signal,
    windowStart,
    windowEnd: today,
  };
}

/**
 * Whether the signal is firm enough to raise with the user unprompted.
 *
 * JUST_RIGHT is deliberately excluded. It is good news, and telling someone their
 * plan is fine every week is noise — it is worth reporting when asked, never worth
 * interrupting for.
 */
export function isActionableSignal(summary: FeedbackSummary): boolean {
  return summary.signal === 'TOO_EASY' || summary.signal === 'TOO_HARD';
}
