// The feasibility gate: a deterministic check that the draft is chasing something
// a schedule can actually deliver.
//
// The plan pipeline will happily build eight tasks for "become twice as creative
// in 30 days" — the schedule is valid, and the goal is nonsense. Creativity has no
// unit a build-up ladder can count, so any plan for it is theater. This gate reads
// the user's own words (plus the draft's target/deadline) and refuses the two ways
// a goal can be unplannable: quantifying the unquantifiable inside a short window
// (NEEDS_REFRAME), or naming no measurable outcome at all (NEEDS_CLARIFICATION).
// Like the rest of the deterministic layer, it is keyword-based and deliberately
// narrow: a missed signal costs one extra question, a false alarm costs a plan.

import { daysBetween, isDayString, todayIn } from '../domain/dates.js';
import { getRuntimeKnowledge, portMemo } from './runtime-knowledge.js';

// The feasibility gate: a deterministic check that the draft is chasing something
// a schedule can actually deliver.
//
// The plan pipeline will happily build eight tasks for "become twice as creative
// in 30 days" — the schedule is valid, and the goal is nonsense. Creativity has no
// unit a build-up ladder can count, so any plan for it is theater. This gate reads
// the user's own words (plus the draft's target/deadline) and refuses the two ways
// a goal can be unplannable: quantifying the unquantifiable inside a short window
// (NEEDS_REFRAME), or naming no measurable outcome at all (NEEDS_CLARIFICATION).
// Like the rest of the deterministic layer, it is keyword-based and deliberately
// narrow: a missed signal costs one extra question, a false alarm costs a plan.

export type FeasibilityVerdict = 'OK' | 'NEEDS_CLARIFICATION' | 'NEEDS_REFRAME';

export interface FeasibilityInput {
  goalText: string;
  deadline?: string | null;
  targetType?: string;
  targetValue?: number | null;
}

export interface FeasibilityAssessment {
  verdict: FeasibilityVerdict;
  reason?: string;
}

/** Stage 3: the quality-noun LIST is runtime data; the word-boundary frame and
 *  case-insensitivity are unchanged mechanics. An absent pack degrades to the
 *  generic never-match. */
function qualityNoun(): RegExp {
  return portMemo(getRuntimeKnowledge(), 'quality-noun', () => {
    const words = getRuntimeKnowledge().getLexicon('non-measurable-quality').phrases;
    return words.length
      ? new RegExp(`\\b(?:${words.join('|')})\\b`, 'i')
      : /(?!x)x/;
  });
}
/** Comparative/percentage claims that promise a quantified jump. A trailing \b
 * only works after "percent" — "%" to "space" is no word boundary at all. */
const COMPARATIVE_CLAIM = /\b(?:twice\s+as|double)\b|\d+(?:\.\d+)?\s*(?:%|percent\b)/i;

/** "in 30 days", "within 12 weeks", "in 3 months" — a stated horizon in the text. */
const STATED_WINDOW = /\b(?:in|within)\s+(\d+)\s+(day|week|month)s?\b/i;
/** "by March 15" / "by March 15, 2027" — a named calendar date in the text. */
const BY_DATE =
  /\bby\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/i;
const MONTH_INDEX: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};
/** Vague outcomes that state a direction but no metric. */
const VAGUE_OUTCOME = /\b(?:get better at|improve my|become more)\b/i;
/** Deadline phrases stripped before testing whether any number remains. */
const STATED_TIMEFRAME =
  /\b(?:in|within|by|over the next)\s+\d+\s*(?:day|week|month)s?\b|\bby\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b[^,.;]*/gi;

const WINDOW_DAYS = { day: 1, week: 7, month: 30 } as const;
const SHORT_WINDOW_DAYS = 90;

/** Days from today to a "by <date>" clause, or null when absent/unparsable. */
function daysToStatedDate(text: string, today: string): number | null {
  const match = text.match(BY_DATE);
  if (!match) return null;
  const month = MONTH_INDEX[match[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = match[3] ? Number(match[3]) : Number(today.slice(0, 4));
  // A yearless date already passed this year means next year, the same reading
  // every other calendar parser in the pipeline uses.
  let candidate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (candidate < today) {
    candidate = `${year + 1}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return daysBetween(today, candidate);
}

/** A "in N days/weeks/months" clause as days, or null when absent. */
function statedWindowDays(text: string): number | null {
  const match = text.match(STATED_WINDOW);
  if (!match) return null;
  return Number(match[1]) * WINDOW_DAYS[match[2].toLowerCase() as keyof typeof WINDOW_DAYS];
}

/** The draft's own deadline counts as the window when it is within ~90 days. */
function isShortDeadline(deadline: string | null | undefined, today: string): boolean {
  if (!deadline || !isDayString(deadline)) return false;
  const days = daysBetween(today, deadline);
  return days >= 0 && days <= SHORT_WINDOW_DAYS;
}

/**
 * Decide whether the goal as drafted is something a schedule can chase.
 * Pure and deterministic; the only clock read is today's UTC date, and the only
 * failure modes are the two unplannable goal shapes above.
 */
export function assessFeasibility(input: FeasibilityInput): FeasibilityAssessment {
  const text = input.goalText.toLowerCase();
  const today = todayIn('UTC');
  const quality = text.match(qualityNoun())?.[0];
  const windowDays = statedWindowDays(text) ?? daysToStatedDate(text, today);
  const shortWindow =
    (windowDays !== null && windowDays >= 0 && windowDays <= SHORT_WINDOW_DAYS)
    || isShortDeadline(input.deadline, today);
  if (quality && COMPARATIVE_CLAIM.test(text) && shortWindow) {
    return {
      verdict: 'NEEDS_REFRAME',
      reason: `You asked for a measurable jump in "${quality}", but a quality like that has no number a schedule can track. Decide what measurable signal would show you improved — work produced, sessions completed, hours practiced — and set that as the goal instead.`,
    };
  }
  // Deadline phrases carry numbers that are not metrics; strip them before asking
  // whether the goal has any number at all.
  const withoutTimeframe = text.replace(STATED_TIMEFRAME, ' ');
  if (VAGUE_OUTCOME.test(text) && !/\d/.test(withoutTimeframe)) {
    return {
      verdict: 'NEEDS_CLARIFICATION',
      reason: 'Your goal does not name a measurable outcome, so a plan has nothing concrete to aim at. Tell us what measurable signal would show you improved — a number, a deadline artifact, or a concrete piece of evidence — and the plan can be built around it.',
    };
  }
  return { verdict: 'OK' };
}
