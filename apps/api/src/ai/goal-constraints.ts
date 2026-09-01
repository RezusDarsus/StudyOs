import { addDays, type DayString } from '../domain/dates.js';
import type { NormalizedTask } from './draft-validator.js';
import { familyFor, meaningfulTokens } from './plan-quality.js';

export interface ExplicitGoalConstraints {
  exactWeekly?: number;
  maxWeekly?: number;
  allowedDays?: number[];
  excludedDays: number[];
  /** Activities the user explicitly forbade ("no alcohol", "never run"). */
  forbiddenActivities: string[];
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

import { getRuntimeKnowledge, portMemo } from './runtime-knowledge.js';

// The one generic membership check mapping runtime roles to this mechanic enum.
// The role SOURCES are runtime data (the pack carries the exact legacy regexes);
// the closed role set is the mechanic.
const SEMANTIC_TASK_ROLE_SOURCES: ReadonlyArray<{ role: SemanticTaskRole; source: string }> = [
  { role: 'STRENGTH', source: '\\b(strength|resistance|weights?|lower-body|ankle strengthening)\\b' },
  { role: 'TRAIL', source: '\\b(trail|technical terrain)\\b' },
  { role: 'LONG_RUN', source: '\\blong\\s+run\\b' },
  { role: 'FINANCE_TRANSFER', source: '\\b(save|saving|contribut|deposit|transfer|payment|pay(?:ment)?|budget review|bonus)\\b|[€$£]\\s*[\\d,]+|\\b(?:USD|EUR|GBP|GEL)\\b' },
  { role: 'INTERVIEW_PREP', source: '\\b(interview prep|mock interview|interview practice)\\b' },
];

function isSemanticTaskRole(value: string): value is SemanticTaskRole {
  return SEMANTIC_TASK_ROLE_SOURCES.some((definition) => definition.role === value);
}

function runtimeTaskRolePatterns(): Array<{ role: SemanticTaskRole; regex: RegExp }> {
  return portMemo(getRuntimeKnowledge(), 'task-role-patterns', () =>
    getRuntimeKnowledge()
      .getLexicon('task-role')
      .patterns.filter(({ entry }) => isSemanticTaskRole(entry.role ?? ''))
      .map(({ entry, regex }) => ({ role: entry.role as SemanticTaskRole, regex })),
  );
}

export type SemanticTaskRole = 'STRENGTH' | 'TRAIL' | 'LONG_RUN' | 'FINANCE_TRANSFER' | 'INTERVIEW_PREP';

export function semanticTaskRoles(task: Pick<NormalizedTask, 'title' | 'description' | 'reason'>): Set<SemanticTaskRole> {
  const text = `${task.title} ${task.description} ${task.reason}`.toLowerCase();
  const roles = new Set<SemanticTaskRole>();
  // The role VOCABULARY is runtime data; the role names, the lowercased-text
  // mechanic and the Set shape are core.
  for (const { role, regex } of runtimeTaskRolePatterns()) {
    if (regex.test(text)) roles.add(role);
  }
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

/**
 * Planning boilerplate stripped before a goal stem counts as central: request
 * framing, schedule mechanics, quantity words, and closed-class filler. Entries
 * are stemmed forms — meaningfulTokens stems first — so "weeks"/"weekly" and
 * "sessions" collapse onto "week"/"session", and a stem that only frames the
 * request ("improve", "three sessions per week") can never be reported as a gap.
 * Weekday and month names are scheduling constraints, not the goal's subject.
 */
const STOPWORDS_EXTRA = new Set([
  // Closed-class filler that survives the shared tokenizer's length filter.
  'about','after','again','all','also','another','any','always','before','because','been','being','better','best','but','can','could','does','during','each','every','find','feel','from','good','had','has','have','her','here','him','how','instead','its','just','least','less','let','lot','lots','many','may','might','most','much','must','never','new','not','now','old','other','our','over','own','per','really','same','say','shall','she','should','since','some','than','that','then','these','they','them','their','there','thing','things','this','those','too','under','until','very','via','was','well','were','what','when','while','which','who','why','will','without','would','anything','everything','nothing','something',
  // Schedule mechanics: cadence, time-of-day, weekday and month names.
  'week','day','month','year','weekday','weekend','daily','weekly','monthly','annually','session','block','time','minute','hour','schedule','schedul','cadence','frequency','date','deadline','morning','afternoon','evening','night','consecutive','fix','total','split','available','allow','non','level','amount','number','monday','tuesday','wednesday','thursday','friday','saturday','sunday','mon','tue','tues','wed','thu','thur','thurs','fri','sat','sun','jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec','january','february','march','april','june','july','august','september','october','november','december',
  // Quantity words; digit tokens are dropped separately, teens via a suffix regex.
  'once','twice','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','second','third',
  // Request framing and authority language — who decides, not what is done.
  // "Productive"/"defined" are undefined-metric quality talk, never a subject.
  'need','help','improve','improv','improvement','build','create','creat','mak','make','prepare','prepar','preparation','practice','practic','train','study','eat','meet','read','run','walk','learn','try','like','love','enjoy','prefer','keep','stay','stop','quit','avoid','maintain','complete','complet','finish','reach','master','develop','grow','gain','lose','spend','take','give','become','becom','achieve','achiev','apply','accept','add','change','approve','approval','recommend','recommendation','decide','decision','override','pause','resume','preserve','increase','reduce','decrease','outcome','evidence','deliverable','objective','target','habit','routine','metric','baseline','demonstrate','demonstrat','prove','show','shown','please','hello','hey','thank','thanks','productive','productivity','defin','define','clarify','clarification',
  // Outcome/quality comparatives — how the user wants to feel, not work to
  // schedule ("get fitter", "study more consistently", "spend less money").
  // Stemmed forms: "less" stems to "les", so only the stem entry ever matches.
  // They may still serve as matching evidence but are never demanded as gaps.
  'fitter','stronger','consistently','consistent','healthier','happier','confident','calmer','easier','smarter','greater','faster','further','more','les',
]);
/** Digit-led tokens ("800", "5k", "2027") are quantities, never subjects. */
const NUMERIC_TOKEN = /^\d/;
/** Number words past twelve ("fifteenth", "twenty") are quantities too. */
const NUMERIC_WORD = /(?:teen|teenth|tieth)$/;

/** The request itself: the goal's first sentence (or the whole single sentence). */
function firstSentenceStems(goalText: string): string[] {
  const opening = goalText.split('\n', 1)[0].split(/[.!?]/, 1)[0];
  return [...meaningfulTokens(opening)]
    .filter((token) => !NUMERIC_TOKEN.test(token) && !NUMERIC_WORD.test(token));
}

/** First-sentence stems minus the planning boilerplate: the demandable subject. */
function centralGoalStems(goalText: string): string[] {
  return firstSentenceStems(goalText).filter((token) => !STOPWORDS_EXTRA.has(token));
}

/**
 * The benchmark's inflection tolerance: both sides stemmed, a silent trailing
 * "e" dropped, then token equality or a prefix match in either direction — a
 * long task token may absorb a short goal stem ("saving" covers "save"), while
 * a short task token never re-matches a longer stem ("fast" never covers
 * "fasting").
 */
const coverageNorm = (token: string) => (token.length > 3 ? token.replace(/e$/, '') : token);
function stemCovered(stem: string, taskTokens: Set<string>): boolean {
  const term = coverageNorm(stem);
  return [...taskTokens].some((token) => {
    const other = coverageNorm(token);
    return other === term || other.startsWith(term) || (term.startsWith(other) && other.length >= 6);
  });
}

/**
 * The goal's central stems no task pursues, or [] when the plan is about the
 * goal.
 *
 * ANY-match: multiple central stems are multiple chances for the draft to
 * match, not multiple requirements — the draft is rejected only when NO task
 * shares ANY stem of the request's first sentence. Matching runs on every
 * first-sentence stem, the stoplisted framing words included, because a
 * near-synonym draft ("Read 20 pages daily" for a books request) may share
 * only the goal's own verb; the stoplist still governs what is DEMANDED, so
 * "fitter" or "consistently" can never be reported as a gap. A one-stem
 * request ("sleep better") also accepts a goal-family sibling — "wind-down
 * routine" pursues sleep without the word — while several stems keep the gate
 * strict (an unrelated budget task still fails a multi-stem saving goal). On a
 * full miss the central stems are reported in order of appearance.
 */
export function goalCoverageGaps(goalText: string, tasks: Array<Pick<NormalizedTask, 'title' | 'description' | 'reason'>>): string[] {
  const central = centralGoalStems(goalText);
  if (!central.length) return [];
  const matchable = firstSentenceStems(goalText);
  const taskTokens = tasks.map((task) => meaningfulTokens(`${task.title} ${task.description} ${task.reason}`));
  const stemMatch = taskTokens.some((tokens) => matchable.some((stem) => stemCovered(stem, tokens)));
  // A one-stem request leaves a near-synonym draft nothing lexical to share,
  // so there — and only there — a goal-family sibling counts as pursuit.
  const family = central.length === 1 ? familyFor(central[0]) : null;
  const familyMatch = !!family && taskTokens.some((tokens) => [...tokens].some((token) => family.has(token)));
  return stemMatch || familyMatch ? [] : central;
}

/** The explicit-activity vocabulary, from the runtime port. Labels are open
 *  RuntimeRoleIds on both the parse and the validation side. */
function runtimeExplicitActivities(): Array<{ label: string; pattern: RegExp }> {
  return portMemo(getRuntimeKnowledge(), 'explicit-activities', () =>
    getRuntimeKnowledge()
      .getLexicon('explicit-activity')
      .patterns.map(({ entry, regex }) => ({ label: entry.role ?? '', pattern: regex })),
  );
}

/** Activities explicitly joined with "and"/"plus" must all survive the draft. */
export function explicitActivityCoverageGaps(
  goalText: string,
  tasks: Array<Pick<NormalizedTask, 'title' | 'description' | 'reason'>>,
): string[] {
  // The activity VOCABULARY is runtime data; the connector mechanic, ordering
  // and coverage invariant are core.
  const activities = runtimeExplicitActivities();
  const opening = goalText.split('\n', 1)[0].split(/[.!?]/, 1)[0];
  const hits = activities.flatMap((activity) => {
    const match = activity.pattern.exec(opening);
    return match ? [{ ...activity, start: match.index, end: match.index + match[0].length }] : [];
  }).sort((a, b) => a.start - b.start);
  const required = new Set<string>();
  for (let index = 0; index < hits.length - 1; index++) {
    const left = hits[index];
    const right = hits[index + 1];
    const connector = opening.slice(left.end, right.start);
    if (/^\s*(?:,|&|\+|and|plus)(?:\s+(?:the|do|go to|start|practice))?\s*$/i.test(connector)) {
      required.add(left.label);
      required.add(right.label);
    }
  }
  const taskText = tasks.map((task) => `${task.title} ${task.description} ${task.reason}`).join('\n');
  return [...required].filter((label) => {
    const activity = activities.find((candidate) => candidate.label === label)!;
    return !activity.pattern.test(taskText);
  });
}

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

/**
 * Canonical weekday order: Monday-first, Sunday last (ISO convention).
 *
 * Sets are built by several independent clauses whose code order must never
 * leak into the result, so every weekday set is sorted through this before it
 * leaves the parser. (Plain 0-6 sort would put Sunday first, which contradicts
 * the application convention the suite encodes.)
 */
export function canonicalWeekdayOrder(days: Iterable<number>): number[] {
  return [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
}

/**
 * A day of the month stated in free text — "on the 1st", "the first day of
 * every month", "on the fifteenth of each month", "day 10 of each month", "last
 * day of the month" — or undefined when no day is stated. An ordinal followed
 * by a month name is a date, not a monthly day ("start on the 3rd of March").
 */
export function statedDayOfMonth(text: string): number | 'LAST' | undefined {
  const lower = text.toLowerCase();
  const months = Object.keys(MONTHS).join('|');
  const dayOfMonthPattern = /\bday\s+(\d{1,2})\s+of\s+(?:each|every|the)\s+month\b/;
  const ordinalPattern = /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+)?of\s+(?:each|every|the)\s+month\b/;
  const wordOrdinalPattern = new RegExp(`\\b(?:on\\s+)?the\\s+(${Object.keys(WORD_ORDINALS).join('|')})(?:\\s+day)?\\s+of\\s+(?:each|every|the)\\s+month\\b`);
  const bareOrdinalPattern = new RegExp(`\\b(?:on|by|for|starting)?\\s*the\\s+(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s*(?:of\\s+|,?\\s*)(?:${months})\\b)`);
  let stated: number | undefined;
  const dayOfMonth = lower.match(dayOfMonthPattern);
  if (dayOfMonth) stated = Number(dayOfMonth[1]);
  const ordinal = lower.match(ordinalPattern);
  if (ordinal) stated = Number(ordinal[1]);
  const wordOrdinal = lower.match(wordOrdinalPattern);
  if (wordOrdinal) stated = WORD_ORDINALS[wordOrdinal[1]];
  if (stated === undefined) {
    const bareOrdinal = lower.match(bareOrdinalPattern);
    if (bareOrdinal) stated = Number(bareOrdinal[1]);
  }
  if (/\blast day of (?:each|every|the) month\b|\bend of (?:each|every|the) month\b/.test(lower)) return 'LAST';
  return stated;
}

function endOfPreviousMonth(month: number, year: number): DayString {
  return new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10) as DayString;
}

export function taskWeeklyFrequency(task: Pick<NormalizedTask,'recurrenceType'|'recurrenceConfig'>): number {
  if(task.recurrenceType==='EVERY_DAY') return 7;
  if(task.recurrenceType==='SPECIFIC_WEEKDAYS') return task.recurrenceConfig.weekdays?.length??0;
  if(task.recurrenceType==='TIMES_PER_WEEK') return task.recurrenceConfig.timesPerWeek??1;
  if(task.recurrenceType==='EVERY_X_DAYS') return 7/(task.recurrenceConfig.intervalDays??1);
  return 0;
}

/** Every money amount a task states directly or via an AMOUNT ladder. Both
 *  the symbol form (€500 / 500€) and the word form (500 EUR / EUR 500) count —
 *  the same two shapes the role lexicon and the benchmark scorer recognize. */
export function taskMoneyAmounts(task: Pick<NormalizedTask,'title'|'description'|'reason'|'progression'>): number[] {
  const text=`${task.title} ${task.description} ${task.reason}`;
  const symbol=[...text.matchAll(/[€$£]\s*([\d,]+)|([\d,]+)\s*[€$£]/g)].map((m)=>Number((m[1]??m[2]).replace(/,/g,'')));
  const word=[...text.matchAll(/\b([\d,]+)\s*(?:USD|EUR|GBP|GEL)\b|\b(?:USD|EUR|GBP|GEL)\s*([\d,]+)\b/gi)].map((m)=>Number((m[1]??m[2]).replace(/,/g,'')));
  const ladder=task.progression?.metricType==='AMOUNT'?task.progression.stages.map((s)=>s.target):[];
  return [...new Set([...symbol,...word,...ladder])];
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

