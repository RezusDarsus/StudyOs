import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayInTimezone,
  daysBetween,
  eachDay,
  isDayString,
  isTimeString,
  minutesOfDay,
  startOfWeek,
  timeInTimezone,
  todayIn,
  weekdayOf,
} from './dates.js';
import {
  type TaskSchedule,
  occurrenceDays,
  occursOn,
  validateRecurrence,
} from './recurrence.js';
import {
  type ParticipantScoreInput,
  averageScore,
  computeStreak,
  dailyScore,
  goalProgress,
  rankLeaderboard,
  scoreForDay,
} from './scoring.js';

const schedule = (over: Partial<TaskSchedule>): TaskSchedule => ({
  recurrenceType: 'EVERY_DAY',
  recurrenceConfig: {},
  startDate: '2026-08-01',
  endDate: null,
  ...over,
});

describe('dates', () => {
  it('validates day strings', () => {
    expect(isDayString('2026-08-19')).toBe(true);
    expect(isDayString('2026-02-30')).toBe(false);
    expect(isDayString('2026-8-19')).toBe(false);
    expect(isDayString('nope')).toBe(false);
  });

  it('resolves the calendar day in a specific timezone', () => {
    // 2026-08-19T22:30Z is already the 20th in Tbilisi (UTC+4), still the 19th in UTC.
    const instant = new Date('2026-08-19T22:30:00Z');
    expect(dayInTimezone(instant, 'UTC')).toBe('2026-08-19');
    expect(dayInTimezone(instant, 'Asia/Tbilisi')).toBe('2026-08-20');
    expect(dayInTimezone(instant, 'America/Los_Angeles')).toBe('2026-08-19');
  });

  it('rolls the challenge day over at local midnight, not UTC midnight', () => {
    const justBefore = new Date('2026-08-19T19:59:00Z'); // 23:59 Tbilisi
    const justAfter = new Date('2026-08-19T20:01:00Z'); // 00:01 Tbilisi
    expect(todayIn('Asia/Tbilisi', justBefore)).toBe('2026-08-19');
    expect(todayIn('Asia/Tbilisi', justAfter)).toBe('2026-08-20');
  });

  it('survives a DST transition without shifting the date', () => {
    // US DST springs forward on 2026-03-08.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });

  it('does day arithmetic across month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-08-19', '2026-08-12')).toBe(-7);
    expect(eachDay('2026-08-19', '2026-08-21')).toEqual(['2026-08-19', '2026-08-20', '2026-08-21']);
    expect(eachDay('2026-08-21', '2026-08-19')).toEqual([]);
  });

  it('knows weekdays and Monday week starts', () => {
    expect(weekdayOf('2026-08-19')).toBe(3); // Wednesday
    expect(startOfWeek('2026-08-19')).toBe('2026-08-17'); // Monday
    expect(startOfWeek('2026-08-17')).toBe('2026-08-17');
    expect(startOfWeek('2026-08-23')).toBe('2026-08-17'); // Sunday belongs to that week
  });
});

describe('times of day', () => {
  it('validates HH:MM in 24-hour form', () => {
    expect(isTimeString('08:00')).toBe(true);
    expect(isTimeString('20:30')).toBe(true);
    expect(isTimeString('00:00')).toBe(true);
    expect(isTimeString('23:59')).toBe(true);
    // The shapes a hand-typed or hand-migrated value actually takes.
    expect(isTimeString('8:00')).toBe(false);
    expect(isTimeString('24:00')).toBe(false);
    expect(isTimeString('23:60')).toBe(false);
    expect(isTimeString('08:00:00')).toBe(false);
    expect(isTimeString('08:00 PM')).toBe(false);
    expect(isTimeString('')).toBe(false);
  });

  it('orders two times by minutes since midnight', () => {
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('08:00')).toBe(480);
    expect(minutesOfDay('20:30')).toBe(1230);
    expect(minutesOfDay('23:59')).toBe(1439);
    // Why this exists: "20:30" < "08:00" is false as a string compare, but the
    // scheduler needs to know the evening notification comes after the morning one.
    expect(minutesOfDay('20:30')).toBeGreaterThan(minutesOfDay('08:00'));
  });

  it('reads the wall clock in a specific timezone', () => {
    // 04:00 UTC is 08:00 in Tbilisi (UTC+4) — the morning notification's moment.
    const instant = new Date('2026-08-19T04:00:00Z');
    expect(timeInTimezone(instant, 'UTC')).toBe('04:00');
    expect(timeInTimezone(instant, 'Asia/Tbilisi')).toBe('08:00');
    expect(timeInTimezone(instant, 'Asia/Kolkata')).toBe('09:30'); // half-hour offset
  });

  it('reports local midnight as 00:00, never 24:00', () => {
    // The h23 hour cycle exists for exactly this: some runtimes render midnight as
    // hour 24 with hour12:false, and "24:00" compares wrong against every stored time.
    const midnightTbilisi = new Date('2026-08-19T20:00:00Z');
    expect(timeInTimezone(midnightTbilisi, 'Asia/Tbilisi')).toBe('00:00');
    expect(isTimeString(timeInTimezone(midnightTbilisi, 'Asia/Tbilisi'))).toBe(true);
  });

  it('reads the same instant as a different day and time either side of midnight', () => {
    // The pair a scheduled job compares: 20:05 UTC is already the 20th in Tbilisi.
    const instant = new Date('2026-08-19T20:05:00Z');
    expect(dayInTimezone(instant, 'UTC')).toBe('2026-08-19');
    expect(timeInTimezone(instant, 'UTC')).toBe('20:05');
    expect(dayInTimezone(instant, 'Asia/Tbilisi')).toBe('2026-08-20');
    expect(timeInTimezone(instant, 'Asia/Tbilisi')).toBe('00:05');
  });
});

describe('recurrence', () => {
  it('rejects malformed rules', () => {
    expect(() => validateRecurrence('SPECIFIC_WEEKDAYS', { weekdays: [] })).toThrow();
    expect(() => validateRecurrence('SPECIFIC_WEEKDAYS', { weekdays: [7] })).toThrow();
    expect(() => validateRecurrence('SPECIFIC_WEEKDAYS', { weekdays: [1, 1] })).toThrow();
    expect(() => validateRecurrence('TIMES_PER_WEEK', { timesPerWeek: 0 })).toThrow();
    expect(() => validateRecurrence('EVERY_X_DAYS', { intervalDays: 0 })).toThrow();
    expect(() => validateRecurrence('EVERY_DAY', {})).not.toThrow();
  });

  it('regenerates a daily task on every day in range', () => {
    const days = occurrenceDays(schedule({}), '2026-08-19', '2026-08-22');
    expect(days).toEqual(['2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22']);
  });

  it('puts a weekday task only on its weekdays', () => {
    // Mon / Wed / Fri
    const s = schedule({ recurrenceType: 'SPECIFIC_WEEKDAYS', recurrenceConfig: { weekdays: [1, 3, 5] } });
    const days = occurrenceDays(s, '2026-08-17', '2026-08-23'); // Mon..Sun
    expect(days).toEqual(['2026-08-17', '2026-08-19', '2026-08-21']);
    expect(occursOn(s, '2026-08-18')).toBe(false); // Tuesday
  });

  it('spaces an every-X-days task from its start date', () => {
    const s = schedule({
      recurrenceType: 'EVERY_X_DAYS',
      recurrenceConfig: { intervalDays: 2 },
      startDate: '2026-08-19',
    });
    expect(occurrenceDays(s, '2026-08-19', '2026-08-25')).toEqual([
      '2026-08-19',
      '2026-08-21',
      '2026-08-23',
      '2026-08-25',
    ]);
  });

  it('places a ONCE task on exactly one day', () => {
    const s = schedule({ recurrenceType: 'ONCE', startDate: '2026-08-20' });
    expect(occurrenceDays(s, '2026-08-19', '2026-08-25')).toEqual(['2026-08-20']);
  });

  it('honours start and end dates', () => {
    const s = schedule({ startDate: '2026-08-20', endDate: '2026-08-21' });
    expect(occurrenceDays(s, '2026-08-18', '2026-08-25')).toEqual(['2026-08-20', '2026-08-21']);
  });
});

// ------------------------------------------------------------------ scoring

const dailyTasks = (ids: string[]): ParticipantScoreInput['tasks'] =>
  ids.map((taskId) => ({ taskId, schedule: schedule({}) }));

describe('daily score', () => {
  it('scores 4 of 5 scheduled tasks as 80%', () => {
    const input: ParticipantScoreInput = {
      tasks: dailyTasks(['t1', 't2', 't3', 't4', 't5']),
      completions: ['t1', 't2', 't3', 't4'].map((taskId) => ({ taskId, day: '2026-08-19' })),
      from: '2026-08-19',
      to: '2026-08-19',
    };
    const score = dailyScore(input, '2026-08-19');
    expect(score.required).toBe(5);
    expect(score.completed).toBe(4);
    expect(score.percent).toBe(80);
  });

  it('reports null — not 0% — when nothing is scheduled', () => {
    const input: ParticipantScoreInput = {
      // Mon/Wed/Fri task, queried on a Tuesday.
      tasks: [
        {
          taskId: 't1',
          schedule: schedule({
            recurrenceType: 'SPECIFIC_WEEKDAYS',
            recurrenceConfig: { weekdays: [1, 3, 5] },
          }),
        },
      ],
      completions: [],
      from: '2026-08-18',
      to: '2026-08-18',
    };
    expect(dailyScore(input, '2026-08-18').percent).toBeNull();
  });
});

describe('average score', () => {
  it('averages finished days: 100, 80, 90 -> 90%', () => {
    // Ten daily tasks makes each day's percent easy to control.
    const tasks = dailyTasks(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    const completions: Array<{ taskId: string; day: string }> = [];
    const complete = (day: string, n: number) => {
      for (let i = 0; i < n; i++) completions.push({ taskId: tasks[i].taskId, day });
    };
    complete('2026-08-16', 10); // 100%
    complete('2026-08-17', 8); // 80%
    complete('2026-08-18', 9); // 90%

    const input: ParticipantScoreInput = {
      tasks,
      completions,
      from: '2026-08-16',
      to: '2026-08-19',
    };
    const avg = averageScore(input, '2026-08-19'); // today = the 19th
    expect(avg.countedDays).toBe(3);
    expect(avg.percent).toBe(90);
  });

  it('excludes today, pre-join days, no-task days and future days', () => {
    // Joined 2026-08-10. Aug 11 has nothing scheduled. Today is Aug 14.
    const everyDay = { taskId: 'daily', schedule: schedule({ startDate: '2026-08-01' }) };
    const notOnThe11th = {
      taskId: 'weekday',
      schedule: schedule({
        recurrenceType: 'SPECIFIC_WEEKDAYS',
        // Aug 11 2026 is a Tuesday (2) — deliberately excluded.
        recurrenceConfig: { weekdays: [1, 3, 4, 5] },
        startDate: '2026-08-01',
      }),
    };

    const input: ParticipantScoreInput = {
      tasks: [everyDay, notOnThe11th],
      completions: [
        // Before joining — must not count, and must not appear as 0%.
        { taskId: 'daily', day: '2026-08-05' },
        { taskId: 'daily', day: '2026-08-10' },
        { taskId: 'weekday', day: '2026-08-10' }, // Aug 10 = Monday -> 100%
        { taskId: 'daily', day: '2026-08-11' }, // only task scheduled -> 100%
        { taskId: 'daily', day: '2026-08-12' }, // 1 of 2 -> 50%
        { taskId: 'daily', day: '2026-08-13' },
        { taskId: 'weekday', day: '2026-08-13' }, // 100%
        { taskId: 'daily', day: '2026-08-14' }, // today — excluded from average
      ],
      from: '2026-08-10', // join day
      to: '2026-08-14',
    };

    const avg = averageScore(input, '2026-08-14');
    // Aug 10 (100) + Aug 11 (100) + Aug 12 (50) + Aug 13 (100) = 350 / 4
    expect(avg.countedDays).toBe(4);
    expect(avg.percent).toBe(87.5);
  });

  it('matches the worked example from the spec', () => {
    // Aug 10 -> 100%, Aug 11 -> no scheduled tasks, Aug 12 -> 50%, Aug 13 -> 100%
    const a = { taskId: 'a', schedule: schedule({ startDate: '2026-08-10' }) };
    const b = {
      taskId: 'b',
      schedule: schedule({
        recurrenceType: 'SPECIFIC_WEEKDAYS',
        recurrenceConfig: { weekdays: [1, 3, 4] }, // Mon, Wed, Thu — not Tue the 11th
        startDate: '2026-08-10',
      }),
    };
    const input: ParticipantScoreInput = {
      tasks: [a, b],
      completions: [
        { taskId: 'a', day: '2026-08-10' },
        { taskId: 'b', day: '2026-08-10' }, // 100%
        // Aug 11: 'a' scheduled but skipped -> that is 0%, so drop 'a' from the day
        { taskId: 'a', day: '2026-08-12' }, // 1 of 2 -> 50%
        { taskId: 'a', day: '2026-08-13' },
        { taskId: 'b', day: '2026-08-13' }, // 100%
      ],
      from: '2026-08-10',
      to: '2026-08-14',
    };
    const avg = averageScore(input, '2026-08-14');
    // Aug 11 counts as 0% here because 'a' is scheduled daily and was missed.
    expect(avg.countedDays).toBe(4);
    expect(avg.percent).toBe(62.5);
  });

  it('has no average before the first day finishes', () => {
    const input: ParticipantScoreInput = {
      tasks: dailyTasks(['t1']),
      completions: [],
      from: '2026-08-19',
      to: '2026-08-19',
    };
    expect(averageScore(input, '2026-08-19')).toEqual({ percent: null, countedDays: 0 });
  });
});

describe('times per week', () => {
  const s = schedule({
    recurrenceType: 'TIMES_PER_WEEK',
    recurrenceConfig: { timesPerWeek: 3 },
    startDate: '2026-08-17', // Monday
  });

  it('does not demand the task early in the week', () => {
    const input: ParticipantScoreInput = {
      tasks: [{ taskId: 'gym', schedule: s }],
      completions: [],
      from: '2026-08-17',
      to: '2026-08-23',
    };
    // Monday: 6 days still available for a quota of 3 -> not yet required.
    expect(scoreForDay(input, '2026-08-17').percent).toBeNull();
  });

  it('requires the task once the remaining days only just cover the quota', () => {
    const input: ParticipantScoreInput = {
      tasks: [{ taskId: 'gym', schedule: s }],
      completions: [],
      from: '2026-08-17',
      to: '2026-08-23',
    };
    // Friday 21st: Fri/Sat/Sun left = 3 days for a quota of 3 -> required.
    const friday = scoreForDay(input, '2026-08-21');
    expect(friday.required).toBe(1);
    expect(friday.completed).toBe(0);
  });

  it('stops requiring the task once the weekly quota is met', () => {
    const input: ParticipantScoreInput = {
      tasks: [{ taskId: 'gym', schedule: s }],
      completions: [
        { taskId: 'gym', day: '2026-08-17' },
        { taskId: 'gym', day: '2026-08-18' },
        { taskId: 'gym', day: '2026-08-19' },
      ],
      from: '2026-08-17',
      to: '2026-08-23',
    };
    // Quota already satisfied — the rest of the week is free.
    expect(scoreForDay(input, '2026-08-22').percent).toBeNull();
    // And the days they did go count as completed.
    expect(scoreForDay(input, '2026-08-17')).toMatchObject({
      required: 1,
      completed: 1,
      percent: 100,
    });
  });
});

describe('streaks', () => {
  const mwf = schedule({
    recurrenceType: 'SPECIFIC_WEEKDAYS',
    recurrenceConfig: { weekdays: [1, 3, 5] }, // Mon/Wed/Fri
    startDate: '2026-08-03',
  });

  it('does not break on a day with nothing scheduled', () => {
    const input: ParticipantScoreInput = {
      tasks: [{ taskId: 'gym', schedule: mwf }],
      completions: [
        { taskId: 'gym', day: '2026-08-17' }, // Mon
        { taskId: 'gym', day: '2026-08-19' }, // Wed
        { taskId: 'gym', day: '2026-08-21' }, // Fri
      ],
      from: '2026-08-17',
      to: '2026-08-21',
    };
    // Tuesday and Thursday are rest days — they must not count as failures.
    expect(computeStreak(input, '2026-08-21')).toEqual({ current: 3, best: 3 });
  });

  it('breaks on a missed scheduled day', () => {
    const input: ParticipantScoreInput = {
      tasks: [{ taskId: 'gym', schedule: mwf }],
      completions: [
        { taskId: 'gym', day: '2026-08-17' },
        // Wed 19th missed
        { taskId: 'gym', day: '2026-08-21' },
      ],
      from: '2026-08-17',
      to: '2026-08-21',
    };
    expect(computeStreak(input, '2026-08-21')).toEqual({ current: 1, best: 1 });
  });

  it('does not let an unfinished today break the streak', () => {
    const input: ParticipantScoreInput = {
      tasks: dailyTasks(['t1']),
      completions: [
        { taskId: 't1', day: '2026-08-17' },
        { taskId: 't1', day: '2026-08-18' },
        // today (19th) not done yet
      ],
      from: '2026-08-17',
      to: '2026-08-19',
    };
    expect(computeStreak(input, '2026-08-19').current).toBe(2);
  });
});

describe('goal progress', () => {
  it('counts completed eligible occurrences over total eligible occurrences', () => {
    const input: ParticipantScoreInput = {
      tasks: dailyTasks(['t1', 't2']),
      completions: [
        { taskId: 't1', day: '2026-08-17' },
        { taskId: 't2', day: '2026-08-17' },
        { taskId: 't1', day: '2026-08-18' },
      ],
      from: '2026-08-17',
      to: '2026-08-18',
    };
    expect(goalProgress(input, '2026-08-18')).toEqual({
      completedOccurrences: 3,
      totalOccurrences: 4,
      percent: 75,
    });
  });

  it('never counts future days against a participant', () => {
    const input: ParticipantScoreInput = {
      tasks: dailyTasks(['t1']),
      completions: [{ taskId: 't1', day: '2026-08-17' }],
      from: '2026-08-17',
      to: '2026-08-31',
    };
    expect(goalProgress(input, '2026-08-17').percent).toBe(100);
  });
});

describe('leaderboard ranking', () => {
  const entry = (over: Partial<Parameters<typeof rankLeaderboard>[0][number]>) => ({
    participantId: 'p',
    userId: 'u',
    name: 'X',
    avatarEmoji: '🙂',
    percent: 0,
    completed: 0,
    required: 0,
    currentStreak: 0,
    totalCompleted: 0,
    ...over,
  });

  it('orders by percent, highest first', () => {
    const ranked = rankLeaderboard([
      entry({ participantId: 'b', name: 'Rezo', percent: 80 }),
      entry({ participantId: 'a', name: 'Alex', percent: 100 }),
      entry({ participantId: 'c', name: 'Maria', percent: 60 }),
    ]);
    expect(ranked.map((r) => r.name)).toEqual(['Alex', 'Rezo', 'Maria']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('breaks ties on streak, then completed, then id — stable across refreshes', () => {
    const build = () => [
      entry({ participantId: 'p2', name: 'Second', percent: 90, currentStreak: 5, totalCompleted: 20 }),
      entry({ participantId: 'p1', name: 'First', percent: 90, currentStreak: 9, totalCompleted: 4 }),
      entry({ participantId: 'p3', name: 'Third', percent: 90, currentStreak: 5, totalCompleted: 11 }),
    ];
    const first = rankLeaderboard(build()).map((r) => r.name);
    const second = rankLeaderboard(build().reverse()).map((r) => r.name);
    expect(first).toEqual(['First', 'Second', 'Third']);
    expect(second).toEqual(first);
  });

  it('sorts participants with nothing scheduled last', () => {
    const ranked = rankLeaderboard([
      entry({ participantId: 'a', name: 'Idle', percent: null }),
      entry({ participantId: 'b', name: 'Busy', percent: 10 }),
    ]);
    expect(ranked.map((r) => r.name)).toEqual(['Busy', 'Idle']);
  });
});
