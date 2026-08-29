// The readiness gate: a deterministic answer to "is there enough here to plan
// from?"
//
// Advice in a prompt is not a limit, and a model that declares READY_TO_GENERATE
// after one vague exchange produces a plan built on guesses. The interview can
// end early only when this gate agrees, and draft generation refuses sessions
// the gate calls unfinished. Everything here is derived from the user's own
// words and answers — no model output is trusted for the decision.
//
// It is a keyword heuristic and will not be perfect. The failure it prevents —
// a confident plan for a goal nobody ever defined — costs far more than an
// occasional extra question.

import { statedTopics, type QuestionTopic } from './interview-plan.js';

/** What planning needs to know, one dimension each. */
export type PlanningDimension =
  | 'DESIRED_OUTCOME'
  | 'BASELINE'
  | 'WEEKLY_CAPACITY'
  | 'TIMEFRAME'
  | 'CONSTRAINTS'
  | 'PREFERENCES';

export interface PlanReadiness {
  ready: boolean;
  /** Unsatisfied dimensions: blocking ones first, then the merely useful. */
  missing: PlanningDimension[];
  /** known/6, rounded to two decimals — a cheap progress signal for the UI. */
  confidence: number;
}

/** Context keys that speak for each dimension (matched lower-cased). */
const CONTEXT_KEYS: Record<PlanningDimension, readonly string[]> = {
  DESIRED_OUTCOME: ['desired_outcome', 'target', 'target_outcome', 'success_looks_like', 'goal_intent'],
  BASELINE: ['current_level', 'baseline', 'experience', 'starting_point'],
  WEEKLY_CAPACITY: [
    'days_per_week',
    'frequency',
    'weekdays',
    'minutes_per_session',
    'session_length',
    'times_per_week',
  ],
  TIMEFRAME: ['deadline', 'timeframe', 'target_date'],
  CONSTRAINTS: ['constraints', 'limitations', 'avoid', 'disliked_activities', 'restrictions'],
  PREFERENCES: [
    'preferences',
    'preferred_time_of_day',
    'format',
    'learning_format',
    'liked_activities',
    'plan_style',
  ],
};

/** Topics whose answer settles a dimension, on top of any context key. */
const TOPIC_SIGNALS: Partial<Record<PlanningDimension, readonly QuestionTopic[]>> = {
  WEEKLY_CAPACITY: ['FREQUENCY', 'DAYS'],
  BASELINE: ['EXPERIENCE'],
  CONSTRAINTS: ['CONSTRAINT'],
  PREFERENCES: ['FORMAT', 'TIME_OF_DAY'],
};

const BLOCKING: PlanningDimension[] = ['DESIRED_OUTCOME', 'WEEKLY_CAPACITY', 'TIMEFRAME'];
const OPTIONAL: PlanningDimension[] = ['BASELINE', 'CONSTRAINTS', 'PREFERENCES'];

/** A quantity with a unit — "5 kg", "10 pages", "30 minutes", "€200". */
const CONCRETE_QUANTITY = /\b\d+\s*(kg|km|pages?|books?|minutes?|hours?|sessions?|miles?|\$|€|£)/i;
const RELATIVE_TIMEFRAME = /\b(in|within|by)\s+\d+\s+(week|month|day)s?\b/i;
const CALENDAR_TIMEFRAME =
  /\bby\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

/**
 * Subjects concrete enough that "learn X" is a real desired outcome.
 *
 * A heuristic keyword list, deliberately modest: "learn Java" names its object,
 * while "get better" names nothing. Tokens outside the list cost at most one
 * extra question; letting a bare wellness phrase count as a desired outcome
 * costs the user a plan invented from thin air.
 */
const LEARNABLE_SUBJECTS =
  /\b(java|code|coding|programming|english|spanish|japanese|guitar|piano|painting|writing|chess)\b/i;
const LEARNING_VERB = /\b(learn|study|practice|master)\b/i;

function namesConcreteSubject(goalText: string): boolean {
  return LEARNING_VERB.test(goalText) && LEARNABLE_SUBJECTS.test(goalText);
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Decide, from the goal text, the recorded context and the topics already
 * asked, whether the interview has earned a plan.
 */
export function evaluatePlanReadiness(input: {
  goalText: string;
  context: Record<string, unknown>;
  answeredTopics: readonly QuestionTopic[];
  questionCount: number;
}): PlanReadiness {
  const goalText = input.goalText;
  const stated = statedTopics(goalText);
  const knownTopics = new Set<QuestionTopic>([...stated, ...input.answeredTopics]);

  // Keys with a real value only — an empty answer settles nothing.
  const filledKeys = new Set(
    Object.entries(input.context)
      .filter(([, value]) => hasValue(value))
      .map(([key]) => key.toLowerCase()),
  );
  const hasContextKey = (dimension: PlanningDimension) =>
    CONTEXT_KEYS[dimension].some((key) => filledKeys.has(key));
  const hasTopicSignal = (dimension: PlanningDimension) =>
    (TOPIC_SIGNALS[dimension] ?? []).some((topic) => knownTopics.has(topic));

  const known = new Set<PlanningDimension>();

  // A desired outcome comes from the user naming one: a context key (including
  // anything target-shaped), a stated pattern, a unit-ful quantity, or a
  // learnable subject. Bare wellness phrases satisfy none of these, on purpose.
  if (
    hasContextKey('DESIRED_OUTCOME') ||
    [...filledKeys].some((key) => key.includes('target')) ||
    stated.length > 0 ||
    CONCRETE_QUANTITY.test(goalText) ||
    namesConcreteSubject(goalText)
  ) {
    known.add('DESIRED_OUTCOME');
  }

  if (hasContextKey('WEEKLY_CAPACITY') || hasTopicSignal('WEEKLY_CAPACITY')) {
    known.add('WEEKLY_CAPACITY');
  }
  if (hasContextKey('TIMEFRAME') || RELATIVE_TIMEFRAME.test(goalText) || CALENDAR_TIMEFRAME.test(goalText)) {
    known.add('TIMEFRAME');
  }
  if (hasContextKey('BASELINE') || hasTopicSignal('BASELINE')) known.add('BASELINE');
  if (hasContextKey('CONSTRAINTS') || hasTopicSignal('CONSTRAINTS')) known.add('CONSTRAINTS');
  if (hasContextKey('PREFERENCES') || hasTopicSignal('PREFERENCES')) known.add('PREFERENCES');

  const missing = [
    ...BLOCKING.filter((dimension) => !known.has(dimension)),
    ...OPTIONAL.filter((dimension) => !known.has(dimension)),
  ];

  // Three things must hold at once: a real outcome, a schedule (capacity or a
  // timeframe), and evidence the interview engaged at all — answers given, or
  // an opening message detailed enough to state two topics itself. Two is the
  // bar assessPlanningSufficiency has always used for direct generation
  // ("lose 5 kg in 8 weeks ... 4 days a week" states frequency and target and
  // nothing else, and must not be made to answer a questionnaire on top).
  const ready =
    known.has('DESIRED_OUTCOME') &&
    (known.has('WEEKLY_CAPACITY') || known.has('TIMEFRAME')) &&
    (input.questionCount >= 1 || stated.length >= 2);

  return { ready, missing, confidence: Math.round((known.size / 6) * 100) / 100 };
}
