import { describe, expect, it } from 'vitest';
import { explicitConstraintErrors, extractEvidenceRequirements, goalCoverageGaps, parseExplicitGoalConstraints, statedDayOfMonth } from './goal-constraints.js';
import type { NormalizedTask } from './draft-validator.js';

const task = (title:string, weekdays:number[], minutes=45):NormalizedTask => ({
  title, description:'', recurrenceType:'SPECIFIC_WEEKDAYS', recurrenceConfig:{weekdays},
  estimatedMinutes:minutes, preferredTime:null, reason:'', reward:20, progression:null,
});
const draft = (tasks:NormalizedTask[], deadline:string|null=null) => ({ targetType:'HABIT',targetValue:null,deadline,tasks });
const textTask = (title:string, description='', reason=''):Array<Pick<NormalizedTask,'title'|'description'|'reason'>> => [{ title, description, reason }];

describe('explicit goal constraints',()=>{
  it('extracts reusable evidence clauses from proof and outcome language',()=>{
    expect(extractEvidenceRequirements('The outcome must be demonstrated by a batch pipeline, one streaming prototype, tested transformations, and architecture notes.')).toEqual(['batch pipeline','streaming prototype','tested transformations','architecture notes']);
    expect(extractEvidenceRequirements('Improve until I can present for 15 minutes, answer five minutes of questions, and receive ratings from reviewers.')).toEqual(['present for 15 minutes','answer five minutes of questions','receive ratings from reviewers']);
  });
  it('uses the application weekday convention and aggregates separate tasks',()=>{
    const c=parseExplicitGoalConstraints('Train exactly twice per week. I can only on Tuesday, Thursday, or Sunday.','2026-08-25');
    expect(c.allowedDays).toEqual([2,4,0]);
    expect(explicitConstraintErrors(c,draft([task('Tuesday',[2]),task('Sunday',[0])]))).toEqual([]);
    expect(explicitConstraintErrors(c,draft([task('Both',[2,4]),task('Duplicate',[2,4])]))[0]).toMatch(/total 4/);
  });

  it('rejects excluded weekdays and a per-session cap',()=>{
    const c=parseExplicitGoalConstraints('At most three sessions per week. Wednesday is unavailable. Each session must be 45 minutes or less.','2026-08-25');
    const errors=explicitConstraintErrors(c,draft([task('Bad',[3],60)]));
    expect(errors.join(' ')).toMatch(/excluded/);
    expect(errors.join(' ')).toMatch(/45-minute/);
  });

  it('turns before a month into the previous month end',()=>{
    const c=parseExplicitGoalConstraints('Finish before November 2026.','2026-08-25');
    expect(c.deadline).toBe('2026-10-31');
    expect(explicitConstraintErrors(c,draft([task('Review',[0])],'2026-11-30'))[0]).toMatch(/2026-10-31/);
  });

  it('rejects contributions over a monthly cap',()=>{
    const c=parseExplicitGoalConstraints('I cannot contribute more than €450 per month.','2026-08-25');
    expect(explicitConstraintErrors(c,draft([{...task('Save €500',[6]),description:'Transfer €500 monthly'}]))[0]).toMatch(/450/);
  });

  it('does not flatten a variable monthly cap schedule into one global cap',()=>{
    const c=parseExplicitGoalConstraints('At most €650 per month from September through November, €300 in December and January, and €700 per month from February onward.','2026-08-25');
    expect(c.monthlyMoneyCap).toBeUndefined();
  });

  it('does not permit an invented number for an undefined metric',()=>{
    const c=parseExplicitGoalConstraints('Make me 95% more productive in 30 days.','2026-08-25');
    expect(c.requiresClarification).toBe(true);
    expect(explicitConstraintErrors(c,{...draft([task('Focus',[1])]),targetType:'QUANTITY',targetValue:95})[0]).toMatch(/undefined/);
  });

  it('recognizes named-only days and every-week contradictions',()=>{
    const c=parseExplicitGoalConstraints(
      'I need three different days every week. Monday and Wednesday are the only days possible.',
      '2026-08-25',
    );
    expect(c.allowedDays).toEqual([1,3]);
    expect(c.requiresClarification).toBe(true);
    expect(explicitConstraintErrors(c,draft([task('Train',[1,3])]))[0]).toMatch(/clarification/);
  });

  it('maps every Saturday to the application weekday convention',()=>{
    const c=parseExplicitGoalConstraints('Study every Saturday.','2026-08-25');
    expect(c.allowedDays).toEqual([6]);
  });

  it('constrains a named weekday to its weekday without inventing a plan total',()=>{
    const c=parseExplicitGoalConstraints('Water plants every Saturday morning.','2026-08-25');
    // "every Saturday" says which day may be used, not how many weekly sessions
    // the whole plan gets — a named-weekday statement never synthesizes a
    // global exactWeekly (that mis-parse used to clobber mixed schedules).
    expect(c.exactWeekly).toBeUndefined();
    expect(c.allowedDays).toEqual([6]);
  });

  it('does not set exactWeekly from a named weekday while still parsing weekly plan totals',()=>{
    expect(parseExplicitGoalConstraints('I need two exercise sessions every week.','2026-08-25').exactWeekly).toBe(2);
    expect(parseExplicitGoalConstraints('I need exactly three total sessions weekly.','2026-08-25').exactWeekly).toBe(3);
    expect(parseExplicitGoalConstraints('Schedule three 50-minute deep-work blocks on weekday mornings.','2026-08-25').exactWeekly).toBe(3);
  });

  it('recognizes weekdays listed before possible-days wording',()=>{
    const c=parseExplicitGoalConstraints(
      'Train twice per week. Tuesday, Thursday, and Saturday are all possible days.',
      '2026-08-25',
    );
    expect(c.allowedDays).toEqual([2,4,6]);
  });

  it('infers aggregate frequency from fixed named sessions',()=>{
    const c=parseExplicitGoalConstraints(
      'Attend fixed classes Monday and Wednesday, and do one homework session on Saturday.',
      '2026-08-25',
    );
    expect(c.exactWeekly).toBe(3);
    expect(c.allowedDays).toEqual([1,3,6]);
  });

  it('lets an explicit conflict resolution override the opening frequency',()=>{
    const c=parseExplicitGoalConstraints(
      'Exercise three different days every week. Monday and Wednesday are the only days. Reduce the frequency to two days.',
      '2026-08-25',
    );
    expect(c.exactWeekly).toBe(2);
    expect(c.requiresClarification).toBe(false);
  });

  it('treats a literal frequency answer as higher authority than an add-one recommendation',()=>{
    const c=parseExplicitGoalConstraints(
      'Accept adding one weekly coding session.\n{"frequency":{"question":"How many days per week for coding practice?","answer":4}}',
      '2026-08-25',
    );
    expect(c.exactWeekly).toBe(4);
  });

  it('caps recurring work at the stated number of blocks',()=>{
    const c=parseExplicitGoalConstraints(
      'I can study six hours per week, usually in three blocks, but never on consecutive evenings.',
      '2026-08-25',
    );
    expect(c.maxWeekly).toBe(3);
  });

  it('extracts calendar-month recurrence without accepting a weekday answer as weekly intent',()=>{
    const c=parseExplicitGoalConstraints(
      'Set aside 700 GEL monthly.\n{"days_per_week":{"question":"Which day?","answer":1}}',
      '2026-08-25',
    );
    expect(c.calendarFrequency).toEqual({intervalMonths:1});
    expect(c.exactWeekly).toBeUndefined();
  });

  it('does not infer monthly recurrence from an irrelevant interview question',()=>{
    const c=parseExplicitGoalConstraints(
      'Call my parents every Sunday afternoon for the next three months.\n{"sundays_per_month":{"question":"How many Sundays per month?","answer":"1 Sunday"}}',
      '2026-08-25',
    );
    expect(c.calendarFrequency).toBeUndefined();
    // "every Sunday" constrains the day only; it is not a plan-total statement.
    expect(c.exactWeekly).toBeUndefined();
    expect(c.allowedDays).toEqual([0]);
  });

  it('extracts role/day and recovery-policy constraints',()=>{
    const c=parseExplicitGoalConstraints(
      'Exactly three sessions weekly including Saturday trail practice and one strength session. Progress only after two pain-free weeks, reduce after repeated pain, pause for sharp pain, and require approval.',
      '2026-08-25',
    );
    expect(c.requiredWeeklyRoles).toEqual([{role:'STRENGTH',minOccurrences:1}]);
    expect(c.requiredRoleDays).toEqual([{role:'TRAIL',days:[6]}]);
    expect(c.progressionPolicy).toEqual({painFreeWeeks:2,reduceOnRepeatedPain:true,pauseOnSharpPain:true,approvalRequired:true});
  });

  // --- class regressions from the frozen-100 baseline (no case specifics) ---

  it('does not clobber a mixed schedule when one activity names a weekday',()=>{
    // A named-weekday statement constrains that activity's day; it must not
    // synthesize a global "exactly 1 per week" that rewrites every other task.
    const c=parseExplicitGoalConstraints(
      'I train every Saturday and want to get stronger with two home sessions.',
      '2026-08-25',
    );
    expect(c.allowedDays).toEqual([6]);
    expect(c.exactWeekly).toBeUndefined();
  });

  it('unions weekday lists from on-statements and every-statements',()=>{
    const c=parseExplicitGoalConstraints(
      'Run on Tuesday and Thursday for 30 minutes and do strength training every Saturday.',
      '2026-08-25',
    );
    expect(c.allowedDays).toEqual([2,4,6]);
    expect(c.exactWeekly).toBeUndefined();
  });

  it('orders allowed days canonically regardless of clause order',()=>{
    // The same days named in the opposite order must produce the same set:
    // clause processing order never leaks into the result.
    const reversed=parseExplicitGoalConstraints(
      'Do strength training every Saturday and run on Tuesday and Thursday for 30 minutes.',
      '2026-08-25',
    );
    expect(reversed.allowedDays).toEqual([2,4,6]);
    // Canonical order is Monday-first with Sunday last, per the application
    // convention — a plain 0-6 sort would wrongly put Sunday first.
    expect(parseExplicitGoalConstraints('Run on Sunday and Monday.','2026-08-25').allowedDays).toEqual([1,0]);
  });

  it('applies a recorded conflict-resolution answer after every other clause',()=>{
    // The answer is user authority recorded last, so it must widen an
    // already-extracted "only days" set rather than be clobbered by it.
    const added=parseExplicitGoalConstraints(
      'Monday and Wednesday are the only days.\n{"resolve_frequency_conflict":{"question":"...or make another weekday available?","answer":"Add Saturday as an available day"}}',
      '2026-08-25',
    );
    expect(added.allowedDays).toEqual([1,3,6]);
    // The answer keeps widening even when the opening statement names its own days.
    const widened=parseExplicitGoalConstraints(
      'Exercise three days per week. Monday and Wednesday are the only days.\n{"resolve_frequency_conflict":{"question":"...or make another weekday available?","answer":"Make Friday available"}}',
      '2026-08-25',
    );
    expect(widened.allowedDays).toEqual([1,3,5]);
    expect(widened.exactWeekly).toBe(3);
  });

  it('extracts explicitly forbidden activities',()=>{
    const c=parseExplicitGoalConstraints('No alcohol and never run. Train on Tuesday and Thursday without a defined baseline.','2026-08-25');
    expect(c.forbiddenActivities).toEqual(['alcohol','run']);
    expect(parseExplicitGoalConstraints('Walk daily without a defined baseline.','2026-08-25').forbiddenActivities).toEqual([]);
  });

  it('reports the stated day of month through the shared helper',()=>{
    expect(statedDayOfMonth('Pay rent on the 1st')).toBe(1);
    expect(statedDayOfMonth('Save on the first day of every month')).toBe(1);
    expect(statedDayOfMonth('Review on the fifteenth of each month')).toBe(15);
    expect(statedDayOfMonth('Transfer on day 10 of each month')).toBe(10);
    expect(statedDayOfMonth('Pay at the end of each month')).toBe('LAST');
    // An ordinal followed by a month name is a date, not a monthly day.
    expect(statedDayOfMonth('Start on the 3rd of March')).toBeUndefined();
    expect(statedDayOfMonth('Walk daily')).toBeUndefined();
  });

  it('reads "every weekday" as the five weekday plan total',()=>{
    expect(parseExplicitGoalConstraints('Read 20 pages every weekday evening.','2026-08-25').exactWeekly).toBe(5);
  });

  it('reads a daily statement without named weekdays as every-day frequency',()=>{
    expect(parseExplicitGoalConstraints('Meditate for 10 minutes every morning for 30 days.','2026-08-25').exactWeekly).toBe(7);
    expect(parseExplicitGoalConstraints('Walk daily.','2026-08-25').exactWeekly).toBe(7);
    expect(parseExplicitGoalConstraints('Water the plants every other day.','2026-08-25').exactWeekly).toBeUndefined();
  });

  it('parses only-allowed-days phrasings in both word orders',()=>{
    expect(parseExplicitGoalConstraints('I need three workout days, but Monday and Wednesday are the only allowed days.','2026-08-25').allowedDays).toEqual([1,3]);
    expect(parseExplicitGoalConstraints('Study after dinner, but Tuesday and Thursday are the only days available.','2026-08-25').allowedDays).toEqual([2,4]);
    expect(parseExplicitGoalConstraints('The only allowed days are Monday and Wednesday.','2026-08-25').allowedDays).toEqual([1,3]);
  });

  it('flags a requested day count that cannot fit the named days',()=>{
    const c=parseExplicitGoalConstraints(
      'I need three different workout days, but Monday and Wednesday are the only allowed days.',
      '2026-08-25',
    );
    expect(c.exactWeekly).toBe(3);
    expect(c.allowedDays).toEqual([1,3]);
    expect(c.requiresClarification).toBe(true);
  });

  it('parses word-ordinal and bare-ordinal calendar-month days',()=>{
    expect(parseExplicitGoalConstraints('Save €300 on the first day of every month.','2026-08-25').calendarFrequency).toEqual({intervalMonths:1,dayOfMonth:1});
    expect(parseExplicitGoalConstraints('Transfer 500 GEL monthly on the 1st, starting September 2026.','2026-08-25').calendarFrequency).toEqual({intervalMonths:1,dayOfMonth:1});
    expect(parseExplicitGoalConstraints('Review the budget on the fifteenth of each month.','2026-08-25').calendarFrequency).toEqual({intervalMonths:1,dayOfMonth:15});
    // An ordinal followed by a month name is a date, not a monthly day.
    expect(parseExplicitGoalConstraints('Save money monthly; start on the 3rd of March.','2026-08-25').calendarFrequency).toEqual({intervalMonths:1});
  });

  it('lets a recorded conflict-resolution answer free up another weekday',()=>{
    const c=parseExplicitGoalConstraints(
      'Exercise three days per week. Monday and Wednesday are the only days.\n{"resolve_frequency_conflict":{"question":"...or make another weekday available?","answer":"Make Friday available"}}',
      '2026-08-25',
    );
    expect(c.allowedDays).toEqual([1,3,5]);
  });

  it('lets a recorded conflict-resolution answer reduce the requested frequency',()=>{
    const c=parseExplicitGoalConstraints(
      'Exercise three days per week. Monday and Wednesday are the only days.\n{"resolve_frequency_conflict":{"question":"Would you like to reduce...","answer":"Reduce to two days"}}',
      '2026-08-25',
    );
    expect(c.exactWeekly).toBe(2);
    expect(c.requiresClarification).toBe(false);
  });

  it('sums coordinated per-activity frequencies into one plan total',()=>{
    // Two activity-frequency clauses are separate commitments summing to the
    // week's total; first-match-wins used to read this whole week as 2.
    const c=parseExplicitGoalConstraints(
      'Improve my English for a job interview in three months. I can practice speaking twice per week and vocabulary three times per week, but total work must stay under four hours.',
      '2026-08-25',
    );
    expect(c.exactWeekly).toBe(5);
    // A single clause keeps its single reading, exact or ceiling.
    expect(parseExplicitGoalConstraints('I practice vocabulary three times per week.','2026-08-25').exactWeekly).toBe(3);
    expect(parseExplicitGoalConstraints('I can practice speaking at most twice per week and vocabulary twice per week.','2026-08-25').maxWeekly).toBe(4);
  });

  it('expands a weekday range into every day it spans',()=>{
    const c=parseExplicitGoalConstraints(
      'Practice guitar for 25 minutes Monday through Thursday, focusing on chord changes and one complete song.',
      '2026-08-25',
    );
    expect(c.allowedDays).toEqual([1,2,3,4]);
    expect(c.exactWeekly).toBeUndefined();
    expect(parseExplicitGoalConstraints('Train Monday-Thursday.','2026-08-25').allowedDays).toEqual([1,2,3,4]);
    expect(parseExplicitGoalConstraints('Train Monday to Thursday.','2026-08-25').allowedDays).toEqual([1,2,3,4]);
    expect(parseExplicitGoalConstraints('Run Tuesday through Friday.','2026-08-25').allowedDays).toEqual([2,3,4,5]);
  });

  it('reads "each <weekday>" like "every <weekday>"',()=>{
    // A named weekday bounds the schedule without inventing a plan total.
    const c=parseExplicitGoalConstraints(
      'Build a production-ready social network alone in four weeks while working three hours each Saturday.',
      '2026-08-25',
    );
    expect(c.allowedDays).toEqual([6]);
    expect(c.exactWeekly).toBeUndefined();
    expect(parseExplicitGoalConstraints('I review my notes each Saturday and each Sunday.','2026-08-25').allowedDays).toEqual([6,0]);
  });
});

describe('goal coverage gaps',()=>{
  it('reports nothing when every first-sentence stem is covered',()=>{
    expect(goalCoverageGaps('Prepare for backend interviews',textTask('Backend interview drill'))).toEqual([]);
    expect(goalCoverageGaps('Prepare for backend interviews',textTask('Mock interview practice for backend roles'))).toEqual([]);
  });

  it('reports the goal stems no task pursues, in order of appearance',()=>{
    // The baseline miss: a plan whose only task shares nothing with the request.
    expect(goalCoverageGaps('Prepare for backend interviews',textTask('Review core Java concepts'))).toEqual(['backend','interview']);
    expect(goalCoverageGaps('Prepare for backend interviews',textTask('Review core Java concepts','Read one chapter.','You want steady review.'))).toEqual(['backend','interview']);
  });

  it('keeps a saving goal honest against an unrelated budget task',()=>{
    const gaps=goalCoverageGaps('save money for a house',textTask('Grocery budget review'));
    expect(gaps).toContain('save');
    expect(gaps).toContain('house');
  });

  it('never reports incidental scheduling or framing words as gaps',()=>{
    expect(goalCoverageGaps('Prepare for backend interviews, three sessions per week',textTask('Review core Java concepts'))).toEqual(['backend','interview']);
    expect(goalCoverageGaps('Improve my Spanish by studying every day',textTask('Spanish vocabulary drill'))).toEqual([]);
  });

  it('counts only the first sentence as the goal',()=>{
    // Later sentences carry context and constraints, not the request.
    expect(goalCoverageGaps('Save money for a house. My partner says I waste money.',textTask('Save money for the house fund'))).toEqual([]);
    expect(goalCoverageGaps('Prepare for backend interviews. I own two laptops.',textTask('Backend interview drill'))).toEqual([]);
  });

  it('matches inflections with the benchmark tolerance',()=>{
    // "savings" covers "save", so the plan pursues the goal: the stems are
    // chances to match under ANY-match, not a checklist — demanding "money"
    // here rejected honest transfer plans ("save money" -> gap "money").
    expect(goalCoverageGaps('save money for a house',textTask('Weekly savings transfer'))).toEqual([]);
  });

  it('accepts natural near-synonym drafts that pursue any central stem',()=>{
    // Each pair was a live false-reject: the draft shares an inflection, the
    // goal's own verb, or — for a one-stem request — a goal-family sibling.
    expect(goalCoverageGaps('save money',textTask('Weekly savings transfer'))).toEqual([]);
    expect(goalCoverageGaps('read more books',textTask('Read 20 pages daily'))).toEqual([]);
    expect(goalCoverageGaps('sleep better',textTask('Wind-down routine'))).toEqual([]);
    expect(goalCoverageGaps('I want to get fitter',textTask('5k interval runs'))).toEqual([]);
    expect(goalCoverageGaps('prepare for an exam',textTask('Do 20 practice questions'))).toEqual([]);
    expect(goalCoverageGaps('get stronger',textTask('Push-ups and squats at home'))).toEqual([]);
    expect(goalCoverageGaps('study more consistently',textTask('Pomodoro sessions at a fixed desk time'))).toEqual([]);
    expect(goalCoverageGaps('improve my public speaking',textTask('Speaking drills: introduce myself aloud'))).toEqual([]);
  });

  it('still rejects a draft that shares nothing with the request',()=>{
    // The true corruption shape: a "backend interview preparation" request
    // answered only by unrelated subject matter.
    expect(goalCoverageGaps('backend interview preparation',textTask('Review core Java concepts'))).toEqual(['backend','interview']);
    // Family tolerance is scoped to one-stem requests: with several stems the
    // domain overlap of an unrelated task is not pursuit.
    expect(goalCoverageGaps('sleep better',textTask('Grocery budget review'))).toEqual(['sleep']);
    expect(goalCoverageGaps('save money for a house',textTask('Grocery budget review'))).toEqual(['save','money','house']);
  });

  it('returns no gaps when the request has no usable central tokens',()=>{
    expect(goalCoverageGaps('Three sessions per week',textTask('Anything at all'))).toEqual([]);
    expect(goalCoverageGaps('',textTask('Anything at all'))).toEqual([]);
  });
});
