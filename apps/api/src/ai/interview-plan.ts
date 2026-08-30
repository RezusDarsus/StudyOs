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
  'DEADLINE',
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
  { topic: 'TARGET', pattern: /how many (books|pages|kg|km)|target|by when|deadline|finish by|aiming for|what result|result matters|success|outcome|lose weight|build strength|improve endurance|be more active/ },
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
 * A single-select question must always accept the user's own words.
 *
 * The prompt asks the model to set allowCustomAnswer itself and it does not
 * reliably, so the backend guarantees it: the options are suggestions, never a
 * trap. Widening a question is promoteMultiSelect's job; this only guarantees
 * the escape hatch.
 */
export function ensureCustomAnswer(question: CopilotQuestion): CopilotQuestion {
  return question.type === 'SINGLE_SELECT'
    ? { ...question, allowCustomAnswer: true }
    : question;
}

// ------------------------------------------------------------ goal domains

export type GoalDomain =
  | 'FITNESS'
  | 'LEARNING'
  | 'LANGUAGE'
  | 'MONEY'
  | 'CAREER'
  | 'CREATIVE'
  | 'GENERAL';

/**
 * Which domain a goal belongs to, by keyword.
 *
 * The order below is the precedence: "learn English" is a language goal even
 * though it contains a learning verb, and a Java interview is about the career
 * before it is about the language of the code. Matching is on word boundaries,
 * so "retraining" does not read as "training".
 */
const DOMAIN_KEYWORDS: Array<{ domain: GoalDomain; pattern: RegExp }> = [
  { domain: 'LANGUAGE', pattern: /\b(?:english|spanish|french|german|japanese|fluent|vocabulary|speaking|grammar|language)\b/ },
  { domain: 'MONEY', pattern: /\b(?:save|saving|savings|budget|debt|income|spending|money|deposit)\b/ },
  { domain: 'CAREER', pattern: /\b(?:interview|resume|cv|job|career|promotion|networking)\b/ },
  { domain: 'CREATIVE', pattern: /\b(?:guitar|piano|paint|painting|draw|drawing|writing|novel|song|music)\b/ },
  { domain: 'LEARNING', pattern: /\b(?:learn|study|java|python|javascript|programming|coding|course|exam|university|code|math)\b/ },
  { domain: 'FITNESS', pattern: /\b(?:fit|fitter|fitness|gym|workout|exercise|run|running|jog|weight|muscle|strength|endurance|train|training|cycle|swim)\b/ },
];

export function goalDomain(goalText: string): GoalDomain {
  const text = goalText.toLowerCase();
  for (const { domain, pattern } of DOMAIN_KEYWORDS) {
    if (pattern.test(text)) return domain;
  }
  return 'GENERAL';
}

/**
 * The success question, flavoured by domain.
 *
 * "What does success look like?" is hard to answer in the abstract. Each domain
 * has a handful of concrete results a beginner actually recognises; MONEY stays
 * free text because the useful answer is a number and a date, not a choice.
 */
const DOMAIN_SUCCESS_QUESTIONS: Partial<Record<GoalDomain, { prompt: string; options: string[] }>> = {
  FITNESS: {
    prompt: 'What result matters most right now?',
    options: ['Lose weight', 'Build strength', 'Improve endurance', 'Be more active generally'],
  },
  LEARNING: {
    prompt: 'What are you learning this for?',
    options: ['University coursework', 'Job readiness', 'General skills', 'A specific project'],
  },
  LANGUAGE: {
    prompt: 'Which skill should the plan prioritize?',
    options: ['Speaking', 'Listening', 'Grammar', 'Vocabulary'],
  },
  CAREER: {
    prompt: 'What would success look like?',
    options: ['Pass interviews', 'Land an offer', 'Get noticed at work', 'Build a portfolio'],
  },
  CREATIVE: {
    prompt: 'What does progress look like for you?',
    options: ['Finish a piece', 'Build a daily practice', 'Share publicly', 'Learn technique'],
  },
};

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
  { topic: 'TARGET', pattern: /\b\d+\s*(pages?|books?|kg|kilos?|km|miles?|words?)\b|by (january|february|march|april|may|june|july|august|september|october|november|december)|in \d+ (weeks?|months?)|\b(?:lose weight|weight loss|build (?:strength|muscle)|improve (?:endurance|stamina)|be more active)\b/ },
  { topic: 'FORMAT', pattern: /e-?books?|audiobooks?|paperbacks?|kindle|podcast|at the gym|at home/ },
  { topic: 'CONTENT', pattern: /fiction|non-?fiction|fantasy|history|biograph|sci-?fi|novels?/ },
];

/**
 * Topics the user's own opening words already settled, read off the goal text.
 *
 * Used both by assessPlanningSufficiency and by the readiness gate
 * (ai/readiness.ts) — the one source of truth for what a goal statement itself
 * says, so the two gates cannot disagree about it.
 */
export function statedTopics(goalText: string): QuestionTopic[] {
  const text = goalText.toLowerCase();
  return STATED_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ topic }) => topic);
}

export function assessPlanningSufficiency(
  goalText: string,
  answeredTopics: readonly QuestionTopic[] = [],
): PlanningSufficiency {
  const text = goalText.toLowerCase();
  const stated = statedTopics(goalText);
  const known = [...new Set([...stated, ...answeredTopics])];
  const undefinedMetric = /\b(?:twice as (?:creative|smart)|\d+% more productive|become[^.]{0,40}\bexpert\b)/.test(text);
  const exact = text.match(/\b(?:exactly\s+)?(\d+|once|twice|one|two|three|four|five|six|seven)\s+(?:different\s+)?days?\s+(?:each|a|per|every)\s+week/)
    ?? text.match(/\b(?:need|want)\s+(\d+|one|two|three|four|five|six|seven)\s+different\s+(?:[a-z]+\s+){0,2}days\b/);
  // "…are the only days", "…are the only allowed days (available)",
  // "only (allowed) days are …", "only on …" — every phrasing that names the
  // full set of available days must feed the requested-vs-named conflict check.
  const only = text.match(/(?:only days?[^.]*?(?:are|:)|([^.]*)\s+are the only days|only (?:on )?)([^.]+)/);
  const onlyBefore = text.match(/([^.]+?)\s+are the only (?:allowed )?days(?:\s+available)?\b/)?.[1] ?? '';
  const onlyAfter = text.match(/only (?:allowed )?days(?:\s+available)?\s+(?:are|:)\s*([^.]+)/)?.[1] ?? '';
  const named = `${only?.[1] ?? ''} ${only?.[2] ?? ''} ${onlyBefore} ${onlyAfter}`
    .match(/\b(?:sun(?:day)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thurs?(?:day)?|fri(?:day)?|sat(?:urday)?)\b/g) ?? [];
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
  if (next === 'TARGET') {
    // A generic "what does success look like?" is hard to answer in the abstract,
    // so the question is flavoured by domain. MONEY stays free text — the useful
    // answer is an amount and a date — and a goal with no domain keeps the
    // original open prompt.
    const domain = goalDomain(goalText);
    if (domain === 'MONEY') return {
      id: 'essential_success', type: 'FREE_TEXT', optional: false, allowCustomAnswer: true,
      prompt: 'How much do you want to save, and by when?',
    };
    const flavored = DOMAIN_SUCCESS_QUESTIONS[domain];
    if (flavored) return {
      id: 'essential_success', type: 'SINGLE_SELECT', optional: false, allowCustomAnswer: true,
      prompt: flavored.prompt,
      options: flavored.options,
    };
    return {
      id: 'essential_success', type: 'FREE_TEXT', optional: false, allowCustomAnswer: true,
      prompt: 'What specific target or result would make this goal feel successful to you?',
    };
  }
  // Preferred only — the readiness gate sends TIMEFRAME here (see the
  // dimension→topic mapping in services/copilot-session.ts); it is never picked
  // by the default order below because a deadline is a scheduling dimension,
  // not one of the four blocking ambiguities this fallback was written for.
  if (next === 'DEADLINE') return {
    id: 'essential_deadline', type: 'DATE', optional: false, allowCustomAnswer: true,
    prompt: 'When would you like to reach this by?',
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
