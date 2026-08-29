import { describe, expect, it } from 'vitest';
import { buildConstraintContract, checkContract } from './constraint-contract.js';
import { parseExplicitGoalConstraints } from './goal-constraints.js';
import type { ExplicitGoalConstraints } from './goal-constraints.js';
import type { ConstraintContract, ContractTask } from './constraint-contract.js';

const constraints = (overrides: Partial<ExplicitGoalConstraints> = {}): ExplicitGoalConstraints => ({
  excludedDays: [], forbiddenActivities: [], requiredWeeklyRoles: [], requiredRoleDays: [],
  undefinedMetric: false, requiresClarification: false, prohibitConsecutiveEvenings: false,
  ...overrides,
});

const task = (title: string, weekdays: number[]): ContractTask => ({
  title, description: '', recurrenceType: 'SPECIFIC_WEEKDAYS', recurrenceConfig: { weekdays },
  estimatedMinutes: 45, progression: null,
});

const codes = (contract: ConstraintContract, tasks: ContractTask[]): string[] =>
  checkContract(contract, { targetType: 'HABIT', targetValue: null, deadline: null, tasks })
    .map((violation) => violation.code);

describe('constraint contract', () => {
  it('builds a serializable contract with canonical weekday order', () => {
    const contract = buildConstraintContract(constraints({
      exactWeekly: 3,
      allowedDays: [6, 0, 2],
      excludedDays: [5],
      requiredRoleDays: [{ role: 'TRAIL', days: [6] }],
    }), { excludedMonths: ['2026-12'] });
    // Monday-first canonical order, regardless of extraction order.
    expect(contract.allowedWeekdays).toEqual([2, 6, 0]);
    expect(contract.excludedWeekdays).toEqual([5]);
    expect(contract.requiredWeekdays).toEqual([6]);
    expect(contract.cadence).toBe('FIXED');
    expect(contract.totalWeeklyOccurrences).toBe(3);
    expect(contract.excludedMonths).toEqual(['2026-12']);
    expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
  });

  it('classifies a count-plus-day-pool goal as flexible cadence', () => {
    const contract = buildConstraintContract(constraints({ exactWeekly: 3, allowedDays: [1, 3, 5] }));
    expect(contract.cadence).toBe('FLEXIBLE');
    expect(buildConstraintContract(constraints()).cadence).toBe('UNSPECIFIED');
  });

  it('is independent of clause order in the source text', () => {
    const first = parseExplicitGoalConstraints(
      'Run on Tuesday and Thursday for 30 minutes and do strength training every Saturday.', '2026-08-25',
    );
    const second = parseExplicitGoalConstraints(
      'Do strength training every Saturday and run on Tuesday and Thursday for 30 minutes.', '2026-08-25',
    );
    expect(buildConstraintContract(first)).toEqual(buildConstraintContract(second));
  });

  it('catches each weekly-total violation class', () => {
    expect(codes(buildConstraintContract(constraints({ exactWeekly: 3 })), [task('Walk', [1])]))
      .toContain('EXACT_WEEKLY_MISMATCH');
    expect(codes(buildConstraintContract(constraints({ maxWeekly: 2 })), [task('Walk', [1, 3, 5])]))
      .toContain('MAX_WEEKLY_EXCEEDED');
  });

  it('catches required and role weekdays, excluded and outside-allowed days', () => {
    const contract = buildConstraintContract(constraints({
      allowedDays: [1, 3, 6],
      excludedDays: [5],
      requiredRoleDays: [{ role: 'TRAIL', days: [6] }],
    }));
    const violationCodes = codes(contract, [task('Trail run', [1])]);
    expect(violationCodes).toContain('REQUIRED_WEEKDAY_MISSING');
    expect(violationCodes).toContain('ROLE_WEEKDAY_MISSING');
    expect(codes(contract, [task('Trail run', [6, 5])])).toContain('EXCLUDED_WEEKDAY_USED');
    expect(codes(contract, [task('Trail run', [6, 2])])).toContain('ALLOWED_WEEKDAY_EXCEEDED');
    expect(codes(contract, [task('Trail run', [6, 1, 3])])).toEqual([]);
  });

  it('catches role weekly minimums', () => {
    const contract = buildConstraintContract(constraints({
      requiredWeeklyRoles: [{ role: 'STRENGTH', minOccurrences: 1 }],
    }));
    expect(codes(contract, [task('Long run', [1])])).toContain('ROLE_WEEKLY_MINIMUM');
    expect(codes(contract, [task('Strength session', [1])])).not.toContain('ROLE_WEEKLY_MINIMUM');
  });

  it('catches a flexible cadence that lost its allowed-weekday boundary', () => {
    const contract = buildConstraintContract(constraints({ exactWeekly: 2, allowedDays: [1, 3], excludedDays: [5] }));
    const flexible: ContractTask = {
      title: 'Train', description: '', recurrenceType: 'TIMES_PER_WEEK',
      recurrenceConfig: { timesPerWeek: 2 }, estimatedMinutes: 30, progression: null,
    };
    expect(codes(contract, [flexible])).toContain('FLEXIBLE_BOUNDARY_LOST');
    expect(codes(contract, [{
      ...flexible,
      recurrenceConfig: { timesPerWeek: 2, allowedWeekdays: [1, 3], excludedWeekdays: [5] },
    }])).toEqual([]);
  });

  it('catches a monthly task that lost its stated day of month', () => {
    const contract = buildConstraintContract(constraints({ calendarFrequency: { intervalMonths: 1, dayOfMonth: 1 } }));
    const monthly = (dayOfMonth?: number | 'LAST'): ContractTask => ({
      title: 'Transfer rent', description: '', recurrenceType: 'MONTHLY',
      recurrenceConfig: dayOfMonth === undefined ? {} : { dayOfMonth }, estimatedMinutes: 15, progression: null,
    });
    expect(codes(contract, [monthly()])).toContain('MONTHLY_CADENCE_BROKEN');
    expect(codes(contract, [monthly(15)])).toContain('MONTHLY_CADENCE_BROKEN');
    expect(codes(contract, [monthly(1)])).toEqual([]);
    const interval = buildConstraintContract(constraints({ calendarFrequency: { intervalMonths: 3, dayOfMonth: 15 } }));
    expect(codes(interval, [{
      title: 'Review', description: '', recurrenceType: 'EVERY_X_MONTHS',
      recurrenceConfig: { intervalMonths: 2, dayOfMonth: 15 }, estimatedMinutes: 15, progression: null,
    }])).toContain('MONTHLY_CADENCE_BROKEN');
    expect(codes(interval, [{
      title: 'Review', description: '', recurrenceType: 'EVERY_X_MONTHS',
      recurrenceConfig: { intervalMonths: 3, dayOfMonth: 15 }, estimatedMinutes: 15, progression: null,
    }])).toEqual([]);
  });

  it('catches a finance transfer that dodges the stated monthly cadence', () => {
    const contract = buildConstraintContract(constraints({ calendarFrequency: { intervalMonths: 1 } }));
    expect(codes(contract, [{ ...task('Save €200', [1]), recurrenceType: 'MONTHLY', recurrenceConfig: {} }]))
      .toEqual([]);
    expect(codes(contract, [task('Save €200 weekly', [1])])).toContain('MONTHLY_CADENCE_BROKEN');
  });

  it('catches dropped skipped months and missing bounded monthly phases', () => {
    const contract = buildConstraintContract(constraints({ calendarFrequency: { intervalMonths: 1 } }), {
      excludedMonths: ['2026-12'],
      monthlyPhases: [{ activeFrom: '2026-09-01', activeUntil: '2026-11-30', amount: 650, currency: 'EUR' }],
    });
    const transfer: ContractTask = {
      title: 'Monthly contribution €650', description: 'Contribute €650 per month from 2026-09-01 through 2026-11-30.',
      recurrenceType: 'MONTHLY',
      recurrenceConfig: { dayOfMonth: 1, activeFrom: '2026-09-01', activeUntil: '2026-11-30', excludedMonths: ['2026-12'] },
      estimatedMinutes: 15, progression: null,
    };
    expect(codes(contract, [transfer])).toEqual([]);
    expect(codes(contract, [{ ...transfer, recurrenceConfig: { dayOfMonth: 1, activeFrom: '2026-09-01', activeUntil: '2026-11-30' } }]))
      .toContain('EXCLUDED_MONTH_DROPPED');
    expect(codes(contract, [{ ...transfer, recurrenceConfig: { dayOfMonth: 1, excludedMonths: ['2026-12'] } }]))
      .toContain('MONTHLY_PHASE_MISSING');
  });

  it('catches money caps and per-session and weekly minute capacity', () => {
    expect(codes(buildConstraintContract(constraints({ monthlyMoneyCap: 450 })), [task('Save €500', [1])]))
      .toContain('MONEY_CAP_EXCEEDED');
    expect(codes(buildConstraintContract(constraints({ maxMinutes: 45 })), [task('Walk', [1])]))
      .toEqual([]);
    expect(codes(buildConstraintContract(constraints({ maxMinutes: 45 })), [{ ...task('Walk', [1]), estimatedMinutes: 60 }]))
      .toContain('SESSION_MINUTES_EXCEEDED');
    expect(codes(buildConstraintContract(constraints({ maxWeeklyMinutes: 300 })), [task('Walk', [1, 2, 3, 4, 5, 6, 0])]))
      .toContain('WEEKLY_MINUTES_EXCEEDED');
    expect(codes(buildConstraintContract(constraints({ maxWeeklyMinutes: 300 })), [task('Walk', [1, 2, 3])]))
      .toEqual([]);
  });

  it('catches deadline drift and invented numeric targets', () => {
    const contract = buildConstraintContract(constraints({ deadline: '2026-10-31', undefinedMetric: true }));
    expect(checkContract(contract, { targetType: 'HABIT', targetValue: null, deadline: '2026-11-30', tasks: [task('Walk', [1])] })
      .map((violation) => violation.code)).toContain('DEADLINE_MISMATCH');
    expect(checkContract(contract, { targetType: 'QUANTITY', targetValue: 95, deadline: '2026-10-31', tasks: [task('Walk', [1])] })
      .map((violation) => violation.code)).toContain('UNDEFINED_METRIC');
  });

  it('catches consecutive-evening scheduling', () => {
    const contract = buildConstraintContract(constraints({ prohibitConsecutiveEvenings: true }));
    expect(codes(contract, [task('Monday run', [1]), task('Tuesday run', [2])]))
      .toContain('CONSECUTIVE_EVENINGS');
    expect(codes(contract, [task('Monday run', [1]), task('Wednesday run', [3])]))
      .toEqual([]);
  });

  it('catches schedules of explicitly forbidden activities', () => {
    const contract = buildConstraintContract(constraints({ forbiddenActivities: ['running'] }));
    expect(codes(contract, [task('Tempo running block', [1])])).toContain('FORBIDDEN_ACTIVITY');
    expect(codes(contract, [task('Walk instead of running', [1])])).toEqual([]);
  });

  it('writes actionable rejection text', () => {
    const contract = buildConstraintContract(constraints({ exactWeekly: 3 }));
    const [violation] = checkContract(contract, { targetType: 'HABIT', targetValue: null, deadline: null, tasks: [task('Walk', [1])] });
    expect(violation.message).toMatch(/exactly 3 total sessions per week/);
  });
});
