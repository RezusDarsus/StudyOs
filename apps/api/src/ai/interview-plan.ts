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
}

/** Signals in the user's own opening words, each pointing at a topic. */
const STATED_PATTERNS: Array<{ topic: QuestionTopic; pattern: RegExp }> = [
  { topic: 'FREQUENCY', pattern: /\b(\d+)\s*(x|times|days)\s*(a|per)\s*week|every ?day|daily|weekdays|weekends/ },
  { topic: 'DAYS', pattern: /\b(mon|tues?|wed|thur?s?|fri|sat|sun)(day)?s?\b|weekdays|weekends/ },
  { topic: 'DURATION', pattern: /\b\d+\s*(min|minute|hour|hr)/ },
  { topic: 'TIME_OF_DAY', pattern: /\b(morning|afternoon|evening|night|before work|after work|lunchtime)\b|\b\d{1,2}\s?(am|pm)\b/ },
  { topic: 'TARGET', pattern: /\b\d+\s*(pages?|books?|kg|kilos?|km|miles?|words?)\b|by (january|february|march|april|may|june|july|august|september|october|november|december)|in \d+ (weeks?|months?)/ },
  { topic: 'FORMAT', pattern: /e-?books?|audiobooks?|paperbacks?|kindle|podcast|at the gym|at home/ },
  { topic: 'CONTENT', pattern: /fiction|non-?fiction|fantasy|history|biograph|sci-?fi|novels?/ },
];

export function questionBudget(goalText: string): QuestionBudget {
  const text = goalText.toLowerCase();
  const stated = STATED_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ topic }) => topic);

  // Three or more specifics is someone who has already thought it through. Give
  // them a plan, not a questionnaire.
  if (stated.length >= 3) return { min: 0, max: 2, stated };
  if (stated.length >= 1) return { min: 2, max: 4, stated };
  return { min: 2, max: 5, stated };
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
