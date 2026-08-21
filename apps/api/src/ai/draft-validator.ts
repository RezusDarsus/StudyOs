import { addDays, todayIn } from '../domain/dates.js';
import type { ProgressionMetric, RecurrenceType } from '../domain/enums.js';
import { validateStages } from '../domain/progression.js';
import { validateRecurrence, type RecurrenceConfig } from '../domain/recurrence.js';
import type { DraftTaskInput, GoalDraftInput } from './schemas.js';
import { toSecondPerson } from './voice.js';

// The deterministic safety net between the model and the database.
//
// Zod already guarantees the SHAPE. This layer enforces what is *sensible*:
// a plan of 40 daily tasks, a deadline in the past, or "walk 300 times per week"
// all parse fine but must never reach a user. Anything recoverable is normalised;
// anything genuinely broken is rejected with a reason.

export class DraftValidationError extends Error {}

/** A build-up ladder the model proposed, once it has been made safe. */
export interface NormalizedProgression {
  metricType: ProgressionMetric;
  unitLabel: string;
  stages: Array<{ target: number; minDays: number }>;
}

export interface NormalizedTask {
  title: string;
  description: string;
  recurrenceType: RecurrenceType;
  recurrenceConfig: RecurrenceConfig;
  estimatedMinutes: number | null;
  preferredTime: string | null;
  reason: string;
  /** Computed by the application, never by the model. */
  reward: number;
  /** Null unless this task genuinely gets harder over time. */
  progression: NormalizedProgression | null;
}

export interface NormalizedDraft {
  title: string;
  description: string;
  category: GoalDraftInput['category'];
  targetType: GoalDraftInput['targetType'];
  targetValue: number | null;
  deadline: string | null;
  rationale: string;
  tasks: NormalizedTask[];
  /** Anything that was silently corrected, surfaced for logging. */
  adjustments: string[];
}

const MAX_TASKS = 8;
const MAX_DAILY_MINUTES = 240;

/**
 * A model-proposed ladder is held to tighter bounds than a hand-made one.
 *
 * Phase 1 allows up to 12 stages because someone typing them out knows what they
 * want. A model given twelve slots fills them, and "walk 15, 16, 17, 18…" is not
 * a plan, it is a spreadsheet. Six rungs is enough to express a real build-up.
 *
 * MIN_STAGE_DAYS exists for the same reason: a stage the model set to one day is a
 * ladder pretending to be a schedule.
 */
const MAX_AI_STAGES = 6;
const MIN_STAGE_DAYS = 3;
const MAX_STAGE_DAYS = 28;

/**
 * Where tolerance stops.
 *
 * A near-miss is a representation problem and gets normalised: 8 times a week is
 * someone counting a twice-daily session, and clamping to 7 preserves the intent.
 * 300 times a week is not a rounding error — it means the model produced something
 * semantically broken, and quietly turning it into 7 would hand the user a plan
 * nobody asked for. Past these bands we reject and let the caller regenerate.
 */
const PLAUSIBLE = {
  timesPerWeek: 14, // up to twice daily reads as a real intent
  intervalDays: 365,
  minutes: 600, // a 10-hour session is wrong, but recognisably a session
};

/**
 * Reward is derived from effort by fixed rules so a user cannot talk the AI into
 * minting a high-value task and climbing the leaderboard unfairly.
 */
export function rewardForTask(task: { estimatedMinutes: number | null }): number {
  const minutes = task.estimatedMinutes ?? 15;
  if (minutes <= 10) return 5;
  if (minutes <= 20) return 10;
  if (minutes <= 40) return 15;
  if (minutes <= 60) return 20;
  return 25;
}

/** How many times a week this recurrence actually fires, for workload checks. */
function weeklyFrequency(type: RecurrenceType, config: RecurrenceConfig): number {
  switch (type) {
    case 'EVERY_DAY':
      return 7;
    case 'ONCE':
      return 0.25;
    case 'SPECIFIC_WEEKDAYS':
      return config.weekdays?.length ?? 0;
    case 'TIMES_PER_WEEK':
      return config.timesPerWeek ?? 1;
    case 'EVERY_X_DAYS':
      return 7 / (config.intervalDays ?? 1);
    default:
      return 0;
  }
}

function normalizeRecurrence(
  task: DraftTaskInput,
  adjustments: string[],
): { type: RecurrenceType; config: RecurrenceConfig } {
  const type = task.recurrence.type;
  const config: RecurrenceConfig = {};

  switch (type) {
    case 'SPECIFIC_WEEKDAYS': {
      const weekdays = [...new Set(task.recurrence.weekdays ?? [])]
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        .sort((a, b) => a - b);
      if (weekdays.length === 0) {
        // A weekday task with no weekdays would never fire — fall back rather than reject.
        adjustments.push(`"${task.title}" had no weekdays; treated as every day`);
        return { type: 'EVERY_DAY', config: {} };
      }
      config.weekdays = weekdays;
      break;
    }
    case 'TIMES_PER_WEEK': {
      const raw = task.recurrence.timesPerWeek ?? 1;
      if (raw < 1 || raw > PLAUSIBLE.timesPerWeek) {
        throw new DraftValidationError(
          `"${task.title}" came back as ${raw} times per week, which is not a real schedule. Try generating the plan again.`,
        );
      }
      const clamped = Math.min(7, Math.max(1, Math.round(raw)));
      if (clamped !== raw) {
        adjustments.push(`"${task.title}" asked for ${raw}x per week; capped at ${clamped}`);
      }
      config.timesPerWeek = clamped;
      break;
    }
    case 'EVERY_X_DAYS': {
      const raw = task.recurrence.intervalDays ?? 1;
      if (raw < 1 || raw > PLAUSIBLE.intervalDays) {
        throw new DraftValidationError(
          `"${task.title}" came back with an interval of ${raw} days, which is not a real schedule. Try generating the plan again.`,
        );
      }
      const clamped = Math.min(90, Math.max(1, Math.round(raw)));
      if (clamped !== raw) {
        adjustments.push(`"${task.title}" interval ${raw} adjusted to ${clamped} days`);
      }
      config.intervalDays = clamped;
      break;
    }
    default:
      break;
  }

  // Final authority is the same validator Phase 1 uses for manual creation.
  validateRecurrence(type, config);
  return { type, config };
}

/**
 * Make a proposed build-up ladder safe, or drop it.
 *
 * Dropping rather than throwing is the whole point. A ladder is an enhancement the
 * user never asked for; losing a perfectly good plan because the model wrote
 * "15, 15, 20" would be trading something they wanted for something they did not.
 * So every failure here returns null and says so in `adjustments`.
 */
function normalizeProgression(
  task: DraftTaskInput,
  recurrenceType: RecurrenceType,
  adjustments: string[],
): NormalizedProgression | null {
  const proposed = task.progression;
  if (!proposed) return null;

  const drop = (why: string) => {
    adjustments.push(`Dropped the build-up on "${task.title}": ${why}`);
    return null;
  };

  // A one-off cannot climb a ladder — there is no second day to climb on.
  if (recurrenceType === 'ONCE') return drop('a one-off task has nothing to build up over');

  const metricType = proposed.metricType;

  // Round first, then require each rung to clear the one below it. Rounding can
  // flatten 2.4 and 2.6 into the same number, which is exactly the kind of ladder
  // that wastes a week of someone's time, so the check happens after.
  const rungs: Array<{ target: number; minDays: number }> = [];
  for (const stage of proposed.stages) {
    const target = Math.round(stage.target);
    if (target <= 0) continue;
    if (rungs.length > 0 && target <= rungs[rungs.length - 1].target) continue;
    if (metricType === 'MINUTES' && target > MAX_DAILY_MINUTES) break;
    rungs.push({
      target,
      minDays: Math.min(MAX_STAGE_DAYS, Math.max(MIN_STAGE_DAYS, Math.round(stage.minDays ?? 7))),
    });
    if (rungs.length === MAX_AI_STAGES) break;
  }

  if (rungs.length < 2) return drop('it had fewer than two real steps');
  if (proposed.stages.length > rungs.length) {
    adjustments.push(
      `"${task.title}" build-up trimmed from ${proposed.stages.length} steps to ${rungs.length}`,
    );
  }

  // The same check a hand-made ladder gets. If it still complains, the ladder goes
  // rather than the plan.
  const errors = validateStages(rungs.map((r, i) => ({ stageIndex: i, ...r })));
  if (errors.length > 0) return drop(errors.join(' '));

  return { metricType, unitLabel: proposed.unitLabel.trim(), stages: rungs };
}

export function validateAndNormalizeDraft(
  input: GoalDraftInput,
  timezone: string,
  now = new Date(),
): NormalizedDraft {
  const adjustments: string[] = [];
  const today = todayIn(timezone, now);

  if (input.tasks.length === 0) {
    throw new DraftValidationError('The plan came back with no tasks');
  }

  let tasks = input.tasks;
  if (tasks.length > MAX_TASKS) {
    adjustments.push(`Trimmed ${tasks.length} tasks down to ${MAX_TASKS}`);
    tasks = tasks.slice(0, MAX_TASKS);
  }

  // Drop duplicate task titles — the model occasionally restates one.
  const seen = new Set<string>();
  tasks = tasks.filter((task) => {
    const key = task.title.trim().toLowerCase();
    if (seen.has(key)) {
      adjustments.push(`Removed duplicate task "${task.title}"`);
      return false;
    }
    seen.add(key);
    return true;
  });

  const normalizedTasks: NormalizedTask[] = tasks.map((task) => {
    const { type, config } = normalizeRecurrence(task, adjustments);
    let minutes = task.estimatedMinutes ?? null;
    if (minutes !== null && minutes > PLAUSIBLE.minutes) {
      throw new DraftValidationError(
        `"${task.title}" came back as ${minutes} minutes, which is not a real session. Try generating the plan again.`,
      );
    }
    if (minutes !== null && minutes > MAX_DAILY_MINUTES) {
      adjustments.push(`"${task.title}" shortened from ${minutes} to ${MAX_DAILY_MINUTES} minutes`);
      minutes = MAX_DAILY_MINUTES;
    }

    const progression = normalizeProgression(task, type, adjustments);

    // A minute ladder and a flat "35 min" are two claims about the same day, and
    // the day can only ask for one number. The ladder wins, because its first rung
    // is what the user actually starts on — otherwise the plan promises 35 minutes
    // and day one quietly asks for 15.
    if (progression?.metricType === 'MINUTES') {
      const first = progression.stages[0].target;
      if (minutes !== null && minutes !== first) {
        adjustments.push(
          `"${task.title}" starts at ${first} minutes, not ${minutes} — the build-up sets the pace`,
        );
      }
      minutes = first;
    }

    // The user reads this sentence on their own plan, so it has to be addressed to
    // them. The model is told this and still occasionally writes a case note.
    const reason = toSecondPerson(task.reason?.trim() ?? '');
    if (reason.changed) {
      adjustments.push(`Rewrote the note on "${task.title}" to address you directly`);
    }

    return {
      title: task.title.trim(),
      description: task.description?.trim() ?? '',
      recurrenceType: type,
      recurrenceConfig: config,
      estimatedMinutes: minutes,
      preferredTime: task.preferredTime ?? null,
      reason: reason.text,
      // Derived from the starting rung, and it stays there. Rewarding the top of a
      // ladder would pay out for effort not yet made, and re-pricing the task on
      // every stage change would let someone talk the Copilot into a steep climb
      // and out-earn everyone on the leaderboard for the same walk.
      reward: rewardForTask({ estimatedMinutes: minutes }),
      progression,
    };
  });

  // Guard against a plan nobody could sustain, e.g. six daily hour-long tasks. A
  // laddered task is measured at the TOP of its ladder: the plan is a promise to
  // get there, and "sustainable at week one" is not the question being asked.
  const weeklyMinutes = normalizedTasks.reduce((sum, task) => {
    const perSession =
      task.progression?.metricType === 'MINUTES'
        ? task.progression.stages[task.progression.stages.length - 1].target
        : (task.estimatedMinutes ?? 15);
    return sum + perSession * weeklyFrequency(task.recurrenceType, task.recurrenceConfig);
  }, 0);
  if (weeklyMinutes > 21 * 60) {
    throw new DraftValidationError(
      'That plan would take an unrealistic amount of time each week. Try generating it again.',
    );
  }

  // Deadlines must be in the future, and not absurdly far out.
  let deadline = input.deadline ?? null;
  if (deadline && deadline <= today) {
    adjustments.push(`Deadline ${deadline} was not in the future; removed`);
    deadline = null;
  }
  if (deadline && deadline > addDays(today, 365 * 3)) {
    adjustments.push(`Deadline ${deadline} was too far away; removed`);
    deadline = null;
  }

  // A DEADLINE goal without a date is contradictory; fall back to a habit.
  let targetType = input.targetType;
  if (targetType === 'DEADLINE' && !deadline) {
    adjustments.push('Deadline goal had no valid date; treated as a habit');
    targetType = 'HABIT';
  }

  let targetValue = input.targetValue ?? null;
  if ((targetType === 'QUANTITY' || targetType === 'WEEKLY_TARGET') && !targetValue) {
    adjustments.push('Target value was missing; treated as a habit');
    targetType = 'HABIT';
    targetValue = null;
  }
  if (targetType === 'HABIT') targetValue = null;

  const rationale = toSecondPerson(input.rationale.trim());
  if (rationale.changed) adjustments.push('Rewrote the rationale to address you directly');
  const description = toSecondPerson(input.description?.trim() ?? '');

  return {
    title: input.title.trim(),
    description: description.text,
    category: input.category,
    targetType,
    targetValue,
    deadline,
    rationale: rationale.text,
    tasks: normalizedTasks,
    adjustments,
  };
}
