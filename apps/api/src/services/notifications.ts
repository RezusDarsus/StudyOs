// Creating notifications: preferences, and once-a-day guarantees.
//
// Split out of services/engagement.ts, which is about coins and achievements. This
// file owns one question — should this notification exist, and does it already? —
// because from here on two scheduled jobs and a realtime channel all depend on the
// answer being the same everywhere.

import { Prisma } from '@prisma/client';
import type { Notification } from '@prisma/client';
import type { DayString } from '../domain/dates.js';
import type { NotificationType, ScheduledNotificationType } from '../domain/enums.js';
import { prisma } from '../lib/prisma.js';
import { publishToUser } from './realtime.js';

/**
 * Which profile toggle silences each type.
 *
 * A map rather than a chain of `||` so that the one type with no toggle is stated
 * rather than merely omitted. PROGRESS is the app telling you that you finished what
 * you set out to do; there is no version of this product where that is unwelcome
 * noise, and a toggle for it would be a setting nobody would ever find and turn off.
 */
const MUTED_BY: Record<NotificationType, keyof MuteFlags | null> = {
  REMINDER: 'notifyTaskReminders',
  FRIEND: 'notifyFriendActivity',
  LEADERBOARD: 'notifyLeaderboardUpdate',
  ACHIEVEMENT: 'notifyAchievements',
  MORNING_SUMMARY: 'notifyMorningSummary',
  EVENING_INCOMPLETE: 'notifyEveningCheck',
  PROGRESS: null,
};

interface MuteFlags {
  notifyTaskReminders: boolean;
  notifyFriendActivity: boolean;
  notifyLeaderboardUpdate: boolean;
  notifyAchievements: boolean;
  notifyMorningSummary: boolean;
  notifyEveningCheck: boolean;
}

/** Whether this user has switched this kind of notification off. */
export function isMuted(type: NotificationType, flags: MuteFlags | null): boolean {
  if (!flags) return false;
  const flag = MUTED_BY[type];
  return flag ? !flags[flag] : false;
}

/**
 * The identity of a notification that may arrive at most once per local day.
 *
 * The local date is the recipient's own, not the server's: two users on the same
 * instant can be on different dates, and a summary of "today" means their today.
 */
export function dedupeKeyFor(
  userId: string,
  type: ScheduledNotificationType,
  localDate: DayString,
): string {
  return `${userId}:${type}:${localDate}`;
}

/**
 * The one shape a notification takes outside this service.
 *
 * Used by GET /api/notifications and by the realtime push alike, on purpose. A pushed
 * notification that differs in shape from a fetched one means the widget has to handle
 * two kinds of the same thing, and the second kind is the one nobody tests. `data` is
 * parsed here because it is stored as a JSON string, and every reader wants the object.
 */
export function notificationPayload(n: Notification) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    data: JSON.parse(n.data || '{}') as Record<string, unknown>,
    localDate: n.localDate,
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}

export interface NotifyOptions {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  /**
   * The recipient's local day this notification is about. Supplying it for one of the
   * scheduled types is what makes the send idempotent.
   */
  localDate?: DayString | null;
}

/**
 * Create a notification, unless the user muted the type or it already exists.
 *
 * Returns null in both of those cases — a caller that wants to know whether anything
 * was sent can check, and one that does not can ignore it. Never throws for a
 * duplicate: sending twice is the bug, and refusing to serve the request that
 * happened to be second is not an improvement on quietly doing nothing.
 */
export async function notify(opts: NotifyOptions) {
  const { userId, type, title, body = '', data = {}, localDate = null } = opts;

  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (isMuted(type, profile)) return null;

  // Only the scheduled types are deduplicated, and only when told which day they are
  // for. Everything else gets a null key, and nulls never collide in a unique index.
  const dedupeKey =
    localDate && (type === 'MORNING_SUMMARY' || type === 'EVENING_INCOMPLETE')
      ? dedupeKeyFor(userId, type, localDate)
      : null;

  let created;
  try {
    created = await prisma.notification.create({
      data: { userId, type, title, body, data: JSON.stringify(data), localDate, dedupeKey },
    });
  } catch (error) {
    // P2002 is the unique index doing its job: this notification was already sent,
    // by an earlier run of the same job or by a concurrent worker.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return null;
    }
    throw error;
  }

  // Push after the write, and outside the try above so that nothing about delivery can be
  // mistaken for the duplicate case. Every notification goes out through here rather than
  // through per-route publish calls: one path means realtime cannot quietly cover some
  // notifications and miss others. `await` is deliberate — publishToUser is bounded by a
  // 3s timeout and swallows its own errors, and a floating promise would lose them.
  await publishToUser(userId, {
    event: 'notification',
    notification: notificationPayload(created),
  });

  return created;
}

/**
 * Whether a scheduled notification has already gone out for a given local day.
 *
 * For jobs that want to skip expensive work — counting a user's outstanding tasks,
 * say — before attempting a send that would only be discarded. The unique index
 * remains the actual guarantee; this is an optimisation, not the check.
 */
export async function alreadySent(
  userId: string,
  type: ScheduledNotificationType,
  localDate: DayString,
): Promise<boolean> {
  const existing = await prisma.notification.findUnique({
    where: { dedupeKey: dedupeKeyFor(userId, type, localDate) },
    select: { id: true },
  });
  return existing !== null;
}
