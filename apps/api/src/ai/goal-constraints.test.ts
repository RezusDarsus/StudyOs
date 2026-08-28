import { describe, expect, it } from 'vitest';
import { explicitConstraintErrors, extractEvidenceRequirements, parseExplicitGoalConstraints } from './goal-constraints.js';
import type { NormalizedTask } from './draft-validator.js';

const task = (title:string, weekdays:number[], minutes=45):NormalizedTask => ({
  title, description:'', recurrenceType:'SPECIFIC_WEEKDAYS', recurrenceConfig:{weekdays},
  estimatedMinutes:minutes, preferredTime:null, reason:'', reward:20, progression:null,
});
const draft = (tasks:NormalizedTask[], deadline:string|null=null) => ({ targetType:'HABIT',targetValue:null,deadline,tasks });

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

  it('understands qualified and weekly aggregate schedules',()=>{
    expect(parseExplicitGoalConstraints('I need two exercise sessions every week.','2026-08-25').exactWeekly).toBe(2);
    expect(parseExplicitGoalConstraints('I need exactly three total sessions weekly.','2026-08-25').exactWeekly).toBe(3);
    expect(parseExplicitGoalConstraints('Schedule three 50-minute deep-work blocks on weekday mornings.','2026-08-25').exactWeekly).toBe(3);
  });

  it('treats every named weekday as one weekly occurrence',()=>{
    const c=parseExplicitGoalConstraints('Water plants every Saturday morning.','2026-08-25');
    expect(c.exactWeekly).toBe(1);
    expect(c.allowedDays).toEqual([6]);
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
    expect(c.exactWeekly).toBe(1);
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
});
