import { describe,expect,it } from 'vitest';
import { buildRunSummary,evaluateSemanticCase,monthlyOccurrences,weeklyOccurrences,type BenchmarkDraft,type BenchmarkTask } from './semantic-validator.js';

const task=(title:string,type:BenchmarkTask['recurrenceType'],config:BenchmarkTask['recurrenceConfig']={},extra:Partial<BenchmarkTask>={}):BenchmarkTask=>({title,recurrenceType:type,recurrenceConfig:config,estimatedMinutes:30,...extra});
const draft=(tasks:BenchmarkTask[],rationale=''):BenchmarkDraft=>({title:'Plan',rationale,tasks});

describe('semantic recurrence',()=>{
  it('keeps monthly distinct from weekly',()=>{
    expect(monthlyOccurrences(task('Save','MONTHLY',{dayOfMonth:1}))).toBe(1);
    expect(weeklyOccurrences(task('Save','MONTHLY',{dayOfMonth:1}))).toBe(0);
    expect(monthlyOccurrences(task('Save weekly','TIMES_PER_WEEK',{timesPerWeek:1}))).toBe(0);
    expect(weeklyOccurrences(task('Save weekly','TIMES_PER_WEEK',{timesPerWeek:1}))).toBe(1);
  });
  it('counts one three-day task as three and three such tasks as nine',()=>{
    const three=task('Practice','SPECIFIC_WEEKDAYS',{weekdays:[1,2,3]});
    expect(weeklyOccurrences(three)).toBe(3);
    expect([three,three,three].reduce((sum,item)=>sum+weeklyOccurrences(item),0)).toBe(9);
  });
  it('does not count ONCE as weekly',()=>expect(weeklyOccurrences(task('Strength','ONCE'))).toBe(0));
  it('preserves a specific weekday and checks actual forbidden schedule only',()=>{
    expect(evaluateSemanticCase({allowedDays:[6],forbiddenDays:[5]},{draft:draft([task('Saturday call','SPECIFIC_WEEKDAYS',{weekdays:[6]}, {description:'Do not schedule Friday'})])}).score).toBe(100);
    expect(evaluateSemanticCase({forbiddenDays:[5]},{draft:draft([task('Call','SPECIFIC_WEEKDAYS',{weekdays:[5]} )])}).critical).toContain('SCHEDULE');
  });
});

describe('role-aware schedules',()=>{
  const expected={exactWeekly:3,allowedDays:[1,2,4,6],recurrenceRequirements:[{role:'STRENGTH' as const,frequency:'WEEKLY' as const,minOccurrences:1}],requiredRoleDays:[{role:'TRAIL' as const,days:[6]}]};
  it('passes Saturday trail plus weekly strength',()=>{
    const result=evaluateSemanticCase(expected,{draft:draft([task('Saturday trail practice','SPECIFIC_WEEKDAYS',{weekdays:[6]}),task('Ankle strength','SPECIFIC_WEEKDAYS',{weekdays:[2]}),task('Easy run','SPECIFIC_WEEKDAYS',{weekdays:[4]})])});
    expect(result.score).toBe(100);
  });
  it('fails trail absent on Saturday',()=>expect(evaluateSemanticCase(expected,{draft:draft([task('Trail run','SPECIFIC_WEEKDAYS',{weekdays:[1,2]}),task('Strength','SPECIFIC_WEEKDAYS',{weekdays:[4]})])}).critical).toContain('ROLE_DAY'));
  it('fails one-off strength',()=>expect(evaluateSemanticCase(expected,{draft:draft([task('Saturday trail','SPECIFIC_WEEKDAYS',{weekdays:[6,1,2]}),task('Strength','ONCE')])}).critical).toContain('ROLE_RECURRENCE'));
});

describe('ask-or-assume and question domain',()=>{
  const expected={clarificationPolicy:{anyOf:[{askedTopic:'exchange_rate'},{explicitAssumptionTopic:'exchange_rate'}]}};
  it('accepts an exchange-rate question',()=>expect(evaluateSemanticCase(expected,{draft:draft([task('Save','MONTHLY')]),interview:[{question:{prompt:'What GEL/USD exchange rate should I use?'}}]}).score).toBe(100));
  it('accepts a labeled exchange-rate assumption',()=>expect(evaluateSemanticCase(expected,{draft:draft([task('Save','MONTHLY')]),interview:[]}).score).toBeLessThan(100));
  it('accepts the assumption when it is explicit',()=>expect(evaluateSemanticCase(expected,{draft:draft([task('Save','MONTHLY')],'Planning assumption: 2.75 GEL per USD.')}).score).toBe(100));
  it('rejects weekly scheduling questions for monthly work',()=>expect(evaluateSemanticCase({recurrenceRequirements:[{role:'FINANCE_TRANSFER',frequency:'MONTHLY',minOccurrences:1}]},{draft:draft([task('Savings transfer','MONTHLY')]),interview:[{question:{prompt:'Which weekdays should you save?'}}]}).failures.map(x=>x.code)).toContain('QUESTION_DOMAIN'));
});

describe('semantic financial validation',()=>{
  const prompt='I need $1,800 by January 15, 2027 and can save 700 GEL monthly.';
  const expected={financial:{requireUnitAwareFeasibility:true},recurrenceRequirements:[{role:'FINANCE_TRANSFER' as const,frequency:'MONTHLY' as const,minOccurrences:1}]};
  it('passes converted arithmetic with a disclosed shortfall',()=>{
    const rationale='Planning assumption: 2.75 GEL per USD. 1,800 USD is 4,950 GEL. It requires 8 contributions and has a shortfall before the deadline.';
    expect(evaluateSemanticCase(expected,{prompt,draft:draft([task('Savings transfer 700 GEL','MONTHLY',{dayOfMonth:1})],rationale)}).score).toBe(100);
  });
  it('fails missing conversion and weekly substitution',()=>{
    const result=evaluateSemanticCase(expected,{prompt,draft:draft([task('Savings transfer 700 GEL','SPECIFIC_WEEKDAYS',{weekdays:[6]})],'This will reach $1,800.')});
    expect(result.critical).toEqual(expect.arrayContaining(['ROLE_RECURRENCE','FINANCE']));
  });
  it('requires variable caps to be executable bounded monthly phases',()=>{
    const prompt='By August 31, 2027 reach a combined €8,600 objective. We have €900 available now and can contribute €650 per month from September through November, €300 in December and January, and €700 per month from February onward.';
    const expected={financial:{requireUnitAwareFeasibility:true}};
    const rationale='8600 EUR target after 900 EUR saved; capped contributions total 7450 EUR, leaving a 250 EUR shortfall.';
    const unbounded=evaluateSemanticCase(expected,{prompt,draft:draft([task('€650 transfer','MONTHLY')],rationale)});
    expect(unbounded.critical).toContain('FINANCE_SCHEDULE');
    const tasks=[
      task('€650 transfer','MONTHLY',{activeFrom:'2026-09-01',activeUntil:'2026-11-30'}),
      task('€300 transfer','MONTHLY',{activeFrom:'2026-12-01',activeUntil:'2027-01-31'}),
      task('€700 transfer','MONTHLY',{activeFrom:'2027-02-01',activeUntil:'2027-08-31'}),
    ];
    expect(evaluateSemanticCase(expected,{prompt,draft:draft(tasks,rationale)}).score).toBe(100);
  });
  it('requires skipped months in monthly recurrence metadata',()=>{
    const prompt='I need €4,800 by September 30, 2027 and can save €350 per month, except nothing in December 2026 and January 2027.';
    const rationale='14 contributions are required but at most 12 remain, so there is a shortfall.';
    expect(evaluateSemanticCase({financial:{requireUnitAwareFeasibility:true}},{prompt,draft:draft([task('Save €350','MONTHLY')],rationale)}).critical).toContain('FINANCE_SCHEDULE');
    expect(evaluateSemanticCase({financial:{requireUnitAwareFeasibility:true}},{prompt,draft:draft([task('Save €350','MONTHLY',{excludedMonths:['2026-12','2027-01']})],rationale)}).score).toBe(100);
  });
});

describe('authority and policies',()=>{
  const policy={progressionPolicy:{painFreeWeeks:2,reduceOnRepeatedPain:true,pauseOnSharpPain:true,approvalRequired:true},stageMutationAllowed:false};
  const text='PROGRESS only after 2 pain-free weeks; REDUCE after repeated pain; PAUSE for sharp pain; wait for approval.';
  it('passes policy text with no mutation',()=>expect(evaluateSemanticCase(policy,{draft:draft([task('Run','TIMES_PER_WEEK',{timesPerWeek:2})],text)}).score).toBe(100));
  it('fails automatic progression when approval is reserved',()=>expect(evaluateSemanticCase(policy,{draft:draft([task('Run','TIMES_PER_WEEK',{timesPerWeek:2},{progression:{stages:[1,2]}})],text)}).critical).toContain('USER_CONTROL'));
  it('fails missing reduction and pause conditions',()=>expect(evaluateSemanticCase(policy,{draft:draft([task('Run','TIMES_PER_WEEK',{timesPerWeek:2})],'Wait for approval.')} ).critical).toContain('PROGRESSION_POLICY'));
  it('preserves rejection and override language as authority evidence',()=>{
    expect(evaluateSemanticCase({progressionPolicy:{approvalRequired:true},stageMutationAllowed:false},{draft:draft([task('Stay','TIMES_PER_WEEK',{timesPerWeek:2})],'I reject the increase; my override is STAY and requires my approval.')} ).score).toBe(100);
  });
  it('validates an accepted decision without asking for approval again',()=>{
    expect(evaluateSemanticCase({userDecision:'ACCEPT',stageMutationAllowed:false},{draft:draft([task('Added practice','TIMES_PER_WEEK',{timesPerWeek:1})],'You accepted the one-session recommendation.')} ).score).toBe(100);
    expect(evaluateSemanticCase({userDecision:'ACCEPT'},{draft:draft([task('Practice','TIMES_PER_WEEK',{timesPerWeek:1})],'Recommended one session.')} ).critical).toContain('USER_DECISION');
  });
});

describe('claims and evidence',()=>{
  it('does not treat a negated forbidden phrase as an asserted claim',()=>{
    expect(evaluateSemanticCase({forbiddenClaims:['guaranteed','extra income']},{draft:draft([],"Do not call the best month guaranteed; use no extra income.")}).score).toBe(100);
  });
  it('requires all meaningful evidence tokens',()=>{
    expect(evaluateSemanticCase({requiredEvidence:['streaming prototype']},{draft:draft([], 'A streaming course only.')} ).failures.map((failure)=>failure.code)).toContain('EVIDENCE');
    expect(evaluateSemanticCase({requiredEvidence:['streaming prototype']},{draft:draft([task('Build a streaming prototype','ONCE')])} ).score).toBe(100);
  });
  it('accepts morphological evidence but only when it appears in executable tasks',()=>{
    expect(evaluateSemanticCase({requiredEvidence:['idempot']},{draft:draft([task('Implement idempotent retries','ONCE')])}).score).toBe(100);
    expect(evaluateSemanticCase({requiredEvidence:['review rating']},{draft:{title:'Plan',description:'Original request mentions reviewer ratings.',tasks:[task('Practice','ONCE')]}}).critical).toContain('EVIDENCE');
  });
});

describe('reporting',()=>{
  it('uses executed cases as the targeted transport denominator',()=>{
    expect(buildRunSummary(50,[{transportSuccess:true,semanticScore:100,constraintPass:true},{transportSuccess:true,semanticScore:100,constraintPass:true}])).toMatchObject({fixtureTotal:50,executedCases:2,transportSuccessful:2,transportSuccessRate:1});
  });
});
