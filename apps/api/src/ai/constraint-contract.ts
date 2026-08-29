import type { DayString } from '../domain/dates.js';
import type { RecurrenceType } from '../domain/enums.js';
import type { RecurrenceConfig } from '../domain/recurrence.js';
import type { NormalizedProgression, NormalizedTask } from './draft-validator.js';
import {
  canonicalWeekdayOrder, semanticTaskRoles, taskMoneyAmounts, taskWeeklyFrequency,
  type ExplicitGoalConstraints, type SemanticTaskRole,
} from './goal-constraints.js';

// The ConstraintContract is the deterministic bridge between what the user said
// and what the pipeline is allowed to hand back. parseExplicitGoalConstraints
// reads the user's English; this module freezes that reading into a plain,
// serializable object and checks any draft against it. Normalization may repair
// FORM (schema shape, merging with proven equivalence, ordering) — never
// SEMANTICS — and checkContract is the oracle that says which is which.
//
// Everything here is pure and dependency-free so the benchmark scorer can run
// the same checker over raw model drafts later.

export type ContractViolationCode =
  | 'EXACT_WEEKLY_MISMATCH'
  | 'MAX_WEEKLY_EXCEEDED'
  | 'REQUIRED_WEEKDAY_MISSING'
  | 'EXCLUDED_WEEKDAY_USED'
  | 'ALLOWED_WEEKDAY_EXCEEDED'
  | 'FLEXIBLE_BOUNDARY_LOST'
  | 'ROLE_WEEKLY_MINIMUM'
  | 'ROLE_WEEKDAY_MISSING'
  | 'MONTHLY_CADENCE_BROKEN'
  | 'EXCLUDED_MONTH_DROPPED'
  | 'MONTHLY_PHASE_MISSING'
  | 'MONEY_CAP_EXCEEDED'
  | 'SESSION_MINUTES_EXCEEDED'
  | 'WEEKLY_MINUTES_EXCEEDED'
  | 'DEADLINE_MISMATCH'
  | 'UNDEFINED_METRIC'
  | 'CONSECUTIVE_EVENINGS'
  | 'FORBIDDEN_ACTIVITY';

export interface ContractViolation {
  code: ContractViolationCode;
  message: string;
}

/** One bounded phase of a variable monthly contribution schedule. */
export interface ContractMonthlyPhase {
  activeFrom: DayString;
  activeUntil: DayString;
  amount: number;
  currency: string;
}

export interface ConstraintContract {
  exactWeekly?: number;
  maxWeekly?: number;
  /** Days that must carry a scheduled occurrence, Monday-first canonical order. */
  requiredWeekdays: number[];
  /** Days the user excluded, Monday-first canonical order. */
  excludedWeekdays: number[];
  /** The flexible pool a schedule may draw from, Monday-first canonical order. */
  allowedWeekdays?: number[];
  /** FIXED names its days; FLEXIBLE states counts within a day pool. */
  cadence: 'FIXED' | 'FLEXIBLE' | 'UNSPECIFIED';
  roleMinWeekly: Array<{ role: SemanticTaskRole; minOccurrences: number }>;
  roleDays: Array<{ role: SemanticTaskRole; days: number[] }>;
  /** Stated calendar-month cadence (intervalMonths, dayOfMonth incl 'LAST'). */
  monthly?: { intervalMonths: number; dayOfMonth?: number | 'LAST' };
  /** Calendar months the user explicitly excluded (YYYY-MM). */
  excludedMonths?: string[];
  /** Bounded monthly phases of a variable contribution schedule. */
  monthlyPhases?: ContractMonthlyPhase[];
  deadline?: DayString;
  monthlyMoneyCap?: number;
  maxMinutesPerSession?: number;
  maxWeeklyMinutes?: number;
  /** The user's stated total weekly workload (sum of taskWeeklyFrequency). */
  totalWeeklyOccurrences?: number;
  prohibitConsecutiveEvenings: boolean;
  undefinedMetric: boolean;
  forbiddenActivities: string[];
}

/** The minimal task shape the checker needs — a NormalizedTask satisfies it. */
export interface ContractTask {
  title: string;
  description?: string;
  reason?: string;
  recurrenceType: RecurrenceType;
  recurrenceConfig: RecurrenceConfig;
  estimatedMinutes?: number | null;
  progression?: NormalizedProgression | null;
}

export interface ContractDraft {
  targetType?: string;
  targetValue?: number | null;
  deadline?: string | null;
  tasks: ContractTask[];
}

export interface ContractExtras {
  excludedMonths?: string[];
  monthlyPhases?: ContractMonthlyPhase[];
}

/**
 * Freeze the parsed constraints (+ session-derived financial facts) into a
 * serializable contract. Pure: the same constraints always build the same
 * contract, regardless of clause order in the source text.
 */
export function buildConstraintContract(
  constraints: ExplicitGoalConstraints,
  extras: ContractExtras = {},
): ConstraintContract {
  const roleDays = constraints.requiredRoleDays.map((requirement) => ({ ...requirement }));
  const cadence: ConstraintContract['cadence'] = roleDays.length
    ? 'FIXED'
    : constraints.allowedDays?.length && (constraints.exactWeekly !== undefined || constraints.maxWeekly !== undefined)
      ? 'FLEXIBLE'
      : 'UNSPECIFIED';
  return {
    exactWeekly: constraints.exactWeekly,
    maxWeekly: constraints.maxWeekly,
    requiredWeekdays: canonicalWeekdayOrder(roleDays.flatMap((requirement) => requirement.days)),
    excludedWeekdays: canonicalWeekdayOrder(constraints.excludedDays),
    allowedWeekdays: constraints.allowedDays?.length ? canonicalWeekdayOrder(constraints.allowedDays) : undefined,
    cadence,
    roleMinWeekly: constraints.requiredWeeklyRoles.map((requirement) => ({ ...requirement })),
    roleDays,
    monthly: constraints.calendarFrequency ? { ...constraints.calendarFrequency } : undefined,
    excludedMonths: extras.excludedMonths?.length ? [...extras.excludedMonths] : undefined,
    monthlyPhases: extras.monthlyPhases?.length ? extras.monthlyPhases.map((phase) => ({ ...phase })) : undefined,
    deadline: constraints.deadline,
    monthlyMoneyCap: constraints.monthlyMoneyCap,
    maxMinutesPerSession: constraints.maxMinutes,
    maxWeeklyMinutes: constraints.maxWeeklyMinutes,
    totalWeeklyOccurrences: constraints.exactWeekly,
    prohibitConsecutiveEvenings: constraints.prohibitConsecutiveEvenings,
    undefinedMetric: constraints.undefinedMetric,
    forbiddenActivities: [...constraints.forbiddenActivities],
  };
}

const taskText = (task: ContractTask): string => `${task.title} ${task.description ?? ''} ${task.reason ?? ''}`;

/** A negation immediately before a forbidden activity means the task honors it. */
function assertsForbiddenActivity(text: string, activity: string): boolean {
  const occurrences = [...text.matchAll(new RegExp(`\\b${activity.replace(/\s+/g, '\\s+')}`, 'gi'))];
  return occurrences.some((match) => {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 80), match.index).toLowerCase();
    return !/(?:do not|don't|never|without|not|no|cannot|can't|avoid|instead of|zero|quit|stopped?)\s+(?:\w+\s+){0,8}$/.test(before);
  });
}

/** True when the plan's fixed weekday occurrences include two adjacent days. */
function hasConsecutiveEvenings(tasks: ContractTask[]): boolean {
  const days = new Set(tasks
    .filter((task) => task.recurrenceType === 'SPECIFIC_WEEKDAYS')
    .flatMap((task) => task.recurrenceConfig.weekdays ?? []));
  return [...days].some((day) => days.has((day + 1) % 7));
}

/**
 * Check a draft against the contract. Returns every violation with an
 * actionable message; an empty array means the draft may be simplified only in
 * ways that preserve these invariants. Pure: never mutates the draft.
 */
export function checkContract(contract: ConstraintContract, draft: ContractDraft): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const tasks = draft.tasks;
  const total = tasks.reduce((sum, task) => sum + taskWeeklyFrequency(task), 0);
  if (contract.exactWeekly !== undefined && Math.abs(total - contract.exactWeekly) > 0.01) {
    violations.push({
      code: 'EXACT_WEEKLY_MISMATCH',
      message: `The user requires exactly ${contract.exactWeekly} total sessions per week, but the tasks total ${Number(total.toFixed(2))}. Rebuild the schedule to execute that total.`,
    });
  }
  if (contract.maxWeekly !== undefined && total > contract.maxWeekly) {
    violations.push({
      code: 'MAX_WEEKLY_EXCEEDED',
      message: `The user allows at most ${contract.maxWeekly} total sessions per week, but the tasks total ${Number(total.toFixed(2))}.`,
    });
  }
  for (const day of contract.requiredWeekdays) {
    const covered = tasks.some((task) => task.recurrenceType === 'SPECIFIC_WEEKDAYS'
      && (task.recurrenceConfig.weekdays ?? []).includes(day));
    if (!covered) {
      violations.push({
        code: 'REQUIRED_WEEKDAY_MISSING',
        message: `The user requires an occurrence on ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]}, and no task schedules one.`,
      });
    }
  }
  for (const task of tasks) {
    const days = task.recurrenceType === 'SPECIFIC_WEEKDAYS' ? (task.recurrenceConfig.weekdays ?? []) : [];
    if (contract.excludedWeekdays.some((day) => days.includes(day))) {
      violations.push({
        code: 'EXCLUDED_WEEKDAY_USED',
        message: `"${task.title}" uses a weekday the user excluded.`,
      });
    }
    if (contract.allowedWeekdays?.length && days.some((day) => !contract.allowedWeekdays!.includes(day))) {
      violations.push({
        code: 'ALLOWED_WEEKDAY_EXCEEDED',
        message: `"${task.title}" uses a weekday outside the user's allowed days.`,
      });
    }
    if (task.recurrenceType === 'TIMES_PER_WEEK') {
      const allowed = task.recurrenceConfig.allowedWeekdays;
      const excluded = task.recurrenceConfig.excludedWeekdays ?? [];
      if (contract.allowedWeekdays?.length && (!allowed || allowed.some((day) => !contract.allowedWeekdays!.includes(day)))) {
        violations.push({
          code: 'FLEXIBLE_BOUNDARY_LOST',
          message: `"${task.title}" does not preserve the flexible allowed-weekday boundary.`,
        });
      }
      if (contract.excludedWeekdays.some((day) => !excluded.includes(day) && (!allowed || allowed.includes(day)))) {
        violations.push({
          code: 'FLEXIBLE_BOUNDARY_LOST',
          message: `"${task.title}" may still occur on an excluded weekday.`,
        });
      }
    }
    // A monthly task that lost its stated day of month is the classic silent
    // rewrite: MONTHLY {} executes on the start date, not the "1st" the user said.
    if (task.recurrenceType === 'MONTHLY' || task.recurrenceType === 'EVERY_X_MONTHS') {
      const stated = contract.monthly?.dayOfMonth;
      if (stated !== undefined && task.recurrenceConfig.dayOfMonth !== stated) {
        violations.push({
          code: 'MONTHLY_CADENCE_BROKEN',
          message: `"${task.title}" is a monthly recurrence without the stated day of the month (${stated}); keep the monthly recurrence on that day.`,
        });
      }
      if (task.recurrenceType === 'EVERY_X_MONTHS' && contract.monthly
          && task.recurrenceConfig.intervalMonths !== contract.monthly.intervalMonths) {
        violations.push({
          code: 'MONTHLY_CADENCE_BROKEN',
          message: `"${task.title}" repeats every ${task.recurrenceConfig.intervalMonths ?? '?'} months, but the user stated every ${contract.monthly.intervalMonths} months.`,
        });
      }
    }
    const roles = semanticTaskRoles(task as Pick<NormalizedTask, 'title' | 'description' | 'reason'>);
    if (roles.has('FINANCE_TRANSFER')) {
      // Calendar-month machinery protects money transfers from being flattened
      // into weekly work; a finance task that dodges the stated cadence breaks it.
      if (contract.monthly) {
        const monthlyType = contract.monthly.intervalMonths === 1 ? 'MONTHLY' : 'EVERY_X_MONTHS';
        if (task.recurrenceType !== monthlyType) {
          violations.push({
            code: 'MONTHLY_CADENCE_BROKEN',
            message: `"${task.title}" is a money transfer but does not carry the stated calendar-month cadence.`,
          });
        }
      }
      if (contract.excludedMonths?.length && (task.recurrenceType === 'MONTHLY' || task.recurrenceType === 'EVERY_X_MONTHS')) {
        const missing = contract.excludedMonths.filter((month) => !task.recurrenceConfig.excludedMonths?.includes(month));
        if (missing.length) {
          violations.push({
            code: 'EXCLUDED_MONTH_DROPPED',
            message: `"${task.title}" lost the explicitly skipped contribution months (${missing.join(', ')}).`,
          });
        }
      }
      if (contract.monthlyMoneyCap !== undefined
          && taskMoneyAmounts(task as Pick<NormalizedTask, 'title' | 'description' | 'reason' | 'progression'>)
            .some((amount) => amount > contract.monthlyMoneyCap!)) {
        violations.push({
          code: 'MONEY_CAP_EXCEEDED',
          message: `"${task.title}" exceeds the user's monthly contribution cap of ${contract.monthlyMoneyCap}.`,
        });
      }
    }
    if (contract.maxMinutesPerSession !== undefined && (task.estimatedMinutes ?? 0) > contract.maxMinutesPerSession) {
      violations.push({
        code: 'SESSION_MINUTES_EXCEEDED',
        message: `"${task.title}" exceeds the user's ${contract.maxMinutesPerSession}-minute session cap.`,
      });
    }
    if (contract.forbiddenActivities.some((activity) => assertsForbiddenActivity(taskText(task), activity))) {
      violations.push({
        code: 'FORBIDDEN_ACTIVITY',
        message: `"${task.title}" schedules an activity the user explicitly forbade.`,
      });
    }
  }
  for (const requirement of contract.roleMinWeekly) {
    const frequency = tasks
      .filter((task) => semanticTaskRoles(task as Pick<NormalizedTask, 'title' | 'description' | 'reason'>).has(requirement.role))
      .reduce((sum, task) => sum + taskWeeklyFrequency(task), 0);
    if (frequency < requirement.minOccurrences) {
      violations.push({
        code: 'ROLE_WEEKLY_MINIMUM',
        message: `${requirement.role} requires at least ${requirement.minOccurrences} weekly occurrence.`,
      });
    }
  }
  for (const requirement of contract.roleDays) {
    const scheduledDays = new Set(tasks
      .filter((task) => semanticTaskRoles(task as Pick<NormalizedTask, 'title' | 'description' | 'reason'>).has(requirement.role)
        && task.recurrenceType === 'SPECIFIC_WEEKDAYS')
      .flatMap((task) => task.recurrenceConfig.weekdays ?? []));
    if (requirement.days.some((day) => !scheduledDays.has(day))) {
      violations.push({
        code: 'ROLE_WEEKDAY_MISSING',
        message: `${requirement.role} is missing from its required weekday.`,
      });
    }
  }
  if (contract.monthlyPhases?.length) {
    for (const phase of contract.monthlyPhases) {
      const represented = tasks.some((task) => {
        if (task.recurrenceType !== 'MONTHLY') return false;
        if (!semanticTaskRoles(task as Pick<NormalizedTask, 'title' | 'description' | 'reason'>).has('FINANCE_TRANSFER')) return false;
        if (task.recurrenceConfig.activeFrom !== phase.activeFrom
            || task.recurrenceConfig.activeUntil !== phase.activeUntil) return false;
        return new RegExp(`(?:[€$£]\\s*${phase.amount}\\b|\\b${phase.amount}\\s*${phase.currency}\\b)`, 'i').test(taskText(task));
      });
      if (!represented) {
        violations.push({
          code: 'MONTHLY_PHASE_MISSING',
          message: `The bounded monthly contribution of ${phase.amount} ${phase.currency} from ${phase.activeFrom} through ${phase.activeUntil} is not represented as a monthly task.`,
        });
      }
    }
  }
  if (contract.maxWeeklyMinutes !== undefined) {
    const weeklyMinutes = tasks.reduce(
      (sum, task) => sum + (task.estimatedMinutes ?? 15) * taskWeeklyFrequency(task), 0,
    );
    if (weeklyMinutes > contract.maxWeeklyMinutes) {
      violations.push({
        code: 'WEEKLY_MINUTES_EXCEEDED',
        message: `The tasks total ${Math.round(weeklyMinutes)} minutes per week, above the user's ${contract.maxWeeklyMinutes}-minute capacity.`,
      });
    }
  }
  if (contract.deadline && draft.deadline !== contract.deadline) {
    violations.push({
      code: 'DEADLINE_MISMATCH',
      message: `The explicit deadline is ${contract.deadline}, not ${draft.deadline ?? 'null'}.`,
    });
  }
  if (contract.undefinedMetric && (draft.targetType === 'QUANTITY' || draft.targetType === 'WEEKLY_TARGET')) {
    violations.push({
      code: 'UNDEFINED_METRIC',
      message: 'The goal uses an undefined success metric; do not invent a numeric target. Ask for or use concrete evidence instead.',
    });
  }
  if (contract.prohibitConsecutiveEvenings && hasConsecutiveEvenings(tasks)) {
    violations.push({
      code: 'CONSECUTIVE_EVENINGS',
      message: 'The user prohibited sessions on consecutive evenings, but the fixed schedule places occurrences on adjacent days.',
    });
  }
  return violations;
}

/** The rejection text a DraftValidationError carries when the contract fails. */
export function describeContractViolations(violations: ContractViolation[]): string {
  return violations.map((violation) => violation.message).join(' ');
}
