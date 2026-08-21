// Turning "this has felt too hard all week" into something the app can offer to do.
//
// Two independent readings of the same task meet here:
//
//   completion  — did they do it? Counted by the app, in domain/progression.ts.
//   difficulty  — did it fit? Rated by the person, summarised in domain/feedback.ts.
//
// They disagree more often than you would think, and the disagreement is the useful
// part. A task completed every single day and rated too hard four days running is a
// habit about to break; completion alone will not see it until it does. A task
// completed every day and rated too easy is time the person is spending for less
// than it could be worth.
//
// What this module produces is an *offer*: a sentence saying what could change, a
// sentence saying why, and a flag for whether the completion numbers back it. It
// applies nothing, writes nothing and reads no database. Every offer here points at
// a control the user already has — the progression ladder — because the ladder is
// the mechanism that was built to change what a task asks for without rewriting the
// days already behind it.
//
// Restraint is deliberate and lives in three places:
//   * silence unless the ratings actually say something (summarizeFeedback holds a
//     signal at UNKNOWN below MIN_FEEDBACK days, so a single bad evening offers
//     nothing);
//   * no offer at all when there is nowhere for the ladder to go — the bottom rung
//     of a too-hard task needs the task changed, not the target, and pretending
//     otherwise would be a fake button;
//   * `needsOverride`, so an offer the numbers do not support says so in the
//     interface instead of arriving as a recommendation.

import type { ProgressionAction } from './enums.js';
import type { FeedbackSummary } from './feedback.js';

export const ADJUSTMENT_KIND = ['EASE_STAGE', 'ADVANCE_STAGE', 'START_LADDER'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KIND)[number];

/** At most this many offers, however many tasks a goal has. */
export const MAX_OFFERS = 3;

/** Where a task's ladder stands, and what a numeric review makes of it. */
export interface LadderState {
  /** What a review concludes right now — recomputed from the database, not guessed. */
  reviewAction: ProgressionAction;
  completionRate: number;
  atFirstStage: boolean;
  atFinalStage: boolean;
  previousTarget: number | null;
  nextTarget: number | null;
  unitLabel: string;
}

export interface AdjustmentInput {
  taskId: string;
  taskTitle: string;
  /** Null when this participant has not rated the task at all. */
  difficulty: FeedbackSummary | null;
  /** Null when the task asks for the same thing every time. */
  ladder: LadderState | null;
}

export interface AdjustmentOffer {
  kind: AdjustmentKind;
  taskId: string;
  taskTitle: string;
  /** What could change, in the words a button would use. */
  headline: string;
  /** Why it is being offered: their own ratings first, then the numbers. */
  because: string;
  /** The progression action this points at, or null when it points at building one. */
  suggestedAction: 'ADVANCE' | 'REDUCE' | null;
  /**
   * True when applying this would go against what the completion numbers say.
   *
   * Not a reason to hide the offer — an adult may decide their own pace — but the
   * interface has to label it, and the server will demand an explicit confirmation
   * for it (see authorizeAction in domain/progression.ts).
   */
  needsOverride: boolean;
}

/** "4 of the last 6 days" — the evidence, phrased as the user would say it. */
function outOf(summary: FeedbackSummary, rating: 'TOO_EASY' | 'TOO_HARD'): string {
  const felt = summary.counts[rating];
  const days = `${summary.sampleSize} ${summary.sampleSize === 1 ? 'day' : 'days'}`;
  return felt === summary.sampleSize
    ? `all ${days} you rated`
    : `${felt} of the last ${days} you rated`;
}

/** A target with its unit, when there is one: "20 min", or just "20". */
function target(value: number, unitLabel: string): string {
  return unitLabel ? `${value} ${unitLabel}` : `${value}`;
}

/**
 * The one thing worth offering for this task, or null when that is nothing.
 *
 * Null is the common answer and the right one. JUST_RIGHT means the task is doing
 * its job, MIXED means the days genuinely differed, and UNKNOWN means too few
 * ratings to draw a line through — none of the three is an invitation to change
 * someone's plan.
 */
export function deriveAdjustment(input: AdjustmentInput): AdjustmentOffer | null {
  const { difficulty: summary, ladder } = input;
  if (!summary) return null;
  if (summary.signal !== 'TOO_HARD' && summary.signal !== 'TOO_EASY') return null;

  const base = { taskId: input.taskId, taskTitle: input.taskTitle };
  const rated = outOf(summary, summary.signal);

  if (summary.signal === 'TOO_HARD') {
    if (!ladder) {
      return {
        ...base,
        kind: 'START_LADDER',
        headline: `Build up to ${input.taskTitle} in stages`,
        because:
          `You rated it too hard on ${rated}. It asks for the same thing every day — ` +
          `starting lower and climbing back is usually easier to keep than pushing through.`,
        suggestedAction: null,
        // Nothing moves on a ladder that does not exist yet, so there is no verdict
        // to be going against.
        needsOverride: false,
      };
    }
    // Already at the bottom rung. The honest answer is that the target is not the
    // problem, and there is no button here that would help — so there is no offer.
    // reviewProgression says the same thing in its own words.
    if (ladder.atFirstStage || ladder.previousTarget === null) return null;

    const agrees = ladder.reviewAction === 'REDUCE';
    return {
      ...base,
      kind: 'EASE_STAGE',
      headline: `Drop ${input.taskTitle} back to ${target(ladder.previousTarget, ladder.unitLabel)}`,
      because:
        `You rated it too hard on ${rated}. ` +
        (agrees
          ? `Completion agrees — ${ladder.completionRate}% at this stage.`
          : `You are still getting it done ${ladder.completionRate}% of the time, so this is ` +
            `your call rather than the numbers'.`),
      suggestedAction: 'REDUCE',
      // Easing off is always allowed. Making someone argue with their own app to be
      // kinder to themselves would be absurd.
      needsOverride: false,
    };
  }

  // TOO_EASY.
  if (!ladder) {
    return {
      ...base,
      kind: 'START_LADDER',
      headline: `Let ${input.taskTitle} grow in stages`,
      because:
        `You rated it too easy on ${rated}. A build-up would raise what it asks for a ` +
        `step at a time, and only once the days are actually getting done.`,
      suggestedAction: null,
      needsOverride: false,
    };
  }
  // Nothing above the top rung. Adding stages is a different decision, and it is one
  // the user makes in the progression view rather than one an offer should presume.
  if (ladder.atFinalStage || ladder.nextTarget === null) return null;

  // ASK_USER is not an override: the review itself raised the question, so answering
  // it is the user doing exactly what they were asked to do.
  const backed = ladder.reviewAction === 'ADVANCE' || ladder.reviewAction === 'ASK_USER';
  return {
    ...base,
    kind: 'ADVANCE_STAGE',
    headline: `Step ${input.taskTitle} up to ${target(ladder.nextTarget, ladder.unitLabel)}`,
    because:
      `You rated it too easy on ${rated}. ` +
      (ladder.reviewAction === 'ADVANCE'
        ? `Completion agrees — ${ladder.completionRate}% at this stage.`
        : ladder.reviewAction === 'ASK_USER'
          ? `It is a big step up, so the app will ask you to confirm it.`
          : `Only ${ladder.completionRate}% of these days are getting done though, so ` +
            `stepping up would be your call against the numbers.`),
    suggestedAction: 'ADVANCE',
    needsOverride: !backed,
  };
}

/**
 * Every offer worth making across a goal, most urgent first.
 *
 * Struggle outranks slack: someone finding a task too hard is closer to abandoning
 * the goal than someone finding one too easy, and if only one of these gets read it
 * should be that one. Within a signal, the task with more ratings behind it comes
 * first, because it is the one we know most about.
 */
export function deriveAdjustments(inputs: AdjustmentInput[]): AdjustmentOffer[] {
  const scored: Array<{ offer: AdjustmentOffer; hard: boolean; sampleSize: number }> = [];
  for (const input of inputs) {
    const offer = deriveAdjustment(input);
    if (!offer) continue;
    scored.push({
      offer,
      hard: input.difficulty?.signal === 'TOO_HARD',
      sampleSize: input.difficulty?.sampleSize ?? 0,
    });
  }

  scored.sort((a, b) => {
    if (a.hard !== b.hard) return a.hard ? -1 : 1;
    return b.sampleSize - a.sampleSize;
  });

  // A wall of suggestions reads as a scolding. Three is enough to be useful and few
  // enough to act on.
  return scored.slice(0, MAX_OFFERS).map((row) => row.offer);
}
