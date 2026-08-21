// The two scheduled daily notifications: the 08:00 plan and the 20:30 nudge.
//
// Both are driven by one tick because both begin with the same question — what time is
// it where this user is — and that question costs one profile scan to answer for
// everybody. What differs is only what each decides to say.
//
// Nothing here computes task counts of its own. Those come from services/daily.ts, the
// same source the Home screen reads, so a summary can never quote a number the app
// then contradicts.
//
// Timing model. Each user names a wall-clock time in their own timezone, so there is no
// single instant at which "the morning job" runs; the tick instead asks whose local
// clock has passed the time they asked for. A tick may therefore run many times inside
// one user's window, and the unique dedupe key — userId:TYPE:localDate — is what makes
// that harmless. Frequency buys punctuality, never correctness.

import type { FastifyBaseLogger } from 'fastify';
import { dayInTimezone, minutesOfDay, timeInTimezone } from '../domain/dates.js';
import type { DayString, TimeString } from '../domain/dates.js';
import type { ScheduledNotificationType } from '../domain/enums.js';
import { prisma } from '../lib/prisma.js';
import { loadUserDay, outstandingGoals, totalsFor } from '../services/daily.js';
import { alreadySent, notify } from '../services/notifications.js';

/**
 * How late each notification may still be delivered, in minutes past its chosen time.
 *
 * A tick that finds a user's window already closed sends nothing: the moment has passed
 * and a stale notification is worse than a missing one. The windows differ because the
 * two notifications spoil at different rates — a plan for the day is still a plan at
 * 11:00, while "you still have tasks left" stops being actionable near bedtime.
 *
 * Neither window can leak into the next day: at 00:30 local the tick is evaluating the
 * *new* date, whose chosen time has not arrived yet, so yesterday's missed nudge stays
 * missed rather than arriving overnight.
 */
const LATE_TOLERANCE_MINUTES: Record<ScheduledNotificationType, number> = {
  MORNING_SUMMARY: 240, // 08:00 -> up to 12:00
  EVENING_INCOMPLETE: 150, // 20:30 -> up to 23:00
};

export interface TickResult {
  /** Users whose local clock put them inside a delivery window. */
  due: number;
  morningSent: number;
  eveningSent: number;
  /** Due, but there was nothing worth saying — no tasks today, or none left. */
  skippedEmpty: number;
  /** Already delivered for that local day, by an earlier tick or another worker. */
  skippedDuplicate: number;
  failed: number;
}

/**
 * Whether `local` falls inside the delivery window that opens at `chosen`.
 *
 * Exported for the tests: this is the whole timing rule, and it is worth being able to
 * state it without a database.
 */
export function isWithinWindow(
  local: TimeString,
  chosen: TimeString,
  type: ScheduledNotificationType,
): boolean {
  const now = minutesOfDay(local);
  const opens = minutesOfDay(chosen);
  // No wrap past midnight: a window that would run into tomorrow is truncated at it,
  // because tomorrow is a different local date and therefore a different notification.
  return now >= opens && now < opens + LATE_TOLERANCE_MINUTES[type];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 in Get Fit, 1 in Read More" — what the day is actually made of. */
function describeBreakdown(
  parts: Array<{ title: string; count: number }>,
  joiner: (count: number, title: string) => string,
): string[] {
  const shown = parts.slice(0, 3).map(({ title, count }) => joiner(count, title));
  const hidden = parts.length - shown.length;
  // "+1 more goal", not "+1 more" — the number counts goals, and the sentence in front
  // of it counts tasks, so leaving it bare invites the reader to add them together.
  return hidden > 0 ? [...shown, `+${plural(hidden, 'more goal', 'more goals')}`] : shown;
}

/**
 * One pass over everyone who might be due.
 *
 * Errors are contained per user: a single profile with unparseable data must not stop
 * the other hundred from being told about their day. The tick reports failures in its
 * return value and logs them, then completes — pg-boss retrying the whole batch because
 * of one bad row would resend nothing (the dedupe key holds) but would also fix nothing.
 */
export async function runDailyNotifications(
  log: FastifyBaseLogger,
  now: Date = new Date(),
): Promise<TickResult> {
  const result: TickResult = {
    due: 0,
    morningSent: 0,
    eveningSent: 0,
    skippedEmpty: 0,
    skippedDuplicate: 0,
    failed: 0,
  };

  // Only users who could receive something: at least one toggle on, and at least one
  // active goal. Someone with no goals has no day to summarise and nothing outstanding,
  // so there is no point resolving their timezone to find that out.
  const profiles = await prisma.profile.findMany({
    where: {
      OR: [{ notifyMorningSummary: true }, { notifyEveningCheck: true }],
      user: { participations: { some: { status: 'ACTIVE', goal: { status: 'ACTIVE' } } } },
    },
    select: {
      userId: true,
      timezone: true,
      morningTime: true,
      eveningTime: true,
      notifyMorningSummary: true,
      notifyEveningCheck: true,
    },
  });

  for (const profile of profiles) {
    // The user's own date and clock. Both are read from the profile timezone rather than
    // any goal's: the notification is addressed to the person, so "today" in the dedupe
    // key is their today. What is *due* inside it remains each goal's own question.
    let localTime: TimeString;
    let localDate: DayString;
    try {
      localTime = timeInTimezone(now, profile.timezone);
      localDate = dayInTimezone(now, profile.timezone);
    } catch (error) {
      // An invalid IANA name in the database. Skipping is right — guessing UTC would
      // deliver a morning summary in the middle of somebody's night.
      result.failed++;
      log.error(
        { err: error, userId: profile.userId, timezone: profile.timezone },
        'jobs: unusable timezone on profile',
      );
      continue;
    }

    const wantsMorning =
      profile.notifyMorningSummary &&
      isWithinWindow(localTime, profile.morningTime, 'MORNING_SUMMARY');
    const wantsEvening =
      profile.notifyEveningCheck &&
      isWithinWindow(localTime, profile.eveningTime, 'EVENING_INCOMPLETE');

    if (!wantsMorning && !wantsEvening) continue;
    result.due++;

    try {
      // Cheap check before the expensive one. The unique index is still the guarantee;
      // this only avoids scanning a user's goals to build a notification that would be
      // thrown away. Both windows are hours wide, so most ticks land here.
      const morningPending =
        wantsMorning && !(await alreadySent(profile.userId, 'MORNING_SUMMARY', localDate));
      const eveningPending =
        wantsEvening && !(await alreadySent(profile.userId, 'EVENING_INCOMPLETE', localDate));

      if (wantsMorning && !morningPending) result.skippedDuplicate++;
      if (wantsEvening && !eveningPending) result.skippedDuplicate++;
      if (!morningPending && !eveningPending) continue;

      const days = await loadUserDay(profile.userId, now);
      const totals = totalsFor(days);

      if (morningPending) {
        const sent = await sendMorningSummary(profile.userId, localDate, days, totals);
        sent ? result.morningSent++ : result.skippedEmpty++;
      }
      if (eveningPending) {
        const sent = await sendEveningCheck(profile.userId, localDate, days, totals);
        sent ? result.eveningSent++ : result.skippedEmpty++;
      }
    } catch (error) {
      result.failed++;
      log.error({ err: error, userId: profile.userId }, 'jobs: daily notification failed');
    }
  }

  return result;
}

type Days = Awaited<ReturnType<typeof loadUserDay>>;
type Totals = ReturnType<typeof totalsFor>;

/**
 * M20 — the morning plan. Sends nothing when nothing is scheduled.
 *
 * A rest day is not news. On a Mon/Wed/Fri goal that would be four "nothing today"
 * notifications a week, and a notification whose content is the absence of content
 * teaches people to ignore the channel. The day the app has nothing to ask for, it
 * asks for nothing.
 */
async function sendMorningSummary(
  userId: string,
  localDate: DayString,
  days: Days,
  totals: Totals,
): Promise<boolean> {
  if (totals.required === 0) return false;

  const breakdown = days
    .map((day) => ({ title: day.goal.title, count: day.score.required }))
    .filter((part) => part.count > 0)
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));

  const parts = [
    describeBreakdown(breakdown, (count, title) => `${count} in ${title}`).join(', '),
  ];
  // The window is four hours wide, so a summary can arrive after the user has already
  // started. Saying "8 tasks today" then is still true — it is the day's plan, not a
  // remaining count — but acknowledging the head start keeps it from reading as a scold.
  if (totals.completed > 0) parts.push(`${totals.completed} already done`);
  if (totals.streak > 1) parts.push(`${totals.streak}-day streak going`);

  const created = await notify({
    userId,
    type: 'MORNING_SUMMARY',
    title: `${plural(totals.required, 'task', 'tasks')} today`,
    body: parts.join(' · '),
    localDate,
    data: {
      required: totals.required,
      completed: totals.completed,
      streak: totals.streak,
      goalIds: days.filter((d) => d.score.required > 0).map((d) => d.goal.id),
    },
  });
  return created !== null;
}

/**
 * M21 — the evening nudge, and only when there is something to nudge about.
 *
 * `remaining === 0` sends nothing: a message congratulating someone for finishing is
 * already sent by the completion itself (PROGRESS), and repeating it at 20:30 would be
 * the app talking for the sake of talking.
 */
async function sendEveningCheck(
  userId: string,
  localDate: DayString,
  days: Days,
  totals: Totals,
): Promise<boolean> {
  if (totals.remaining === 0) return false;

  const behind = outstandingGoals(days);
  const body = describeBreakdown(
    behind.map((g) => ({ title: g.title, count: g.remaining })),
    (count, title) => `${title} — ${count} left`,
  ).join(', ');

  const created = await notify({
    userId,
    type: 'EVENING_INCOMPLETE',
    title: `${plural(totals.remaining, 'task', 'tasks')} still open today`,
    body,
    localDate,
    data: {
      remaining: totals.remaining,
      required: totals.required,
      completed: totals.completed,
      goalIds: behind.map((g) => g.goalId),
    },
  });
  return created !== null;
}
