// Contradiction semantics between the ORIGINAL goal text and a literal
// interview answer about weekly frequency.
//
// The interview can ask "How many days per week can you realistically work on
// this goal?" even when the goal already says "every weekday" (5 days), and a
// canned "3" then contradicts the original statement. Left alone, the draft
// layer unions both and the plan silently deviates from one of them. This
// module decides, deterministically and before any model call, whether the
// answer is CONSISTENT with the stated schedule, CORRECTION (the user is
// deliberately re-speaking — "actually, make it 3 days"), or CONTRADICTION
// (two schedules claimed at once, which must be clarified, never averaged).
import type { ContextEntry } from './context.js';
import type { DayString } from '../domain/dates.js';
import type { CopilotQuestion } from './schemas.js';
import { mentionedDays, parseExplicitGoalConstraints, type ExplicitGoalConstraints } from './goal-constraints.js';

export type FrequencyVerdict = 'CONSISTENT' | 'CORRECTION' | 'CONTRADICTION';

/** The blocking question id parseExplicitGoalConstraints already reads answer-last. */
export const RESOLVE_FREQUENCY_CONFLICT_ID = 'resolve_frequency_conflict';

/**
 * The words that make a statement a deliberate correction rather than fresh
 * information. goal-constraints.ts repeats this alternation inside its
 * answer-last patterns — keep the two lists identical.
 */
export const CORRECTION_SIGNAL = /\b(?:actually|make it|change to|switch to|let's do|lets do|only do|reduce to|instead)\b/i;

const NUMBER_WORDS: Record<string, number> = { once: 1, one: 1, twice: 2, two: 2, thrice: 3, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Free text, arrays flattened — the value side of a recorded answer. */
const answerText = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'string' ? value : '';

/** The words that already read as a conflict resolution verb ("Make Friday available"). */
const RESOLUTION_VERB = /^(?:allow|add|make|reduce|keep|use|switch|let)\b/i;

export function hasCorrectionSignal(text: string): boolean {
  return CORRECTION_SIGNAL.test(text);
}

/**
 * The plan-total number an answer states, or null when it states none.
 *
 * "3" and "three days" are totals; "every weekday"/"weekdays" states the
 * five-day total; "daily" states seven. A day list ("Monday, Wednesday")
 * states no total — that is the days path, not the number path.
 */
export function statedFrequencyNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  const text = answerText(value);
  const digit = text.match(/\b(\d+)\b/);
  if (digit) return Number(digit[1]);
  const word = text.match(/\b(once|twice|thrice|one|two|three|four|five|six|seven)\b/i);
  if (word) return NUMBER_WORDS[word[1].toLowerCase()];
  if (/\bevery\s+weekday\b|\bweekdays?\b/i.test(text)) return 5;
  if (/\bevery\s+day\b|\bdaily\b/i.test(text)) return 7;
  return null;
}

/**
 * Classify one literal answer against the constraints parsed from the ORIGINAL
 * goal text.
 *
 * - A correction signal wins first: the user is re-speaking, so whatever number
 *   follows is the new schedule, never a contradiction to arbitrate.
 * - A stated total must equal the stated exact total (or stay within a stated
 *   ceiling). Silently narrowing "every weekday" to 3 is exactly the deviation
 *   this gate exists to stop, so it is a CONTRADICTION, not a preference.
 * - Named days must all fit the days the goal allows.
 * - Anything else fills a gap the goal never stated: CONSISTENT.
 */
export function classifyFrequencyAnswer(
  constraints: Pick<ExplicitGoalConstraints, 'exactWeekly' | 'maxWeekly' | 'allowedDays'>,
  value: unknown,
): FrequencyVerdict {
  const text = answerText(value);
  if (hasCorrectionSignal(text)) return 'CORRECTION';
  const number = statedFrequencyNumber(value);
  if (number !== null) {
    if (constraints.exactWeekly !== undefined) return number === constraints.exactWeekly ? 'CONSISTENT' : 'CONTRADICTION';
    if (constraints.maxWeekly !== undefined) return number <= constraints.maxWeekly ? 'CONSISTENT' : 'CONTRADICTION';
    return 'CONSISTENT';
  }
  const days = mentionedDays(text);
  if (days.length && constraints.allowedDays?.length) {
    return days.every((day) => constraints.allowedDays!.includes(day)) ? 'CONSISTENT' : 'CONTRADICTION';
  }
  return 'CONSISTENT';
}

export interface FrequencyStatement {
  key: string;
  /** The wording the user actually saw, when this was a asked-and-answered question. */
  question?: string;
  value: unknown;
  /** True for a direct user message (the corrections channel), not a Q&A answer. */
  fromMessage?: boolean;
}

/**
 * Everything the user said this session that could speak to weekly frequency:
 * literal answers AND direct user messages (the corrections channel), in the
 * order they were recorded. A direct message like "actually, make it 3 days"
 * is a resolution without an extra question, and the later statement is the
 * authoritative one — the same last-wins rule the context applies.
 */
export function spokenUserStatements(entries: Record<string, ContextEntry>): FrequencyStatement[] {
  return Object.entries(entries)
    .filter(([, entry]) => entry.source === 'CURRENT_USER_ANSWER' || entry.source === 'CURRENT_USER_MESSAGE')
    .map(([key, entry]) => ({
      key,
      question: entry.question,
      value: entry.value,
      fromMessage: entry.source === 'CURRENT_USER_MESSAGE',
    }));
}

const FREQUENCY_KEY = /frequency|days?_per_week|times?_per_week|weekly/i;
const FREQUENCY_QUESTION = /how\s+(?:many|often)|days?\s+per\s+week|times?\s+per\s+week|sessions?\s+per\s+week|which\s+days?|what\s+days?|days\s+of\s+the\s+week/i;
/** Session-length and target questions state amounts, never a weekly plan total. */
const NON_FREQUENCY_QUESTION = /\bminutes?\b|\bhours?\b|\bpages?\b|\bkg\b|\bkm\b|\bmoney\b|[€$£]/i;

export function isFrequencyStatement(statement: FrequencyStatement): boolean {
  if (statement.key === RESOLVE_FREQUENCY_CONFLICT_ID) return true;
  if (FREQUENCY_KEY.test(statement.key)) return true;
  if (statement.question) return FREQUENCY_QUESTION.test(statement.question) && !NON_FREQUENCY_QUESTION.test(statement.question);
  // A direct message counts when it re-states a schedule with a correction
  // signal — "actually, make it 3 days". Without the signal an arbitrary
  // message stays out: a bare number typed about something else must never be
  // read as a weekly total.
  const text = answerText(statement.value);
  return statement.fromMessage === true
    && hasCorrectionSignal(text)
    && (statedFrequencyNumber(statement.value) !== null || mentionedDays(text).length > 0);
}

export function frequencyStatementsAbout(answers: FrequencyStatement[]): FrequencyStatement[] {
  return answers.filter(isFrequencyStatement);
}

/**
 * The clarification a frequency contradiction must ask before any plan is
 * built, or null when the latest frequency statement is consistent with (or a
 * deliberate correction of) the original goal.
 *
 * Only the LATEST frequency statement is judged: earlier answers were the
 * user's word too, and their latest word is what the context stores as
 * authoritative. A resolve_frequency_conflict answer is by construction the
 * user's pick to settle exactly this conflict, so it always reads as a
 * correction.
 */
export function frequencyConflictClarification(
  goalText: string,
  statements: FrequencyStatement[],
  today: DayString,
): { message: string; question: CopilotQuestion } | null {
  const frequency = frequencyStatementsAbout(statements);
  const latest = frequency[frequency.length - 1];
  if (!latest) return null;
  if (latest.key === RESOLVE_FREQUENCY_CONFLICT_ID) return null;
  const constraints = parseExplicitGoalConstraints(goalText, today);
  if (classifyFrequencyAnswer(constraints, latest.value) !== 'CONTRADICTION') return null;
  const message = contradictionMessage(goalText, constraints, latest.value);
  return {
    message,
    question: {
      id: RESOLVE_FREQUENCY_CONFLICT_ID,
      type: 'FREE_TEXT',
      optional: false,
      allowCustomAnswer: true,
      prompt: message,
    },
  };
}

/** Names both numbers, so the user is choosing between two stated schedules. */
function contradictionMessage(
  goalText: string,
  constraints: Pick<ExplicitGoalConstraints, 'exactWeekly' | 'maxWeekly' | 'allowedDays'>,
  answerValue: unknown,
): string {
  const total = constraints.exactWeekly ?? constraints.maxWeekly;
  const answerNumber = statedFrequencyNumber(answerValue);
  const answerPhrase = answerNumber !== null
    ? `${answerNumber} days per week`
    : `${mentionedDays(answerText(answerValue)).map((day) => DAY_NAMES[day]).join(', ')} as the working days`;
  if (total === undefined) {
    const allowed = (constraints.allowedDays ?? []).map((day) => DAY_NAMES[day]).join(' and ');
    return `You originally said only ${allowed} work for this goal, but your latest answer says ${answerPhrase}. Which schedule should I use?`;
  }
  const originalPhrase = /\bevery\s+weekday\b/i.test(goalText) && total === 5
    ? 'every weekday (5 days a week)'
    : `${constraints.exactWeekly !== undefined ? '' : 'at most '}${total} days per week`;
  return `You originally said ${originalPhrase}, but your latest answer says ${answerPhrase}. Which schedule should I use?`;
}

/**
 * Record a conflict resolution so it reads as what it is: a deliberate
 * correction.
 *
 * The detector re-runs on every generate, so a bare "3" recorded verbatim
 * would re-flag the very answer that resolved the conflict. The transcript
 * keeps the user's raw words; only the stored answer gains the signal.
 */
export function withCorrectionSignal(answer: unknown): string {
  const raw = answerText(answer) || String(answer ?? '').trim();
  if (hasCorrectionSignal(raw) || RESOLUTION_VERB.test(raw)) return raw;
  if (/^(?:\d+|once|twice|one|two|three|four|five|six|seven)$/i.test(raw)) return `Make it ${raw} days per week`;
  return `Make it ${raw}`;
}
