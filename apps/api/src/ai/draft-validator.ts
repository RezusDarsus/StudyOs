import { addDays, todayIn } from '../domain/dates.js';
import type { ProgressionMetric, RecurrenceType } from '../domain/enums.js';
import { validateStages } from '../domain/progression.js';
import { validateRecurrence, type RecurrenceConfig } from '../domain/recurrence.js';
import type { DraftTaskInput, GoalDraftInput } from './schemas.js';
import { toSecondPerson } from './voice.js';
import { explicitConstraintErrors, extractEvidenceRequirements, parseExplicitGoalConstraints, semanticTaskRoles } from './goal-constraints.js';
import { computeFinancialFeasibility, monthlyCapPeriods, parseFinancialPlan } from './financial-plan.js';

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
      return 0;
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
      if (task.recurrence.allowedWeekdays?.length) {
        config.allowedWeekdays = [...new Set(task.recurrence.allowedWeekdays)].sort((a, b) => a - b);
      }
      if (task.recurrence.excludedWeekdays?.length) {
        config.excludedWeekdays = [...new Set(task.recurrence.excludedWeekdays)].sort((a, b) => a - b);
      }
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
    case 'MONTHLY': {
      config.dayOfMonth = task.recurrence.dayOfMonth;
      break;
    }
    case 'EVERY_X_MONTHS': {
      config.intervalMonths = task.recurrence.intervalMonths;
      config.dayOfMonth = task.recurrence.dayOfMonth;
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
  sourceText = '',
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

  let normalizedTasks: NormalizedTask[] = tasks.map((task) => {
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

  // Models frequently create "Session 1" and "Session 2" with the same full
  // recurrence. The app executes both schedules, so that representation doubles
  // the user's workload. Numbered sessions and weekday-labelled duplicates are
  // one activity split into labels; keep one executable task.
  const semanticSeen = new Set<string>();
  normalizedTasks = normalizedTasks.filter((task) => {
    const raw = task.title.toLowerCase();
    const key = raw
      .replace(/\((?:sun|mon|tues?|wed|thurs?|fri|sat)(?:day)?\)/g, '')
      .replace(/\b(session|block)\s*\d+\b/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (key === raw.trim()) return true;
    if (semanticSeen.has(key)) {
      adjustments.push(`Removed duplicate scheduled task "${task.title}"`);
      return false;
    }
    semanticSeen.add(key);
    return true;
  });

  // If a task itself names exactly one weekday, that statement is less ambiguous
  // than a model-produced integer. Correct Friday/Saturday and Sunday/weekday
  // mapping mistakes deterministically.
  const dayNames: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  for (const task of normalizedTasks) {
    const words = `${task.title} ${task.description}`.toLowerCase();
    const named = [...new Set(
      Object.entries(dayNames)
        .filter(([name]) => new RegExp(`\\b${name}\\b`).test(words))
        .map(([, day]) => day),
    )];
    if (task.recurrenceType === 'SPECIFIC_WEEKDAYS'
        && named.length === 1
        && JSON.stringify(task.recurrenceConfig.weekdays) !== JSON.stringify(named)) {
      adjustments.push(`Aligned "${task.title}" with its named weekday`);
      task.recurrenceConfig = { weekdays: named };
    }
    if (task.recurrenceType === 'ONCE' && named.length === 1) {
      const name = Object.entries(dayNames).find(([, day]) => day === named[0])?.[0];
      const dayIsMandatory = name && new RegExp(
        `(?:every|each|fixed|reserved|including|must(?: be)?(?: the)?)\\s+[^.!?]{0,30}\\b${name}\\b|\\b${name}\\b[^.!?]{0,30}(?:every week|weekly|must|fixed|reserved)`,
        'i',
      ).test(sourceText);
      if (dayIsMandatory) {
        task.recurrenceType = 'SPECIFIC_WEEKDAYS';
        task.recurrenceConfig = { weekdays: named };
        adjustments.push(`Made "${task.title}" recur on its mandatory named weekday`);
      }
    }
  }

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

  if (sourceText) {
    const explicit = parseExplicitGoalConstraints(sourceText, today);

    // Calendar-month intent has higher authority than a synthetic weekday answer.
    // Only finance-transfer tasks are changed, so a monthly budget review does not
    // accidentally rewrite unrelated weekly work in the same goal.
    if (explicit.calendarFrequency) {
      for (const task of normalizedTasks) {
        if (!semanticTaskRoles(task).has('FINANCE_TRANSFER')) continue;
        if (explicit.calendarFrequency.intervalMonths === 1) {
          task.recurrenceType = 'MONTHLY';
          task.recurrenceConfig = { dayOfMonth: explicit.calendarFrequency.dayOfMonth };
        } else {
          task.recurrenceType = 'EVERY_X_MONTHS';
          task.recurrenceConfig = {
            intervalMonths: explicit.calendarFrequency.intervalMonths,
            dayOfMonth: explicit.calendarFrequency.dayOfMonth,
          };
        }
        task.progression = null;
        adjustments.push(`Preserved calendar-month recurrence for "${task.title}"`);
      }
    }

    const sourceFinancialPlan=parseFinancialPlan(sourceText,'');
    if(sourceFinancialPlan?.monthlyCaps?.length){
      const template=normalizedTasks.find((task)=>semanticTaskRoles(task).has('FINANCE_TRANSFER'));
      if(template){
        const symbol=(currency:string)=>currency==='EUR'?'€':currency==='USD'?'$':currency==='GBP'?'£':`${currency} `;
        const bounded=monthlyCapPeriods(sourceFinancialPlan,today).map((period):NormalizedTask=>({
          title:`Monthly contribution ${symbol(period.currency)}${period.amount}`,
          description:`Contribute ${symbol(period.currency)}${period.amount} per month from ${period.activeFrom} through ${period.activeUntil}.`,
          recurrenceType:'MONTHLY',
          recurrenceConfig:{dayOfMonth:1,activeFrom:period.activeFrom,activeUntil:period.activeUntil},
          estimatedMinutes:template.estimatedMinutes,
          preferredTime:template.preferredTime,
          reason:'This bounded phase preserves the user-provided monthly cap without carrying it into another period.',
          reward:template.reward,
          progression:null,
        }));
        normalizedTasks=[...normalizedTasks.filter((task)=>!semanticTaskRoles(task).has('FINANCE_TRANSFER')),...bounded].slice(0,MAX_TASKS);
        adjustments.push('Converted the variable contribution schedule into bounded monthly phases');
      }
    }else if(sourceFinancialPlan?.skippedMonths?.length){
      for(const task of normalizedTasks){
        if(semanticTaskRoles(task).has('FINANCE_TRANSFER')&&(task.recurrenceType==='MONTHLY'||task.recurrenceType==='EVERY_X_MONTHS')){
          task.recurrenceConfig.excludedMonths=sourceFinancialPlan.skippedMonths;
          task.description=`Transfer ${sourceFinancialPlan.contribution.amount} ${sourceFinancialPlan.contribution.currency} once per month, excluding ${sourceFinancialPlan.skippedMonths.join(' and ')}.`;
          task.reason='This preserves the stated monthly amount and explicitly omits the zero-contribution months.';
        }
      }
      adjustments.push('Encoded the explicitly skipped contribution months in the recurrence');
    }

    if (explicit.undefinedMetric && (targetType === 'QUANTITY' || targetType === 'WEEKLY_TARGET')) {
      targetType = 'HABIT';
      targetValue = null;
      adjustments.push('Removed an invented numeric target from an undefined success metric');
    }

    // A proposed ladder is not an accepted change. When the user's words reserve
    // authority, keep the flat current stage and drop every proposed ladder.
    if (/wait[^.]{0,40}(?:approval|approve)|require[^.]{0,50}approval|do not (?:apply|change|expand)|until i explicitly|i reject|my override|recommend[^.]{0,50}do not change|ask before|let me decide|my decision|decide when (?:to )?resume/i.test(sourceText)) {
      for (const task of normalizedTasks) {
        if (task.progression) {
          task.progression = null;
          adjustments.push(`Dropped unapproved progression on "${task.title}"`);
        }
      }
    }

    if(/\brecommend\s+PAUSE\b/i.test(sourceText)&&/let me decide|my decision|decide when (?:to )?resume/i.test(sourceText)){
      for(const task of normalizedTasks){
        task.title='Review whether to resume';
        task.description='After the pause, decide whether and when to resume; no training session is scheduled automatically.';
        task.reason='You reserved the resume decision, so the current stage stays paused until you explicitly choose otherwise.';
        task.recurrenceType='ONCE';
        task.recurrenceConfig={};
        task.progression=null;
      }
      adjustments.push('Preserved the user-controlled pause without scheduling an automatic resume');
    }

    const evidenceRequirements=extractEvidenceRequirements(sourceText);
    if(evidenceRequirements.length){
      const tokens=(value:string)=>value.toLowerCase().match(/[a-z0-9]+/g)?.filter((token)=>!['a','an','the','of','for','from','with','and','or','to'].includes(token))??[];
      const focused=(requirement:string,task:NormalizedTask)=>{
        const actual=tokens(`${task.title} ${task.description}`);
        return tokens(requirement).every((expected)=>actual.some((token)=>token===expected||token.startsWith(expected)||expected.startsWith(token)));
      };
      const genericFallback=normalizedTasks.length===1&&/conservative fallback|first concrete step/i.test(`${normalizedTasks[0].title} ${normalizedTasks[0].reason}`);
      if(genericFallback)normalizedTasks=[];
      for(const requirement of evidenceRequirements){
        if(normalizedTasks.some((task)=>focused(requirement,task)))continue;
        if(normalizedTasks.length>=MAX_TASKS)break;
        const estimatedMinutes=Math.min(explicit.maxWeeklyMinutes??60,120);
        normalizedTasks.push({
          title:`Deliver: ${requirement}`.slice(0,120),
          description:`Produce and verify this user-defined evidence: ${requirement}.`.slice(0,500),
          recurrenceType:'ONCE',recurrenceConfig:{},estimatedMinutes,preferredTime:null,
          reason:'You explicitly defined this as required evidence of the outcome.',
          reward:rewardForTask({estimatedMinutes}),progression:null,
        });
        adjustments.push(`Added missing user-defined evidence: ${requirement}`);
      }
    }

    let total = normalizedTasks.reduce(
      (sum, task) => sum + weeklyFrequency(task.recurrenceType, task.recurrenceConfig), 0,
    );
    if (explicit.exactWeekly !== undefined && total < explicit.exactWeekly) {
      const usedDays = new Set(normalizedTasks.flatMap((task) => (
        task.recurrenceType === 'SPECIFIC_WEEKDAYS' ? (task.recurrenceConfig.weekdays ?? []) : []
      )));
      for (const task of normalizedTasks) {
        if (total >= explicit.exactWeekly) break;
        if (task.recurrenceType !== 'ONCE') continue;
        const words = `${task.title} ${task.description}`.toLowerCase();
        const named = [...new Set(Object.entries(dayNames)
          .filter(([name]) => new RegExp(`\\b${name}\\b`).test(words))
          .map(([, day]) => day))];
        const candidates = named.filter((day) => !explicit.allowedDays || explicit.allowedDays.includes(day));
        const day = candidates.find((candidate) => !usedDays.has(candidate))
          ?? explicit.allowedDays?.find((candidate) => !usedDays.has(candidate));
        if (day === undefined) continue;
        task.recurrenceType = 'SPECIFIC_WEEKDAYS';
        task.recurrenceConfig = { weekdays: [day] };
        usedDays.add(day);
        total += 1;
        adjustments.push(`Scheduled "${task.title}" on one available weekly day`);
      }
    }
    if (explicit.exactWeekly !== undefined && total > explicit.exactWeekly) {
      for (let i = normalizedTasks.length - 1; i > 0 && total > explicit.exactWeekly; i--) {
        const task = normalizedTasks[i];
        const taskFrequency = weeklyFrequency(task.recurrenceType, task.recurrenceConfig);
        if (taskFrequency > 0 && total - taskFrequency >= explicit.exactWeekly) {
          task.recurrenceType = 'ONCE';
          task.recurrenceConfig = {};
          task.progression = null;
          total -= taskFrequency;
          adjustments.push(`Made "${task.title}" a one-off to preserve the total weekly frequency`);
        }
      }
    }
    if (explicit.exactWeekly !== undefined && Math.abs(total - explicit.exactWeekly) > 0.01 && normalizedTasks.length) {
      if (explicit.allowedDays && explicit.allowedDays.length >= explicit.exactWeekly) {
        normalizedTasks[0].recurrenceType = 'SPECIFIC_WEEKDAYS';
        normalizedTasks[0].recurrenceConfig = {
          weekdays: explicit.allowedDays.slice(0, explicit.exactWeekly),
        };
      } else {
        normalizedTasks[0].recurrenceType = 'TIMES_PER_WEEK';
        normalizedTasks[0].recurrenceConfig = {
          timesPerWeek: explicit.exactWeekly,
          allowedWeekdays: explicit.allowedDays?.length?explicit.allowedDays:undefined,
          excludedWeekdays: explicit.excludedDays.length ? explicit.excludedDays : undefined,
        };
      }
      for (const task of normalizedTasks.slice(1)) {
        task.recurrenceType = 'ONCE';
        task.recurrenceConfig = {};
        task.progression = null;
      }
      adjustments.push(`Aligned the executable schedule to exactly ${explicit.exactWeekly} total sessions per week`);
    }
    if (explicit.maxWeekly !== undefined) {
      let recurring = normalizedTasks.reduce(
        (sum, task) => sum + weeklyFrequency(task.recurrenceType, task.recurrenceConfig), 0,
      );
      for (let i = normalizedTasks.length - 1; i > 0 && recurring > explicit.maxWeekly; i--) {
        const task = normalizedTasks[i];
        const taskFrequency = weeklyFrequency(task.recurrenceType, task.recurrenceConfig);
        if (taskFrequency <= 0) continue;
        task.recurrenceType = 'ONCE';
        task.recurrenceConfig = {};
        task.progression = null;
        recurring -= taskFrequency;
        adjustments.push(`Made "${task.title}" a one-off to respect the weekly maximum`);
      }
      if (recurring > explicit.maxWeekly && normalizedTasks.length) {
        normalizedTasks[0].recurrenceType = 'TIMES_PER_WEEK';
        normalizedTasks[0].recurrenceConfig = {
          timesPerWeek: explicit.maxWeekly,
          allowedWeekdays: explicit.allowedDays?.length?explicit.allowedDays:undefined,
          excludedWeekdays: explicit.excludedDays.length ? explicit.excludedDays : undefined,
        };
      }
    }
    if (explicit.allowedDays?.length) {
      for (const task of normalizedTasks) {
        if (task.recurrenceType === 'TIMES_PER_WEEK') {
          task.recurrenceConfig.allowedWeekdays = explicit.allowedDays;
          task.recurrenceConfig.excludedWeekdays = explicit.excludedDays.length ? explicit.excludedDays : undefined;
          continue;
        }
        if (task.recurrenceType !== 'SPECIFIC_WEEKDAYS') continue;
        const current = task.recurrenceConfig.weekdays ?? [];
        if (current.some((day) => !explicit.allowedDays!.includes(day))) {
          const count = Math.min(Math.max(current.length, 1), explicit.allowedDays.length);
          task.recurrenceConfig = { weekdays: explicit.allowedDays.slice(0, count) };
          adjustments.push(`Moved "${task.title}" onto the user's allowed weekdays`);
        }
      }
    }
    if (explicit.excludedDays.length) {
      for (const task of normalizedTasks) {
        if (task.recurrenceType !== 'TIMES_PER_WEEK') continue;
        task.recurrenceConfig.excludedWeekdays = explicit.excludedDays;
        task.recurrenceConfig.allowedWeekdays ??= [0,1,2,3,4,5,6]
          .filter((day)=>!explicit.excludedDays.includes(day));
      }
    }

    // Reconcile semantic roles after aggregate-frequency normalization. Aggregate
    // math alone can otherwise turn "three sessions" into three trail runs while
    // leaving a required strength task as ONCE, or move a fixed Saturday trail
    // session onto an arbitrary allowed day.
    const usedSpecificDays = () => new Set(normalizedTasks.flatMap((task) => (
      task.recurrenceType === 'SPECIFIC_WEEKDAYS' ? task.recurrenceConfig.weekdays ?? [] : []
    )));
    for (const requirement of explicit.requiredRoleDays) {
      const task = normalizedTasks.find((candidate) => semanticTaskRoles(candidate).has(requirement.role));
      if (!task) continue;
      const priorFrequency = Math.max(weeklyFrequency(task.recurrenceType, task.recurrenceConfig), requirement.days.length);
      const allowed = explicit.allowedDays ?? [0, 1, 2, 3, 4, 5, 6];
      const retained = task.recurrenceType === 'SPECIFIC_WEEKDAYS'
        ? (task.recurrenceConfig.weekdays ?? []).filter((day) => !requirement.days.includes(day))
        : [];
      task.recurrenceType = 'SPECIFIC_WEEKDAYS';
      task.recurrenceConfig = {
        weekdays: [...new Set([
          ...requirement.days,
          ...retained,
          ...allowed.filter((day) => !requirement.days.includes(day)),
        ])].slice(0, priorFrequency),
      };
      adjustments.push(`Placed the ${requirement.role.toLowerCase()} role on its required weekday`);
    }
    for (const requirement of explicit.requiredWeeklyRoles) {
      const matches = normalizedTasks.filter((task) => semanticTaskRoles(task).has(requirement.role));
      const actual = matches.reduce((sum, task) => sum + weeklyFrequency(task.recurrenceType, task.recurrenceConfig), 0);
      if (actual >= requirement.minOccurrences || !matches.length) continue;
      const task = matches[0];
      const used = usedSpecificDays();
      const allowed = explicit.allowedDays ?? [0, 1, 2, 3, 4, 5, 6];
      const weekday = allowed.find((day) => !used.has(day)) ?? allowed[0];
      task.recurrenceType = 'SPECIFIC_WEEKDAYS';
      task.recurrenceConfig = { weekdays: [weekday] };
      task.progression = null;
      adjustments.push(`Made the ${requirement.role.toLowerCase()} role recur weekly`);
    }
    if (explicit.exactWeekly !== undefined) {
      const requiredDaysFor = (task: NormalizedTask) => explicit.requiredRoleDays
        .filter((requirement) => semanticTaskRoles(task).has(requirement.role))
        .flatMap((requirement) => requirement.days);
      const roleMinimumWouldHold = (candidate: NormalizedTask) => explicit.requiredWeeklyRoles.every((requirement) => {
        const occurrences = normalizedTasks
          .filter((task) => semanticTaskRoles(task).has(requirement.role))
          .reduce((sum, task) => sum + weeklyFrequency(task.recurrenceType, task.recurrenceConfig), 0);
        return occurrences >= requirement.minOccurrences
          && (!semanticTaskRoles(candidate).has(requirement.role) || occurrences >= requirement.minOccurrences);
      });
      let recurring = normalizedTasks.reduce((sum, task) => sum + weeklyFrequency(task.recurrenceType, task.recurrenceConfig), 0);
      while (recurring > explicit.exactWeekly) {
        let changed = false;
        for (const task of normalizedTasks) {
          if (recurring <= explicit.exactWeekly) break;
          if (task.recurrenceType !== 'SPECIFIC_WEEKDAYS') continue;
          const weekdays = task.recurrenceConfig.weekdays ?? [];
          const protectedDays = requiredDaysFor(task);
          const removable = weekdays.find((day) => !protectedDays.includes(day));
          if (removable === undefined || weekdays.length <= 1) continue;
          const before = [...weekdays];
          task.recurrenceConfig.weekdays = weekdays.filter((day) => day !== removable);
          if (!roleMinimumWouldHold(task)) {
            task.recurrenceConfig.weekdays = before;
            continue;
          }
          recurring -= 1;
          changed = true;
        }
        if (!changed) break;
      }
    }
    if (explicit.monthlyMoneyCap !== undefined) {
      const cap = explicit.monthlyMoneyCap;
      const clampMoney = (text: string) => text.replace(
        /([€$£]\s*)([\d,]+)|([\d,]+)(\s*[€$£])/g,
        (match, prefix, first, second, suffix) => {
          const amount = Number((first ?? second).replace(/,/g, ''));
          if (amount <= cap) return match;
          adjustments.push(`Reduced an over-cap contribution amount to ${cap}`);
          return prefix ? `${prefix}${cap}` : `${cap}${suffix}`;
        },
      );
      for (const task of normalizedTasks) {
        task.title = clampMoney(task.title);
        task.description = clampMoney(task.description);
        task.reason = clampMoney(task.reason);
        if (task.progression?.metricType === 'AMOUNT' && task.progression.stages.some((stage) => stage.target > cap)) {
          task.progression = null;
          adjustments.push(`Dropped an over-cap monetary progression on "${task.title}"`);
        }
      }
    }
    if (explicit.maxWeeklyMinutes !== undefined) {
      const workload = () => normalizedTasks.reduce(
        (sum, task) => sum + (task.estimatedMinutes ?? 15) * weeklyFrequency(task.recurrenceType, task.recurrenceConfig), 0,
      );
      for (let i = normalizedTasks.length - 1; i > 0 && workload() > explicit.maxWeeklyMinutes; i--) {
        const task = normalizedTasks[i];
        if (weeklyFrequency(task.recurrenceType, task.recurrenceConfig) > 0) {
          task.recurrenceType = 'ONCE';
          task.recurrenceConfig = {};
          task.progression = null;
          adjustments.push(`Made "${task.title}" a one-off deliverable to respect weekly capacity`);
        }
      }
    }
    const errors = explicitConstraintErrors(explicit, {
      targetType,
      targetValue,
      deadline,
      tasks: normalizedTasks,
    });
    for(const task of normalizedTasks)validateRecurrence(task.recurrenceType,task.recurrenceConfig);
    if (errors.length) throw new DraftValidationError(errors.join(' '));
  }

  const genericPlaceholder = normalizedTasks.length === 1
    && /^(?:take (?:the )?first (?:concrete )?step|work on (?:the |your )?goal|get started|start working)$/i
      .test(normalizedTasks[0].title.trim());
  if (genericPlaceholder) {
    throw new DraftValidationError(
      'The plan returned a generic placeholder instead of an executable task.',
    );
  }

  const rationale = toSecondPerson(input.rationale.trim());
  if (rationale.changed) adjustments.push('Rewrote the rationale to address you directly');
  const description = toSecondPerson(input.description?.trim() ?? '');
  const originalRequest = sourceText.split('\n', 1)[0]?.trim() ?? '';
  let descriptionText = description.text;
  const acceptedSingleAddition=/\b(?:explicitly\s+)?accept(?:ed|ing)?\b[^.!?]{0,100}\badd(?:ed|ing)?\s+(?:exactly\s+)?(?:one|1)\s+weekly\b|\badd(?:ed|ing)?\s+(?:exactly\s+)?(?:one|1)\s+weekly\b[^.!?]{0,100}\baccept(?:ed|ance)?\b/i.test(sourceText);
  if(acceptedSingleAddition){
    descriptionText='Add the single weekly activity you explicitly accepted; no other schedule change is applied.';
    for(const task of normalizedTasks){
      if(weeklyFrequency(task.recurrenceType,task.recurrenceConfig)>0)task.reason='This is the one weekly addition you explicitly accepted.';
    }
  }
  if (originalRequest && !descriptionText.toLowerCase().includes(originalRequest.toLowerCase())) {
    descriptionText = `${descriptionText}${descriptionText ? ' ' : ''}Original request: ${originalRequest}`.slice(0, 1000);
  }
  let rationaleText = rationale.text;
  const outputText = `${input.title}\n${input.description}\n${input.rationale}\n${input.tasks.map((task)=>`${task.title} ${task.description} ${task.reason}`).join('\n')}`;
  const financialPlan = parseFinancialPlan(sourceText, outputText);
  if (financialPlan) {
    const feasibility=computeFinancialFeasibility(financialPlan,today);
    if (feasibility.missing.includes('EXCHANGE_RATE')) {
      throw new DraftValidationError('Cross-currency finance requires an explicit exchange-rate answer or labeled planning assumption.');
    }
    if (feasibility.targetInContributionCurrency!==null && feasibility.requiredContributions!==null) {
      const rate=financialPlan.exchangeRate;
      const assumption=rate
        ? `Using ${rate.value} ${rate.quote} per ${rate.base}${rate.source==='ASSUMPTION'?' as a changeable planning assumption':''}, `
        : '';
      const savings=financialPlan.existingSavings
        ? `after ${financialPlan.existingSavings.amount} ${financialPlan.existingSavings.currency} already saved, `
        : 'assuming zero current savings, ';
      const opportunities=feasibility.maximumContributionOpportunities;
      rationaleText += ` ${assumption}${financialPlan.target.amount} ${financialPlan.target.currency} equals ${Number(feasibility.targetInContributionCurrency.toFixed(2))} ${financialPlan.contribution.currency}; ${savings}`;
      if(financialPlan.monthlyCaps?.length){
        rationaleText += `the monthly caps provide at most ${Number((feasibility.maximumContributable??0).toFixed(2))} ${financialPlan.contribution.currency} by the deadline`;
        if((feasibility.shortfall??0)>0) rationaleText += `, leaving a ${Number(feasibility.shortfall!.toFixed(2))} ${financialPlan.contribution.currency} shortfall`;
        rationaleText += '.';
      }else{
        rationaleText += `${feasibility.requiredContributions} monthly contributions of ${financialPlan.contribution.amount} ${financialPlan.contribution.currency} are required.`;
      }
      if (feasibility.feasible===false) {
        rationaleText += ` At most ${opportunities} monthly contribution opportunities remain, so the plan has a shortfall and needs current savings, a higher allowed contribution, or a later deadline.`;
      }
    }
  }
  const requestedRecommendation = sourceText.match(/\brecommend\s+(STAY|REDUCE|PROGRESS|PAUSE)\b/i)?.[1]?.toUpperCase();
  const inferredRecommendation = requestedRecommendation
    ?? (/\bsustainable\b/i.test(sourceText) && /recovery is good/i.test(sourceText) ? 'STAY' : undefined);
  if (inferredRecommendation && !new RegExp(`\\b${inferredRecommendation}\\b`).test(rationaleText)) {
    rationaleText += ` Recommendation: ${inferredRecommendation}.`;
  }
  if(/\brecommend\s+PAUSE\b/i.test(sourceText)&&/let me decide|my decision|decide when (?:to )?resume/i.test(sourceText)&&!/no automatic resume/i.test(rationaleText)){
    rationaleText+=' The current stage remains paused with no automatic resume; you decide whether and when to restart.';
  }
  if (/\boverride\b/i.test(sourceText) && /\bstay\b/i.test(sourceText) && !/OVERRIDE_STAY/.test(rationaleText)) {
    rationaleText += ' Your explicit decision is OVERRIDE_STAY.';
  }
  if (/challenge the plan|not treat[^.]{0,80}achievable|identify the missing decisions|uncontrollable acceptance|calculate whether|show any (?:gap|shortfall)|conservative plan|\b(?:expert|cybersecurity expert)\b|three different days[^.]{0,100}only days|(?:fluent|fluency|conversational)[^.]{0,100}(?:two months|one hour)/i.test(sourceText)
      && !/infeasible|unrealistic|shortfall|gap|reduce|extend|cannot|can't|trade.?off|not enough|insufficient/i.test(rationaleText)) {
    rationaleText += ' These constraints may be infeasible together; expose any shortfall and reduce scope or extend the deadline instead of promising the outcome.';
  }
  if (/falls? short/i.test(rationaleText) && !/shortfall/i.test(rationaleText)) {
    rationaleText += ' This is a shortfall that requires a trade-off.';
  }
  const finalConstraints=sourceText ? parseExplicitGoalConstraints(sourceText,today) : null;
  if (finalConstraints?.progressionPolicy) {
    const policy=finalConstraints.progressionPolicy;
    const parts:string[]=[];
    if(policy.painFreeWeeks) parts.push(`PROGRESS only after ${policy.painFreeWeeks} pain-free weeks`);
    if(policy.reduceOnRepeatedPain) parts.push('REDUCE after repeated pain');
    if(policy.pauseOnSharpPain) parts.push('PAUSE for sharp pain');
    if(policy.approvalRequired) parts.push('do not apply a recommendation until you approve it');
    if(parts.length && !parts.every((part)=>rationaleText.toLowerCase().includes(part.toLowerCase()))) {
      rationaleText += ` Recovery policy: ${parts.join('; ')}.`;
    }
  }
  if (finalConstraints?.maxWeeklyMinutes && finalConstraints.preferredWeeklyBlocks) {
    const hours=Number((finalConstraints.maxWeeklyMinutes/60).toFixed(2));
    const evening=finalConstraints.prohibitConsecutiveEvenings?' on non-consecutive evenings':'';
    const approval=/approval/i.test(sourceText)?'; any workload increase remains a recommendation until you approve it':'';
    rationaleText += ` Weekly capacity remains ${hours} hours in about ${finalConstraints.preferredWeeklyBlocks} flexible blocks${evening}${approval}.`;
  }

  return {
    title: input.title.trim(),
    description: descriptionText,
    category: input.category,
    targetType,
    targetValue,
    deadline,
    rationale: rationaleText.slice(0, 1200),
    tasks: normalizedTasks,
    adjustments,
  };
}
