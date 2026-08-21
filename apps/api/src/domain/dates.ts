// Day handling for Goalify.
//
// Every "challenge day" is a plain YYYY-MM-DD string evaluated in the goal's own
// timezone. Storing days as strings (rather than Date/UTC instants) is what keeps
// the daily leaderboard reset unambiguous: a goal in Asia/Tbilisi rolls over at
// local midnight regardless of where the server or the participant happens to be.
//
// All arithmetic goes through UTC noon, which is far enough from either midnight
// that a DST shift can never move the calendar date.

export type DayString = string; // YYYY-MM-DD

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDayString(value: string): value is DayString {
  if (!DAY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function assertDayString(value: string, label = 'date'): DayString {
  if (!isDayString(value)) throw new Error(`Invalid ${label}: expected YYYY-MM-DD, got "${value}"`);
  return value;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- time of day

/**
 * A wall-clock time with no date and no zone: "08:00", "20:30".
 *
 * Used for task reminders and for the two scheduled daily notifications. Always
 * interpreted in someone's own timezone, which is why it is stored without one — an
 * instant would pin 08:00 to whichever offset happened to apply the day it was saved.
 */
export type TimeString = string; // HH:MM, 24-hour

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimeString(value: string): value is TimeString {
  return TIME_RE.test(value);
}

/** Minutes since local midnight, for comparing two TimeStrings. */
export function minutesOfDay(time: TimeString): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** The wall-clock time it currently is in `timezone`, as HH:MM. */
export function timeInTimezone(instant: Date, timezone: string): TimeString {
  // hourCycle h23 rather than hour12:false — the latter yields "24:05" at midnight in
  // some runtimes, which is a valid-looking string that no comparison handles.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

/**
 * The calendar day it currently is in `timezone`.
 * This is the definition of "today" for every goal-scoped calculation.
 */
export function todayIn(timezone: string, now: Date = new Date()): DayString {
  return dayInTimezone(now, timezone);
}

/** The calendar day that `instant` falls on, as observed in `timezone`. */
export function dayInTimezone(instant: Date, timezone: string): DayString {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Treat a day string as an anchor instant (UTC noon) for safe arithmetic. */
function anchor(day: DayString): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function toDay(date: Date): DayString {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: DayString, amount: number): DayString {
  const next = anchor(day);
  next.setUTCDate(next.getUTCDate() + amount);
  return toDay(next);
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: DayString, to: DayString): number {
  const ms = anchor(to).getTime() - anchor(from).getTime();
  return Math.round(ms / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday, matching JS getDay() and the recurrence config. */
export function weekdayOf(day: DayString): number {
  return anchor(day).getUTCDay();
}

export function compareDays(a: DayString, b: DayString): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDay(a: DayString, b: DayString): DayString {
  return a <= b ? a : b;
}

export function maxDay(a: DayString, b: DayString): DayString {
  return a >= b ? a : b;
}

export function isBetween(day: DayString, from: DayString, to: DayString | null): boolean {
  if (day < from) return false;
  if (to && day > to) return false;
  return true;
}

/** Inclusive range of days. Returns [] when `to` precedes `from`. */
export function eachDay(from: DayString, to: DayString): DayString[] {
  const out: DayString[] = [];
  if (to < from) return out;
  // Guard against a pathological range blowing up memory.
  const span = daysBetween(from, to);
  if (span > 3650) throw new Error(`Refusing to expand a ${span}-day range`);
  let cursor = from;
  for (let i = 0; i <= span; i++) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** Monday-based week start, used to bucket TIMES_PER_WEEK targets. */
export function startOfWeek(day: DayString): DayString {
  const weekday = weekdayOf(day); // 0=Sun
  const backtrack = (weekday + 6) % 7; // Mon=0
  return addDays(day, -backtrack);
}

/** Stable key for the ISO-style week a day belongs to. */
export function weekKey(day: DayString): string {
  return startOfWeek(day);
}
