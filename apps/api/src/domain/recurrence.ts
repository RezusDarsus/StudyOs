import {
  type DayString,
  addDays,
  daysBetween,
  eachDay,
  isBetween,
  isDayString,
  startOfWeek,
  weekdayOf,
} from './dates.js';
import type { RecurrenceType } from './enums.js';

export interface RecurrenceConfig {
  weekdays?: number[]; // 0=Sun … 6=Sat
  timesPerWeek?: number;
  /** Optional bounds for flexible TIMES_PER_WEEK schedules. */
  allowedWeekdays?: number[];
  excludedWeekdays?: number[];
  intervalDays?: number;
  /** Calendar day, or the final calendar day when a month has varying length. */
  dayOfMonth?: number | 'LAST';
  intervalMonths?: number;
  /** Optional calendar bounds for one phase of a variable monthly schedule. */
  activeFrom?: DayString;
  activeUntil?: DayString;
  /** Calendar months intentionally omitted, encoded as YYYY-MM. */
  excludedMonths?: string[];
}

export interface TaskSchedule {
  recurrenceType: RecurrenceType;
  recurrenceConfig: RecurrenceConfig;
  startDate: DayString;
  endDate: DayString | null;
}

export function parseRecurrenceConfig(raw: string): RecurrenceConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as RecurrenceConfig) : {};
  } catch {
    return {};
  }
}

export class RecurrenceError extends Error {}

/** Validate a recurrence up front so bad rules can never reach the scheduler. */
export function validateRecurrence(type: RecurrenceType, config: RecurrenceConfig): void {
  validateCalendarBounds(config);
  switch (type) {
    case 'SPECIFIC_WEEKDAYS': {
      const days = config.weekdays;
      if (!Array.isArray(days) || days.length === 0)
        throw new RecurrenceError('SPECIFIC_WEEKDAYS requires at least one weekday');
      if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
        throw new RecurrenceError('weekdays must be integers 0-6 (0=Sunday)');
      if (new Set(days).size !== days.length)
        throw new RecurrenceError('weekdays must not contain duplicates');
      return;
    }
    case 'TIMES_PER_WEEK': {
      const n = config.timesPerWeek;
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 7)
        throw new RecurrenceError('timesPerWeek must be an integer between 1 and 7');
      validateWeekdaySet(config.allowedWeekdays, 'allowedWeekdays');
      validateWeekdaySet(config.excludedWeekdays, 'excludedWeekdays');
      if (config.allowedWeekdays && config.allowedWeekdays.length < (n as number))
        throw new RecurrenceError('allowedWeekdays must contain at least timesPerWeek days');
      if (config.allowedWeekdays?.some((day) => config.excludedWeekdays?.includes(day)))
        throw new RecurrenceError('allowedWeekdays and excludedWeekdays must not overlap');
      return;
    }
    case 'EVERY_X_DAYS': {
      const n = config.intervalDays;
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 365)
        throw new RecurrenceError('intervalDays must be an integer between 1 and 365');
      return;
    }
    case 'MONTHLY': {
      validateDayOfMonth(config.dayOfMonth);
      return;
    }
    case 'EVERY_X_MONTHS': {
      const interval = config.intervalMonths;
      if (!Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > 120)
        throw new RecurrenceError('intervalMonths must be an integer between 1 and 120');
      validateDayOfMonth(config.dayOfMonth);
      return;
    }
    case 'ONCE':
    case 'EVERY_DAY':
      return;
    default:
      throw new RecurrenceError(`Unknown recurrence type: ${type}`);
  }
}

function validateCalendarBounds(config:RecurrenceConfig):void{
  if(config.activeFrom!==undefined&&!isDayString(config.activeFrom))throw new RecurrenceError('activeFrom must be YYYY-MM-DD');
  if(config.activeUntil!==undefined&&!isDayString(config.activeUntil))throw new RecurrenceError('activeUntil must be YYYY-MM-DD');
  if(config.activeFrom&&config.activeUntil&&config.activeUntil<config.activeFrom)throw new RecurrenceError('activeUntil must not precede activeFrom');
  if(config.excludedMonths?.some((month)=>!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)))throw new RecurrenceError('excludedMonths must contain YYYY-MM values');
}

function validateWeekdaySet(value: number[] | undefined, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0)
    throw new RecurrenceError(`${label} must contain at least one weekday`);
  if (value.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
    throw new RecurrenceError(`${label} must contain integers 0-6`);
  if (new Set(value).size !== value.length)
    throw new RecurrenceError(`${label} must not contain duplicates`);
}

function validateDayOfMonth(value: RecurrenceConfig['dayOfMonth']): void {
  if (value === undefined || value === 'LAST') return;
  if (!Number.isInteger(value) || value < 1 || value > 31)
    throw new RecurrenceError('dayOfMonth must be an integer between 1 and 31 or LAST');
}

function calendarParts(day: DayString) {
  const [year, month, date] = day.split('-').map(Number);
  return { year, month, date };
}

function effectiveDayOfMonth(year: number, month: number, requested: number | 'LAST'): number {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return requested === 'LAST' ? last : Math.min(requested, last);
}

function occursInCalendarMonth(
  day: DayString,
  startDate: DayString,
  intervalMonths: number,
  requestedDay?: number | 'LAST',
): boolean {
  const current = calendarParts(day);
  const start = calendarParts(startDate);
  const monthDistance = (current.year - start.year) * 12 + current.month - start.month;
  if (monthDistance < 0 || monthDistance % intervalMonths !== 0) return false;
  const desired = requestedDay ?? start.date;
  return current.date === effectiveDayOfMonth(current.year, current.month, desired);
}

/**
 * Does this task put an occurrence on `day` at all?
 *
 * For fixed recurrences this is the whole schedule. For TIMES_PER_WEEK it means
 * "the user may complete it today if they still owe days this week" — the weekly
 * quota is flexible, so a row exists on every day of the week and `isRequiredOn`
 * decides whether it actually counts against them.
 */
export function occursOn(schedule: TaskSchedule, day: DayString): boolean {
  const { recurrenceType, recurrenceConfig, startDate, endDate } = schedule;
  const effectiveStart=recurrenceConfig.activeFrom&&recurrenceConfig.activeFrom>startDate?recurrenceConfig.activeFrom:startDate;
  const effectiveEnd=recurrenceConfig.activeUntil&&(!endDate||recurrenceConfig.activeUntil<endDate)?recurrenceConfig.activeUntil:endDate;
  if (!isBetween(day, effectiveStart, effectiveEnd)) return false;
  if(recurrenceConfig.excludedMonths?.includes(day.slice(0,7)))return false;

  switch (recurrenceType) {
    case 'ONCE':
      return day === effectiveStart;
    case 'EVERY_DAY':
      return true;
    case 'SPECIFIC_WEEKDAYS':
      return (recurrenceConfig.weekdays ?? []).includes(weekdayOf(day));
    case 'EVERY_X_DAYS': {
      const interval = recurrenceConfig.intervalDays ?? 1;
      return daysBetween(effectiveStart, day) % interval === 0;
    }
    case 'MONTHLY':
      return occursInCalendarMonth(day, effectiveStart, 1, recurrenceConfig.dayOfMonth);
    case 'EVERY_X_MONTHS':
      return occursInCalendarMonth(
        day,
        effectiveStart,
        recurrenceConfig.intervalMonths ?? 1,
        recurrenceConfig.dayOfMonth,
      );
    case 'TIMES_PER_WEEK': {
      const weekday = weekdayOf(day);
      if (recurrenceConfig.allowedWeekdays && !recurrenceConfig.allowedWeekdays.includes(weekday)) return false;
      if (recurrenceConfig.excludedWeekdays?.includes(weekday)) return false;
      return true;
    }
    default:
      return false;
  }
}

/** Every day in [from, to] that this task schedules an occurrence on. */
export function occurrenceDays(
  schedule: TaskSchedule,
  from: DayString,
  to: DayString,
): DayString[] {
  const windowStart = from > schedule.startDate ? from : schedule.startDate;
  const windowEnd = schedule.endDate && schedule.endDate < to ? schedule.endDate : to;
  if (windowEnd < windowStart) return [];
  return eachDay(windowStart, windowEnd).filter((day) => occursOn(schedule, day));
}

// ------------------------------------------------------------- weekly quota

/**
 * TIMES_PER_WEEK scoring.
 *
 * "Gym 3 times per week" must not punish someone on Monday for not having gone
 * yet, and must not keep demanding gym visits after they have already done three.
 * So a flexible task is:
 *
 *   available  — completable, whenever quota remains for the week
 *   required   — counted in the day's denominator, only once the remaining days
 *                in the week are no more than the remaining quota
 *
 * Completing early shrinks the quota, so the later days stop being required.
 * Skipping all week means the final days become required and are scored.
 */
export interface WeeklyQuotaContext {
  /** Completions of this task, by day, for the week containing the day queried. */
  completedDaysInWeek: Set<DayString>;
  /** Last day the participant is scored on (goal end / leave date / today). */
  lastScorableDay: DayString | null;
}

export function remainingQuota(
  timesPerWeek: number,
  day: DayString,
  ctx: WeeklyQuotaContext,
): number {
  const weekStart = startOfWeek(day);
  let completedBefore = 0;
  for (const completed of ctx.completedDaysInWeek) {
    if (completed >= weekStart && completed < day) completedBefore++;
  }
  return Math.max(0, timesPerWeek - completedBefore);
}

/** Days from `day` to the end of its week that the participant can still act on. */
function scorableDaysLeftInWeek(schedule: TaskSchedule, day: DayString, ctx: WeeklyQuotaContext): number {
  const weekEnd = addDays(startOfWeek(day), 6);
  const horizon =
    ctx.lastScorableDay && ctx.lastScorableDay < weekEnd ? ctx.lastScorableDay : weekEnd;
  if (horizon < day) return 0;
  return eachDay(day, horizon).filter((candidate) => occursOn(schedule, candidate)).length;
}

export function isAvailableOn(
  schedule: TaskSchedule,
  day: DayString,
  ctx: WeeklyQuotaContext,
): boolean {
  if (!occursOn(schedule, day)) return false;
  if (schedule.recurrenceType !== 'TIMES_PER_WEEK') return true;
  const target = schedule.recurrenceConfig.timesPerWeek ?? 1;
  return remainingQuota(target, day, ctx) > 0;
}

export function isRequiredOn(
  schedule: TaskSchedule,
  day: DayString,
  ctx: WeeklyQuotaContext,
): boolean {
  if (!occursOn(schedule, day)) return false;
  if (schedule.recurrenceType !== 'TIMES_PER_WEEK') return true;

  const target = schedule.recurrenceConfig.timesPerWeek ?? 1;
  const quota = remainingQuota(target, day, ctx);
  if (quota <= 0) return false;

  // Already done today? Then today plainly counted.
  if (ctx.completedDaysInWeek.has(day)) return true;

  return scorableDaysLeftInWeek(schedule, day, ctx) <= quota;
}
