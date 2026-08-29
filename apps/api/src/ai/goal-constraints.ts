import { addDays, type DayString } from '../domain/dates.js';
import type { NormalizedTask } from './draft-validator.js';

export interface ExplicitGoalConstraints {
  exactWeekly?: number;
  maxWeekly?: number;
  allowedDays?: number[];
  excludedDays: number[];
  maxMinutes?: number;
  maxWeeklyMinutes?: number;
  deadline?: DayString;
  monthlyMoneyCap?: number;
  calendarFrequency?: { intervalMonths: number; dayOfMonth?: number | 'LAST' };
  requiredWeeklyRoles: Array<{ role: SemanticTaskRole; minOccurrences: number }>;
  requiredRoleDays: Array<{ role: SemanticTaskRole; days: number[] }>;
  progressionPolicy?: { painFreeWeeks?: number; reduceOnRepeatedPain: boolean; pauseOnSharpPain: boolean; approvalRequired: boolean };
  preferredWeeklyBlocks?: number;
  prohibitConsecutiveEvenings: boolean;
  undefinedMetric: boolean;
  requiresClarification: boolean;
}

export type SemanticTaskRole = 'STRENGTH' | 'TRAIL' | 'LONG_RUN' | 'FINANCE_TRANSFER' | 'INTERVIEW_PREP';

export function semanticTaskRoles(task: Pick<NormalizedTask, 'title' | 'description' | 'reason'>): Set<SemanticTaskRole> {
  const text = `${task.title} ${task.description} ${task.reason}`.toLowerCase();
  const roles = new Set<SemanticTaskRole>();
  if (/\b(strength|resistance|weights?|lower-body|ankle strengthening)\b/.test(text)) roles.add('STRENGTH');
  if (/\b(trail|technical terrain)\b/.test(text)) roles.add('TRAIL');
  if (/\blong\s+run\b/.test(text)) roles.add('LONG_RUN');
  if (/\b(save|saving|contribut|deposit|transfer|payment|pay(?:ment)?|budget review|bonus)\b|[€$£]\s*[\d,]+|\b(?:USD|EUR|GBP|GEL)\b/.test(text)) roles.add('FINANCE_TRANSFER');
  if (/\b(interview prep|mock interview|interview practice)\b/.test(text)) roles.add('INTERVIEW_PREP');
  return roles;
}

/** Extract user-defined proof/deliverable clauses without benchmark IDs or names. */
export function extractEvidenceRequirements(text:string):string[]{
  const opening=text.split('\n',1)[0];
  const marker=opening.match(/(?:outcome\s+must\s+be\s+demonstrated\s+by|prove\s+it\s+with|demonstrates?\s+(?:the\s+)?(?:behavior\s+)?through|until\s+i\s+can)\s+([^.!?]+)/i);
  if(!marker)return[];
  return marker[1]
    .replace(/,?\s+and\s+/gi,',')
    .split(',')
    .map((item)=>item.trim().replace(/^(?:a|an|the|one)\s+/i,''))
    .filter((item)=>item.length>=3);
}

const DAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const WORD_NUMBERS: Record<string, number> = { one:1, once:1, two:2, twice:2, three:3, thrice:3, four:4, five:5, six:6, seven:7 };
const numberOf = (value: string) => WORD_NUMBERS[value.toLowerCase()] ?? Number(value);
/** Word ordinals used for calendar-month days ("the first day of every month"). */
const WORD_ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, 'twenty-first': 21, 'twenty-second': 22, 'twenty-third': 23,
  'twenty-fourth': 24, 'twenty-fifth': 25, 'twenty-sixth': 26, 'twenty-seventh': 27,
  'twenty-eighth': 28, 'twenty-ninth': 29, thirtieth: 30, 'thirty-first': 31,
};
const DAY_ALT = 'sun(?:day)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thurs?(?:day)?|fri(?:day)?|sat(?:urday)?';

function mentionedDays(text: string): number[] {
  return [...new Set([...text.toLowerCase().matchAll(new RegExp(`\\b(${DAY_ALT})\\b`, 'g'))].map((m) => DAYS[m[1]]))];
}

function endOfPreviousMonth(month: number, year: number): DayString {
  return new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10) as DayString;
}

export function parseExplicitGoalConstraints(text: string, today: DayString): ExplicitGoalConstraints {
  const lower = text.toLowerCase();
  const result: ExplicitGoalConstraints = {
    excludedDays: [], requiredWeeklyRoles: [], requiredRoleDays: [],
    undefinedMetric:false, requiresClarification:false, prohibitConsecutiveEvenings:false,
  };
  const weekly = lower.match(/\b(exactly\s+|at most\s+|no more than\s+|maximum (?:of )?)?(\d+|once|twice|thrice|one|two|three|four|five|six|seven)(?:\s+(?:different\s+)?(?:total\s+)?[^.!?]{0,28}?(?:sessions?|times?|blocks?|training days?|days?))?\s*(?:(?:each|a|per|every)\s+week|weekly)\b/);
  if (weekly) {
    const value=numberOf(weekly[2]);
    if (/at most|no more|maximum/.test(weekly[1]??'')) result.maxWeekly=value;
    else result.exactWeekly=value;
  }
  const scheduledBlocks = lower.match(/\bschedule\s+(\d+|one|two|three|four|five|six|seven)\s+[^.!?]{0,30}\bblocks?\b/);
  if (result.exactWeekly === undefined && scheduledBlocks) result.exactWeekly=numberOf(scheduledBlocks[1]);
  const statedBlocks = lower.match(/\b(?:usually|normally|reliably)?\s*(?:in|across|split (?:in|into|across))\s+(\d+|one|two|three|four|five|six|seven)\s+blocks?\b/);
  if (statedBlocks) {
    result.maxWeekly=numberOf(statedBlocks[1]);
    result.preferredWeeklyBlocks=numberOf(statedBlocks[1]);
  }
  const authorityOverride=lower.match(/(?:(?:keep|maintain|stay at)\s+(?:exactly\s+)?|(?:reduce|set|change)[^.]{0,25}frequency\s+to\s+)(\d+|once|twice|one|two|three|four|five|six|seven)\s+(?:\d+[- ]minute\s+)?(?:sessions?|days?)/);
  if(authorityOverride) result.exactWeekly=numberOf(authorityOverride[1]);
  const answeredFrequency = lower.match(/"question":"[^"]*(?:how many|frequency)[^"]*(?:days|sessions?)[^"]*(?:per week|weekly)[^"]*","answer":(\d+)/);
  if (answeredFrequency) result.exactWeekly=Number(answeredFrequency[1]);
  // A resolved frequency conflict outranks the opening statement. The blocking
  // question offers reduce / allow two sessions on one day / free up another
  // day, and whichever the user picks is authoritative — otherwise the
  // contradiction the question resolved would still dead-end generation.
  const reduceAnswer = lower.match(new RegExp(`"answer":"[^"]*reduce[^"]{0,80}?(?:to\\s+)?(\\d+|${Object.keys(WORD_NUMBERS).filter((k)=>!/once|twice|thrice/.test(k)).join('|')})\\s+days?`));
  if (reduceAnswer) result.exactWeekly=numberOf(reduceAnswer[1]);
  if (/"answer":"[^"]*allow[^"]{0,40}two sessions? on (?:one|a|the same) day/.test(lower)) {
    result.exactWeekly=result.allowedDays?.length ?? result.exactWeekly;
  }
  const addedDayAnswer = lower.match(new RegExp(`"answer":"[^"]*(?:make|add)[^"]{0,40}?\\b(${DAY_ALT})\\b[^"]{0,30}available`));
  if (addedDayAnswer) {
    result.allowedDays=[...new Set([...(result.allowedDays??[]),DAYS[addedDayAnswer[1]]])];
  }
  if (/\badd(?:ed|ing)?\s+(?:exactly\s+)?(?:one|1)\s+weekly\b/.test(lower) && !answeredFrequency) {
    // This is the executable delta the user accepted. A previous baseline is not
    // present in a self-contained request, so never invent one and call the total
    // four; encode precisely the single newly accepted weekly occurrence.
    result.exactWeekly=1;
  }
  const onlyDays = lower.match(/(?:only (?:on )?|only days?[^.]*?(?:are|:)|([^.]*)\s+are the only days|can (?:ever )?[^.]*?only (?:on )?)([^.]+)/);
  if (onlyDays) {
    const days=mentionedDays(`${onlyDays[1] ?? ''} ${onlyDays[2] ?? ''}`);
    if(days.length)result.allowedDays=days;
  }
  // "Monday and Wednesday are the only allowed days", "…are the only days
  // available", "the only allowed days are Monday and Wednesday".
  const onlyAllowedPre=lower.match(/([^.]+?)\s+are the only (?:allowed )?days(?:\s+available)?\b/);
  if(onlyAllowedPre) {
    const days=mentionedDays(onlyAllowedPre[1]);
    if(days.length)result.allowedDays=result.allowedDays?.length?result.allowedDays:days;
  }
  const onlyAllowedPost=lower.match(/only (?:allowed )?days(?:\s+available)?\s+(?:are|:)\s*([^.]+)/);
  if(onlyAllowedPost) {
    const days=mentionedDays(onlyAllowedPost[1]);
    if(days.length)result.allowedDays=result.allowedDays?.length?result.allowedDays:days;
  }
  const availableDays=lower.match(/(?:possible days?|available days?|may train|can train|can study)[^.]*?((?:sun|mon|tue|wed|thu|fri|sat)[^.]+)/);
  const precedingPossibleDays=lower.match(/([^.]+?)\s+are (?:all )?(?:possible|available) days/);
  const precedingAvailable=lower.match(/([^.]+?)\s+are (?:all )?available\b/);
  if(!result.allowedDays?.length&&availableDays) result.allowedDays=mentionedDays(availableDays[1]);
  if(!result.allowedDays?.length&&precedingPossibleDays) result.allowedDays=mentionedDays(precedingPossibleDays[1]);
  if(!result.allowedDays?.length&&precedingAvailable) result.allowedDays=mentionedDays(precedingAvailable[1]);
  const splitDays=lower.match(/split across\s+([^.]+)/);
  if(!result.allowedDays?.length&&splitDays) result.allowedDays=mentionedDays(splitDays[1]);
  // A named-weekday statement ("every Saturday", "on Tuesday and Thursday")
  // says WHICH days the plan may use — it constrains allowedDays and never
  // synthesizes a global exactWeekly. "I train every Saturday and want to get
  // stronger" says nothing about the plan's total weekly sessions, and reading
  // it as "exactly 1" used to clobber the whole schedule. Only plan-total
  // wording ("three sessions total", "N times per week", "split across N
  // blocks") sets exactWeekly — those regexes live above.
  const addNamedDays=(text:string)=>{
    const days=mentionedDays(text);
    if(days.length)result.allowedDays=[...new Set([...(result.allowedDays??[]),...days])];
  };
  for(const match of lower.matchAll(new RegExp(`\\bevery\\s+((?:${DAY_ALT})(?:(?:\\s*,\\s*|\\s+(?:and|or)\\s+)(?:${DAY_ALT}))*)`,'g'))) addNamedDays(match[1]);
  // A bare "on <day>" only widens the allowed set when several days are listed
  // together ("Run on Tuesday and Thursday"), which reads as the available set
  // rather than a note about one activity.
  for(const match of lower.matchAll(new RegExp(`\\bon\\s+((?:${DAY_ALT})(?:\\s*(?:,|and|or)\\s*(?:${DAY_ALT}))+)`,'g'))) addNamedDays(match[1]);
  // "every weekday" states the whole plan: all five weekdays.
  if(/\bevery\s+weekday\b/.test(lower)&&result.exactWeekly===undefined&&result.maxWeekly===undefined) result.exactWeekly=5;
  // "N different days" is a plan-total statement about the week ("I need three
  // different workout days").
  const differentDays=lower.match(new RegExp(`\\b(\\d+|${Object.keys(WORD_NUMBERS).filter((k)=>!/once|twice|thrice/.test(k)).join('|')})\\s+different\\s+(?:[a-z]+\\s+){0,2}days\\b`));
  if(differentDays&&result.exactWeekly===undefined&&result.maxWeekly===undefined) result.exactWeekly=numberOf(differentDays[1]);
  // A daily statement ("every morning", "daily") with no named weekday in the
  // goal is the whole plan: every day of the week.
  const dailyStatement=lower.match(/\bevery\s+(?!other\b|second\b|third\b|fourth\b|fifth\b)(?:day|morning|afternoon|evening|night)\b|\bdaily\b/);
  if(dailyStatement&&result.exactWeekly===undefined&&result.maxWeekly===undefined&&mentionedDays(lower).length===0) result.exactWeekly=7;
  const scheduledDays=mentionedDays(lower);
  if(result.exactWeekly===undefined && result.maxWeekly===undefined && scheduledDays.length>1 && /\bfixed\b|\bone\s+[^.!?]{0,30}\bsession\b|\bsplit across\b/.test(lower)) {
    result.exactWeekly=scheduledDays.length;
    result.allowedDays??=scheduledDays;
  }
  if(/avoid scheduling every available hour/.test(lower)) result.maxWeekly=5;
  // Calendar intent belongs to the user's opening statement. Interview question
  // wording such as "how many Sundays per month?" must not reinterpret an
  // explicit "every Sunday" goal as MONTHLY.
  const openingText=lower.split('\n',1)[0];
  const calendarAnswer=lower.match(/"answer":\s*"([^"}]*(?:monthly|month)[^"}]*)"/)?.[1]??'';
  const calendarText=`${openingText} ${calendarAnswer}`;
  const everyMonths = calendarText.match(/\bevery\s+(\d+|one|two|three|four|five|six|seven|second|third)\s+months?\b/);
  const monthly = /\bmonthly\b|\bonce (?:a|per) month\b|\b(?:each|every|per) month\b/.test(calendarText);
  if (everyMonths) {
    const word = everyMonths[1];
    result.calendarFrequency = { intervalMonths: word === 'second' ? 2 : word === 'third' ? 3 : numberOf(word) };
  } else if (monthly) {
    result.calendarFrequency = { intervalMonths: 1 };
  }
  if (result.calendarFrequency) {
    const ordinal = lower.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+)?of\s+(?:each|every|the)\s+month\b/);
    if (ordinal) result.calendarFrequency.dayOfMonth=Number(ordinal[1]);
    // "on the first day of every month", "the fifteenth of each month" — word
    // ordinals carry the same day-of-month intent digits do.
    const wordOrdinal = lower.match(new RegExp(`\\b(?:on\\s+)?the\\s+(${Object.keys(WORD_ORDINALS).join('|')})(?:\\s+day)?\\s+of\\s+(?:each|every|the)\\s+month\\b`));
    if (wordOrdinal) result.calendarFrequency.dayOfMonth=WORD_ORDINALS[wordOrdinal[1]];
    // A bare "monthly on the 1st, starting September" — an ordinal suffix is
    // required and a following month name means it is a date, not a monthly day.
    if (result.calendarFrequency.dayOfMonth === undefined) {
      const bareOrdinal = lower.match(new RegExp(`\\b(?:on|by)\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s*(?:of\\s+|,?\\s*)(?:${Object.keys(MONTHS).join('|')})\\b)`));
      if (bareOrdinal) result.calendarFrequency.dayOfMonth=Number(bareOrdinal[1]);
    }
    if (/\blast day of (?:each|every|the) month\b|\bend of (?:each|every|the) month\b/.test(lower)) result.calendarFrequency.dayOfMonth='LAST';
    if (!/\b(?:per|each|every|a) week\b|\bweekly\b/.test(openingText)) result.exactWeekly=undefined;
  }
  for (const match of lower.matchAll(/(?:never|unavailable|exclude|not available)[^.]{0,35}\b(sun(?:day)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thurs?(?:day)?|fri(?:day)?|sat(?:urday)?)\b/g)) result.excludedDays.push(DAYS[match[1]]);
  for (const match of lower.matchAll(/\b(sun(?:day)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thurs?(?:day)?|fri(?:day)?|sat(?:urday)?)\b[^.]{0,25}(?:is|are)\s+(?:unavailable|excluded|not available)/g)) result.excludedDays.push(DAYS[match[1]]);
  result.excludedDays=[...new Set(result.excludedDays)];
  if(result.allowedDays?.length) result.allowedDays=result.allowedDays.filter((day)=>!result.excludedDays.includes(day));
  if (/\bweekdays?\b/.test(lower)) {
    const weekdays = [1, 2, 3, 4, 5].filter((day) => !result.excludedDays.includes(day));
    result.allowedDays = result.allowedDays?.length
      ? result.allowedDays.filter((day) => weekdays.includes(day))
      : weekdays;
  }
  const minutes=lower.match(/(?:must be|no longer than|at most|maximum (?:of )?|may not exceed)\s+(\d+)\s*minutes?/);
  if(minutes) result.maxMinutes=Number(minutes[1]);
  const hours=lower.match(/(?:at most|only|maximum (?:of )?|can reliably (?:study|work|train)?|have|with|for)?\s*(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*hours?(?:\s+available)?\s*(?:each|a|per)?\s*(?:week|weekly)/);
  if(hours) result.maxWeeklyMinutes=Math.round((WORD_NUMBERS[hours[1]]??({eight:8,nine:9,ten:10}[hours[1]] as number)??Number(hours[1]))*60);
  const before=lower.match(/\bbefore\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/);
  if(before) result.deadline=endOfPreviousMonth(MONTHS[before[1]],Number(before[2]));
  const by=lower.match(/\bby\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if(by) result.deadline=`${by[3]}-${String(MONTHS[by[1]]).padStart(2,'0')}-${String(Number(by[2])).padStart(2,'0')}` as DayString;
  const within=lower.match(/\b(?:within|in|over the next)\s+(\d+)\s+weeks?\b/);
  if(within) result.deadline=addDays(today,Number(within[1])*7);
  const cap=lower.match(/(?:cannot contribute more than|at most|contribute at most|monthly cap(?: is)?|capped at)\s*[€$£]?\s*([\d,]+)(?:\s*[€$£])?\s*(?:per month|monthly)/);
  // A cap tied to a named range is part of a variable schedule, not a global
  // ceiling. Treating the first range as global previously changed a later
  // €700 allowance into €650.
  if(cap&&!/\bfrom\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)|\bin\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)/.test(lower.slice(cap.index??0,(cap.index??0)+140))) {
    result.monthlyMoneyCap=Number(cap[1].replace(/,/g,''));
  }
  result.undefinedMetric=/\b(?:twice as (?:creative|smart)|\d+% more productive|become[^.]{0,40}\bexpert\b)/.test(lower);
  if (/\b(?:one|1)\b[^.!?]{0,35}\bstrength\b[^.!?]{0,25}\b(?:weekly|per week|session|day)\b|\bone of (?:the )?(?:three|3) weekly days must be strength\b/i.test(lower)) {
    result.requiredWeeklyRoles.push({ role:'STRENGTH', minOccurrences:1 });
  }
  const roleDayPatterns: Array<[SemanticTaskRole, RegExp]> = [
    ['TRAIL', /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b[^.!?]{0,35}\btrail\b|\btrail\b[^.!?]{0,35}\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i],
    ['LONG_RUN', /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b[^.!?]{0,35}\blong run\b|\blong run\b[^.!?]{0,35}\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i],
  ];
  for (const [role, pattern] of roleDayPatterns) {
    const match=lower.match(pattern);
    const name=match?.[1]??match?.[2];
    if(name) result.requiredRoleDays.push({role,days:[DAYS[name]]});
  }
  const painFree=lower.match(/(?:after|only after)\s+(\d+|one|two|three|four)\s+pain-free weeks?/);
  const progressionPolicy = painFree || /repeated pain|sharp pain|approval|let me decide|my decision|decide when (?:to )?resume/.test(lower);
  if (progressionPolicy) result.progressionPolicy = {
    painFreeWeeks: painFree ? numberOf(painFree[1]) : undefined,
    reduceOnRepeatedPain: /reduce after repeated pain/.test(lower),
    pauseOnSharpPain: /pause for sharp pain/.test(lower),
    approvalRequired: /(?:wait|require)[^.]{0,45}approval|let me decide|my decision|decide when (?:to )?resume/.test(lower),
  };
  result.prohibitConsecutiveEvenings=/never on consecutive evenings|no consecutive evenings/.test(lower);
  const impossibleDays=!!result.exactWeekly && !!result.allowedDays?.length && result.exactWeekly>result.allowedDays.length;
  result.requiresClarification=result.undefinedMetric||impossibleDays||/have not (?:defined|given|set)|not defined|without (?:a )?(?:baseline|metric)/.test(lower);
  return result;
}

export function taskWeeklyFrequency(task: Pick<NormalizedTask,'recurrenceType'|'recurrenceConfig'>): number {
  if(task.recurrenceType==='EVERY_DAY') return 7;
  if(task.recurrenceType==='SPECIFIC_WEEKDAYS') return task.recurrenceConfig.weekdays?.length??0;
  if(task.recurrenceType==='TIMES_PER_WEEK') return task.recurrenceConfig.timesPerWeek??1;
  if(task.recurrenceType==='EVERY_X_DAYS') return 7/(task.recurrenceConfig.intervalDays??1);
  return 0;
}

function taskMoneyAmounts(task: NormalizedTask): number[] {
  const text=`${task.title} ${task.description} ${task.reason}`;
  const direct=[...text.matchAll(/[€$£]\s*([\d,]+)|([\d,]+)\s*[€$£]/g)].map((m)=>Number((m[1]??m[2]).replace(/,/g,'')));
  const ladder=task.progression?.metricType==='AMOUNT'?task.progression.stages.map((s)=>s.target):[];
  return [...direct,...ladder];
}

export function explicitConstraintErrors(
  constraints: ExplicitGoalConstraints,
  draft: { targetType:string; targetValue:number|null; deadline:string|null; tasks:NormalizedTask[] },
): string[] {
  const errors:string[]=[];
  const recurring=draft.tasks.reduce((sum,t)=>sum+taskWeeklyFrequency(t),0);
  if (constraints.exactWeekly !== undefined && constraints.allowedDays?.length && constraints.exactWeekly > constraints.allowedDays.length) {
    errors.push(`The requested ${constraints.exactWeekly} different days cannot fit the ${constraints.allowedDays.length} allowed weekdays; clarification is required.`);
  }
  if(constraints.exactWeekly!==undefined && Math.abs(recurring-constraints.exactWeekly)>0.01) errors.push(`The user requires exactly ${constraints.exactWeekly} total sessions per week, but the tasks total ${Number(recurring.toFixed(2))}.`);
  if(constraints.maxWeekly!==undefined && recurring>constraints.maxWeekly) errors.push(`The user allows at most ${constraints.maxWeekly} total sessions per week, but the tasks total ${Number(recurring.toFixed(2))}.`);
  for(const task of draft.tasks){
    const days=task.recurrenceType==='SPECIFIC_WEEKDAYS'?(task.recurrenceConfig.weekdays??[]):[];
    if(constraints.allowedDays?.length && days.some((d)=>!constraints.allowedDays!.includes(d))) errors.push(`"${task.title}" uses a weekday outside the user's allowed days.`);
    if(days.some((d)=>constraints.excludedDays.includes(d))) errors.push(`"${task.title}" uses a weekday the user excluded.`);
    if(task.recurrenceType==='TIMES_PER_WEEK') {
      const allowed=task.recurrenceConfig.allowedWeekdays;
      const excluded=task.recurrenceConfig.excludedWeekdays??[];
      if(constraints.allowedDays?.length && (!allowed || allowed.some((day)=>!constraints.allowedDays!.includes(day)))) errors.push(`"${task.title}" does not preserve the flexible allowed-weekday boundary.`);
      if(constraints.excludedDays.some((day)=>!excluded.includes(day) && (!allowed || allowed.includes(day)))) errors.push(`"${task.title}" may still occur on an excluded weekday.`);
    }
    if(constraints.maxMinutes!==undefined && (task.estimatedMinutes??0)>constraints.maxMinutes) errors.push(`"${task.title}" exceeds the user's ${constraints.maxMinutes}-minute session cap.`);
    if(constraints.monthlyMoneyCap!==undefined && taskMoneyAmounts(task).some((n)=>n>constraints.monthlyMoneyCap!)) errors.push(`"${task.title}" exceeds the user's monthly contribution cap of ${constraints.monthlyMoneyCap}.`);
  }
  if (constraints.calendarFrequency) {
    const financeTasks=draft.tasks.filter((task)=>semanticTaskRoles(task).has('FINANCE_TRANSFER'));
    // Calendar-month machinery exists to protect money transfers (rent, savings,
    // transfers) from being flattened into weekly work. A non-finance monthly
    // cadence — a book a month, a monthly review — is expressed by the model's
    // own recurrence and must not dead-end the draft with a finance-only error.
    if (financeTasks.length) {
      const expected=constraints.calendarFrequency;
      const mismatch=(task:NormalizedTask):boolean=>{
        if (expected.intervalMonths===1) {
          if (task.recurrenceType!=='MONTHLY') return true;
          return expected.dayOfMonth!==undefined && task.recurrenceConfig.dayOfMonth!==expected.dayOfMonth;
        }
        return task.recurrenceType!=='EVERY_X_MONTHS'
          || task.recurrenceConfig.intervalMonths!==expected.intervalMonths
          || (expected.dayOfMonth!==undefined && task.recurrenceConfig.dayOfMonth!==expected.dayOfMonth);
      };
      if (financeTasks.some(mismatch)) {
        errors.push(expected.dayOfMonth!==undefined && expected.dayOfMonth!=='LAST'
          ? `A calendar-month instruction was not preserved as a monthly recurrence on day ${expected.dayOfMonth} of the month.`
          : 'A calendar-month instruction was not preserved as a monthly recurrence.');
      }
    }
  }
  for (const requirement of constraints.requiredWeeklyRoles) {
    const frequency=draft.tasks
      .filter((task)=>semanticTaskRoles(task).has(requirement.role))
      .reduce((sum,task)=>sum+taskWeeklyFrequency(task),0);
    if(frequency<requirement.minOccurrences) errors.push(`${requirement.role} requires at least ${requirement.minOccurrences} weekly occurrence.`);
  }
  for (const requirement of constraints.requiredRoleDays) {
    const scheduledDays=new Set(draft.tasks
      .filter((task)=>semanticTaskRoles(task).has(requirement.role) && task.recurrenceType==='SPECIFIC_WEEKDAYS')
      .flatMap((task)=>task.recurrenceConfig.weekdays??[]));
    if(requirement.days.some((day)=>!scheduledDays.has(day))) errors.push(`${requirement.role} is missing from its required weekday.`);
  }
  if(constraints.maxWeeklyMinutes!==undefined){
    const total=draft.tasks.reduce((sum,t)=>sum+(t.estimatedMinutes??15)*taskWeeklyFrequency(t),0);
    if(total>constraints.maxWeeklyMinutes) errors.push(`The tasks total ${Math.round(total)} minutes per week, above the user's ${constraints.maxWeeklyMinutes}-minute capacity.`);
  }
  if(constraints.deadline && draft.deadline!==constraints.deadline) errors.push(`The explicit deadline is ${constraints.deadline}, not ${draft.deadline??'null'}.`);
  if(constraints.undefinedMetric && (draft.targetType==='QUANTITY'||draft.targetType==='WEEKLY_TARGET')) errors.push('The goal uses an undefined success metric; do not invent a numeric target. Ask for or use concrete evidence instead.');
  return [...new Set(errors)];
}

/**
 * The parsed constraints, read back as plain sentences.
 *
 * The draft repair prompt includes this list, so a rejection is accompanied by
 * the exact contract the replacement plan has to satisfy instead of only the
 * sentence that failed.
 */
export function describeExplicitConstraints(constraints: ExplicitGoalConstraints): string[] {
  const lines:string[]=[];
  if (constraints.exactWeekly!==undefined) lines.push(`exactly ${constraints.exactWeekly} total sessions per week`);
  if (constraints.maxWeekly!==undefined) lines.push(`at most ${constraints.maxWeekly} total sessions per week`);
  if (constraints.allowedDays?.length) lines.push(`only these weekdays may be used: ${constraints.allowedDays.map((day)=>['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day]).join(', ')}`);
  if (constraints.excludedDays.length) lines.push(`these weekdays are excluded: ${constraints.excludedDays.map((day)=>['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day]).join(', ')}`);
  if (constraints.maxMinutes!==undefined) lines.push(`no session may exceed ${constraints.maxMinutes} minutes`);
  if (constraints.maxWeeklyMinutes!==undefined) lines.push(`no more than ${constraints.maxWeeklyMinutes} minutes of work per week in total`);
  if (constraints.deadline) lines.push(`the deadline is ${constraints.deadline}`);
  if (constraints.monthlyMoneyCap!==undefined) lines.push(`no monthly contribution may exceed ${constraints.monthlyMoneyCap}`);
  if (constraints.calendarFrequency) {
    lines.push(constraints.calendarFrequency.dayOfMonth!==undefined
      ? `the calendar-month cadence must stay a monthly recurrence on day ${constraints.calendarFrequency.dayOfMonth} of the month`
      : 'the calendar-month cadence must stay a monthly recurrence');
  }
  for (const requirement of constraints.requiredWeeklyRoles) lines.push(`${requirement.role} must appear at least ${requirement.minOccurrences} time(s) per week`);
  for (const requirement of constraints.requiredRoleDays) lines.push(`${requirement.role} must be scheduled on ${requirement.days.map((day)=>['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day]).join(', ')}`);
  if (constraints.prohibitConsecutiveEvenings) lines.push('sessions must not land on consecutive evenings');
  if (constraints.undefinedMetric) lines.push('the success metric is undefined; do not invent a numeric target');
  return lines;
}
