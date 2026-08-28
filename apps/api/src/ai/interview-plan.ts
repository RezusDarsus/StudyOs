import type { CopilotQuestion } from './schemas.js';

// What the interview is allowed to ask, and how much of it.
//
// Everything here is deterministic and runs after the model has spoken. That is
// deliberate: the prompt already asks for short, non-repetitive interviews and the
// model still produced nine questions, three of which were "which days?" in
// different words. Advice in a prompt is not a limit, so the limit lives here.
//
// The classifier is a keyword heuristic and will not be perfect. It does not need
// to be: a misfile costs one extra question or one missed one, while the failure it
// prevents — being asked the same thing three times and answering it differently
// each time — produced a plan that contradicted itself.

/**
 * What a question is *about*, which is the unit of repetition that matters.
 *
 * "Which days of the week suit you?", "Which day(s) of the evening work best?" and
 * "Which days do you actually want to read?" are one question asked three times.
 * Deduplicating on question id — which is what we did before — treats them as
 * three, because the model picks a fresh id every time.
 */
export const QUESTION_TOPIC = [
  'FREQUENCY',
  'DAYS',
  'TIME_OF_DAY',
  'DURATION',
  'FORMAT',
  'CONTENT',
  'LOCATION',
  'INTEREST',
  'CONSTRAINT',
  'MOTIVATION',
  'TARGET',
  'EXPERIENCE',
  'OTHER',
] as const;
export type QuestionTopic = (typeof QUESTION_TOPIC)[number];

/**
 * Order matters. "How many days per week?" asks for a number and
 * "Which days of the week?" asks for days, so FREQUENCY has to be tested before
 * DAYS or every frequency question is filed as a day question.
 *
 * Note that DAYS never matches a bare "day": "what time of day" is about the clock,
 * not the calendar.
 */
const TOPIC_PATTERNS: Array<{ topic: QuestionTopic; pattern: RegExp }> = [
  { topic: 'FREQUENCY', pattern: /how many (days|times|sessions)|how often|per week|each week|a week/ },
  { topic: 'DAYS', pattern: /\bdays\b|\bday\(s\)|weekday|weekend|which day/ },
  { topic: 'DURATION', pattern: /how (many minutes|long)|session length|minutes per|how much time/ },
  { topic: 'TIME_OF_DAY', pattern: /time of day|what time|morning|afternoon|evening|night|o'clock/ },
  { topic: 'FORMAT', pattern: /format|medium|e-?book|audiobook|paperback|equipment|at home or|device/ },
  { topic: 'CONTENT', pattern: /what (kind|type|sort)|which (kind|type|genre)|genre|material|subject|topic/ },
  { topic: 'LOCATION', pattern: /\bwhere\b|location|indoors|outdoors|at the gym|at home/ },
  { topic: 'INTEREST', pattern: /enjoy|prefer doing|like doing|which activit|favourite|favorite/ },
  { topic: 'CONSTRAINT', pattern: /avoid|stopping you|get in the way|struggle|obstacle|can'?t do|unavailable/ },
  { topic: 'MOTIVATION', pattern: /\bwhy\b|motivat|what.s driving|important to you/ },
  { topic: 'TARGET', pattern: /how many (books|pages|kg|km)|target|by when|deadline|finish by|aiming for/ },
  { topic: 'EXPERIENCE', pattern: /currently|at the moment|right now|experience|how fit|starting point|level/ },
];

/**
 * Classify a question by what it asks for.
 *
 * The declared type wins where it is unambiguous — a DAYS_OF_WEEK picker is about
 * days no matter how the prompt is worded.
 *
 * The options are consulted only when the prompt itself says nothing recognisable.
 * A live run asked "Pick your ideal reading time" over Morning / Afternoon / Evening:
 * the wording matches no pattern, while the choices could not be clearer. Prompt
 * first and options second, so a well-worded question is never reclassified by an
 * incidental word in one of its choices.
 */
export function questionTopic(
  prompt: string,
  type?: CopilotQuestion['type'],
  options?: readonly string[] | null,
): QuestionTopic {
  if (type === 'DAYS_OF_WEEK') return 'DAYS';
  const text = prompt.toLowerCase();
  for (const { topic, pattern } of TOPIC_PATTERNS) {
    if (pattern.test(text)) return topic;
  }
  if (options?.length) {
    const choices = options.join(' ').toLowerCase();
    for (const { topic, pattern } of TOPIC_PATTERNS) {
      if (pattern.test(choices)) return topic;
    }
  }
  return 'OTHER';
}

/**
 * Topics where more than one answer is legitimately true at once.
 *
 * Someone who reads on the train in the morning and in bed at night has two real
 * answers to "what time of day do you read?", and a radio group makes them throw
 * one away. The remaining topics are genuinely exclusive: a session has one length,
 * a week has one count.
 */
const MULTI_VALUED: ReadonlySet<QuestionTopic> = new Set<QuestionTopic>([
  'DAYS',
  'TIME_OF_DAY',
  'FORMAT',
  'CONTENT',
  'LOCATION',
  'INTEREST',
  'CONSTRAINT',
]);

/**
 * Let a question accept several answers when several can be true.
 *
 * The prompt asks the model to do this itself and it does not reliably — the run
 * that prompted this offered Morning / Afternoon / Evening / Whenever I can as a
 * radio group. Promoting here rather than re-prompting means the fix holds for
 * every question, in both the widget and the full-page interview.
 *
 * Only ever widens what the user may say. Nothing is demoted: a model that asked
 * for MULTI_SELECT knew something we do not.
 */
export function promoteMultiSelect(question: CopilotQuestion): CopilotQuestion {
  if (question.type !== 'SINGLE_SELECT') return question;
  if (!MULTI_VALUED.has(questionTopic(question.prompt, question.type, question.options)))
    return question;
  return { ...question, type: 'MULTI_SELECT' };
}

/**
 * How many questions this request has earned.
 *
 * Someone who writes "I want read more" has told us nothing and a few questions
 * genuinely help. Someone who writes "I want to read 20 pages every evening on
 * weekdays" has already answered the first three, and asking anyway reads as not
 * having listened. `min` drops to zero for a detailed request for exactly that
 * reason — the floor exists to stop generic plans, not to hit a quota.
 */
export interface QuestionBudget {
  min: number;
  max: number;
  /** Topics the opening message already settled. Never asked about again. */
  stated: QuestionTopic[];
  /** A contradiction or undefined metric cannot safely skip clarification. */
  requiresClarification: boolean;
}

export interface PlanningSufficiency {
  enough: boolean;
  known: QuestionTopic[];
  missing: QuestionTopic[];
  highestImpactMissing: QuestionTopic | null;
  questionRange: { min: number; max: number };
  requiresClarification: boolean;
}

/** Signals in the user's own opening words, each pointing at a topic. */
const STATED_PATTERNS: Array<{ topic: QuestionTopic; pattern: RegExp }> = [
  { topic: 'FREQUENCY', pattern: /\b(?:\d+|one|two|three|four|five|six|seven)\s*(?:x|times|days)\s*(?:a|per)\s*week|\b(?:one|1)\s+weekly\b|every ?day|daily|weekdays|weekends|every\s+(?:sun(?:day)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thurs?(?:day)?|fri(?:day)?|sat(?:urday)?)/ },
  { topic: 'DAYS', pattern: /\b(mon|tues?|wed|thur?s?|fri|sat|sun)(day)?s?\b|weekdays|weekends/ },
  { topic: 'DURATION', pattern: /\b\d+\s*(min|minute|hour|hr)/ },
  { topic: 'TIME_OF_DAY', pattern: /\b(morning|afternoon|evening|night|before work|after work|lunchtime)\b|\b\d{1,2}\s?(am|pm)\b/ },
  { topic: 'TARGET', pattern: /\b\d+\s*(pages?|books?|kg|kilos?|km|miles?|words?)\b|by (january|february|march|april|may|june|july|august|september|october|november|december)|in \d+ (weeks?|months?)/ },
  { topic: 'FORMAT', pattern: /e-?books?|audiobooks?|paperbacks?|kindle|podcast|at the gym|at home/ },
  { topic: 'CONTENT', pattern: /fiction|non-?fiction|fantasy|history|biograph|sci-?fi|novels?/ },
];

export function assessPlanningSufficiency(
  goalText: string,
  answeredTopics: readonly QuestionTopic[] = [],
): PlanningSufficiency {
  const text = goalText.toLowerCase();
  const stated = STATED_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ topic }) => topic);
  const known = [...new Set([...stated, ...answeredTopics])];
  const undefinedMetric = /\b(?:twice as (?:creative|smart)|\d+% more productive|become[^.]{0,40}\bexpert\b)/.test(text);
  const exact = text.match(/\b(?:exactly\s+)?(\d+|once|twice|one|two|three|four|five|six|seven)\s+(?:different\s+)?days?\s+(?:each|a|per|every)\s+week/);
  const only = text.match(/(?:only days?[^.]*?(?:are|:)|([^.]*)\s+are the only days|only (?:on )?)([^.]+)/);
  const named = `${only?.[1] ?? ''} ${only?.[2] ?? ''}`.match(/\b(?:sun(?:day)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thurs?(?:day)?|fri(?:day)?|sat(?:urday)?)\b/g) ?? [];
  const words:Record<string,number>={one:1,once:1,two:2,twice:2,three:3,four:4,five:5,six:6,seven:7};
  const requested=exact?words[exact[1]]??Number(exact[1]):0;
  const missingDecisions = /have not set a budget|not (?:set|hired|decided)[^.]{0,80}(?:budget|contractor|move out)/.test(text);
  const requiresClarification=undefinedMetric||missingDecisions||(requested>0&&named.length>0&&requested>new Set(named).size);
  const impactOrder: QuestionTopic[] = ['TARGET', 'FREQUENCY', 'DURATION', 'CONSTRAINT'];
  const missing = impactOrder.filter((topic) => !known.includes(topic));
  const answeredEnough = answeredTopics.includes('TARGET') || known.length >= 2;
  const enough = !requiresClarification && (stated.length >= 2 || answeredEnough);
  return {
    enough,
    known,
    missing,
    highestImpactMissing: missing[0] ?? null,
    questionRange: enough ? { min: 0, max: 0 } : { min: 1, max: 2 },
    requiresClarification,
  };
}

export function questionBudget(goalText: string): QuestionBudget {
  const sufficiency = assessPlanningSufficiency(goalText);
  return {
    min: sufficiency.questionRange.min,
    max: sufficiency.questionRange.max || 1,
    stated: sufficiency.known,
    requiresClarification: sufficiency.requiresClarification,
  };
}

/**
 * Deterministic safety net when the model tries to end a genuinely vague
 * interview early or returns a redundant/empty question.
 */
export function essentialFallbackQuestion(
  goalText:string,
  unavailable:readonly QuestionTopic[],
  preferred?: QuestionTopic | null,
): CopilotQuestion {
  const used = new Set(unavailable);
  const next = preferred && !used.has(preferred)
    ? preferred
    : (['TARGET', 'FREQUENCY', 'DURATION', 'CONSTRAINT'] as QuestionTopic[])
      .find((topic) => !used.has(topic));
  if (next === 'TARGET') return {
    id: 'essential_success', type: 'FREE_TEXT', optional: false, allowCustomAnswer: true,
    prompt: 'What specific target or result would make this goal feel successful to you?',
  };
  if(next === 'FREQUENCY')return{
    id:'essential_frequency',type:'NUMBER',optional:false,allowCustomAnswer:true,
    prompt:'How many days per week can you realistically work on this goal?',
  };
  if(next === 'DURATION')return{
    id:'essential_duration',type:'NUMBER',optional:false,allowCustomAnswer:true,
    prompt:'How many minutes can you realistically spend on each session?',
  };
  if(next === 'CONSTRAINT')return{
    id:'essential_constraint',type:'FREE_TEXT',optional:false,allowCustomAnswer:true,
    prompt:'What limitation, health consideration, or other constraint must the plan respect?',
  };
  return{
    id:'essential_detail',type:'FREE_TEXT',optional:false,allowCustomAnswer:true,
    prompt:`What is the most important detail the plan must preserve for “${goalText.slice(0,80)}”?`,
  };
}

/**
 * Whether a question should be dropped before the user ever sees it.
 *
 * Three independent reasons, and the reason is returned rather than a bare boolean
 * so the caller can log which limit fired without re-deriving it.
 */
export type RedundancyReason = 'REPEATED_ID' | 'REPEATED_TOPIC' | 'ALREADY_STATED' | null;

export function redundancyReason(
  question: CopilotQuestion,
  opts: { askedIds: readonly string[]; askedTopics: readonly QuestionTopic[]; stated: readonly QuestionTopic[] },
): RedundancyReason {
  if (opts.askedIds.includes(question.id)) return 'REPEATED_ID';
  const topic = questionTopic(question.prompt, question.type, question.options);
  // OTHER is the classifier admitting it does not know what this is about, so it
  // cannot be used as evidence that two questions are the same. Letting OTHER
  // deduplicate would silently cap every interview at one unclassifiable question.
  if (topic === 'OTHER') return null;
  if (opts.askedTopics.includes(topic)) return 'REPEATED_TOPIC';
  if (opts.stated.includes(topic)) return 'ALREADY_STATED';
  return null;
}

/** Reject a question whose unit cannot affect the schedule the user requested. */
export function questionDomainMismatch(question: CopilotQuestion, goalText: string): boolean {
  const prompt=question.prompt.toLowerCase();
  const goal=goalText.toLowerCase();
  if (/months? per week|weeks? per month/.test(prompt)) return true;
  if(/let me decide|my decision|decide when (?:to )?resume/.test(goal)&&/resume|days? per week|time of day|minutes? per session|first session/.test(prompt))return true;
  const namedContributionSchedule=/\bfrom\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)|\bin\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)/.test(goal)&&/\b(?:per month|monthly cap|contribut)/.test(goal);
  if(namedContributionSchedule&&/first contribution (?:date|month)|which months? (?:have|use)|monthly cap schedule/.test(prompt))return true;
  if(/every\s+(?:sun(?:day)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thurs?(?:day)?|fri(?:day)?|sat(?:urday)?)/.test(goal)&&/per month|sundays? per month|saturdays? per month/.test(prompt))return true;
  const calendarMonthly=/\bmonthly\b|\bper month\b|\beach month\b|\bevery\s+(?:\w+\s+)?month\b/.test(goal);
  const finance=/\b(save|saving|contribut|deposit|transfer|payment|budget)\b|[€$£]|\b(?:USD|EUR|GBP|GEL)\b/i.test(goalText);
  const topic=questionTopic(question.prompt,question.type,question.options);
  return calendarMonthly
    && finance
    && (topic==='DAYS'||(topic==='FREQUENCY'&&/per week|weekly|days? per/i.test(prompt)));
}
