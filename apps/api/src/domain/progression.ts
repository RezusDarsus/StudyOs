// Progression — the pure decision logic for a task that gets harder on purpose.
//
// Walk 15 minutes, then 20, then 25, then 30. The interesting part is not the
// ladder, it is refusing to climb it when the user is struggling. A plan that
// advances on a 30% completion rate is how an encouraging app turns into a
// discouraging one, so the rules here are deliberately conservative:
//
//   ADVANCE   only when the stage has been held long enough AND completion is at
//             or above the advance threshold.
//   ASK_USER  when they are doing well but the next step is a big jump, or when
//             the evidence is too thin to draw a conclusion from.
//   REDUCE    only ever a *proposal*, below the reduce threshold.
//   STAY      everything else, which is the safe default.
//
// This module is pure: it takes numbers and returns a verdict. It never reads the
// database and never applies anything. Applying is the service's job, and it
// re-derives the verdict rather than trusting a caller — see services/progression.ts.

import { daysBetween, type DayString } from './dates.js';
import type { ProgressionAction, ProgressionSource } from './enums.js';

export interface ProgressionStageInput {
  stageIndex: number;
  target: number;
  minDays: number;
}

export interface ProgressionEvidence {
  /** Inclusive window the numbers were counted over, in the goal's timezone. */
  windowStart: DayString;
  windowEnd: DayString;
  /** Occurrences that existed in the window. */
  eligibleCount: number;
  /** Of those, the ones marked COMPLETED. */
  completedCount: number;
}

export interface ProgressionReviewInput {
  stages: ProgressionStageInput[];
  currentStageIndex: number;
  /** Day the current stage began. Used to enforce the stage's minDays. */
  stageStartedOn: DayString;
  today: DayString;
  advanceThreshold: number;
  reduceThreshold: number;
  evidence: ProgressionEvidence;
}

export interface ProgressionVerdict {
  action: ProgressionAction;
  fromStageIndex: number;
  /** Equal to `fromStageIndex` for STAY and ASK_USER — neither moves the plan. */
  toStageIndex: number;
  completionRate: number;
  /** One sentence, shown to the user verbatim. */
  reason: string;
}

/** A jump larger than this share of the current target is worth asking about. */
const BIG_JUMP_RATIO = 0.5;

/** Below this many occurrences the window says nothing useful either way. */
const MIN_EVIDENCE = 3;

export function completionRate(evidence: ProgressionEvidence): number {
  if (evidence.eligibleCount <= 0) return 0;
  return Math.round((evidence.completedCount / evidence.eligibleCount) * 100);
}

/** The stage at `index`, or null when the index is outside the ladder. */
export function stageAt(
  stages: ProgressionStageInput[],
  index: number,
): ProgressionStageInput | null {
  return stages.find((s) => s.stageIndex === index) ?? null;
}

/**
 * Validate a ladder before it is stored. Stages must be contiguous from 0 and
 * must actually progress, because a "ladder" that goes 15 → 15 → 20 silently
 * wastes a week of the user's time.
 */
export function validateStages(stages: ProgressionStageInput[]): string[] {
  const errors: string[] = [];
  if (stages.length < 2) errors.push('A progression needs at least 2 stages.');
  if (stages.length > 12) errors.push('A progression may have at most 12 stages.');

  const sorted = [...stages].sort((a, b) => a.stageIndex - b.stageIndex);
  sorted.forEach((stage, position) => {
    if (stage.stageIndex !== position) {
      errors.push(`Stage indexes must run 0..${stages.length - 1} with no gaps.`);
    }
    if (stage.target <= 0) errors.push(`Stage ${position + 1} target must be above zero.`);
    if (stage.minDays < 1) errors.push(`Stage ${position + 1} must last at least a day.`);
    const previous = sorted[position - 1];
    if (previous && stage.target <= previous.target) {
      errors.push(`Stage ${position + 1} must ask for more than stage ${position}.`);
    }
  });

  // Duplicate indexes produce the gap error above, but say it plainly too.
  if (new Set(stages.map((s) => s.stageIndex)).size !== stages.length) {
    errors.push('Stage indexes must be unique.');
  }

  return [...new Set(errors)];
}

/** "1 day", "5 days" — these strings are shown to the user verbatim. */
function days(count: number) {
  return `${count} ${count === 1 ? 'day' : 'days'}`;
}

/**
 * Decide what should happen to a progression plan, given how the user has
 * actually been doing. Returns a verdict; it does not change anything.
 */
export function reviewProgression(input: ProgressionReviewInput): ProgressionVerdict {
  const { stages, currentStageIndex, advanceThreshold, reduceThreshold, evidence } = input;
  const rate = completionRate(evidence);
  const from = currentStageIndex;
  const hold = { action: 'STAY' as ProgressionAction, fromStageIndex: from, toStageIndex: from };

  const current = stageAt(stages, from);
  if (!current) {
    return { ...hold, completionRate: rate, reason: 'This plan has no current stage to review.' };
  }

  const daysHeld = daysBetween(input.stageStartedOn, input.today);
  const next = stageAt(stages, from + 1);
  const previous = stageAt(stages, from - 1);

  // Too little history to judge. Saying so beats guessing in either direction.
  if (evidence.eligibleCount < MIN_EVIDENCE) {
    return {
      ...hold,
      completionRate: rate,
      reason:
        evidence.eligibleCount === 0
          ? 'No scheduled days at this stage yet — nothing to judge.'
          : `Only ${days(evidence.eligibleCount)} scheduled so far — not enough to judge yet.`,
    };
  }

  if (rate < reduceThreshold) {
    if (!previous) {
      return {
        ...hold,
        completionRate: rate,
        reason: `${rate}% completed and this is already the easiest stage — worth changing the task itself rather than the target.`,
      };
    }
    return {
      action: 'REDUCE',
      fromStageIndex: from,
      toStageIndex: previous.stageIndex,
      completionRate: rate,
      reason: `${rate}% completed over the last ${days(daysHeld)}. Dropping back to ${previous.target} would rebuild the habit.`,
    };
  }

  if (rate < advanceThreshold) {
    return {
      ...hold,
      completionRate: rate,
      reason: `${rate}% completed — solid, but below the ${advanceThreshold}% needed to step up.`,
    };
  }

  // Doing well. Everything from here is about whether stepping up is safe.
  if (!next) {
    return {
      ...hold,
      completionRate: rate,
      reason: `${rate}% completed at the final stage. Nothing left to step up to.`,
    };
  }

  if (daysHeld < current.minDays) {
    return {
      ...hold,
      completionRate: rate,
      reason: `${rate}% completed, but this stage has only run ${daysHeld} of ${days(current.minDays)}.`,
    };
  }

  const jump = (next.target - current.target) / current.target;
  if (jump > BIG_JUMP_RATIO) {
    return {
      action: 'ASK_USER',
      fromStageIndex: from,
      toStageIndex: next.stageIndex,
      completionRate: rate,
      reason: `${rate}% completed. The next stage jumps from ${current.target} to ${next.target}, which is a big step — worth confirming first.`,
    };
  }

  return {
    action: 'ADVANCE',
    fromStageIndex: from,
    toStageIndex: next.stageIndex,
    completionRate: rate,
    reason: `${rate}% completed over ${days(daysHeld)} at ${current.target}. Ready for ${next.target}.`,
  };
}

/** Human label for the current position, e.g. "Stage 2 of 4". */
export function stageLabel(currentStageIndex: number, stageCount: number): string {
  return `Stage ${currentStageIndex + 1} of ${stageCount}`;
}

// --------------------------------------------------------------- authorization

export interface ActionRequest {
  action: ProgressionAction;
  source: ProgressionSource;
  /** True only when the user has explicitly agreed to a specific proposal. */
  userConfirmed?: boolean;
}

export interface ActionAuthorization {
  allowed: boolean;
  /** Where the plan would land. Equal to the current stage when nothing moves. */
  toStageIndex: number;
  /** Present when the request was refused, for the audit trail. */
  refusal?: string;
}

/**
 * Whether a requested action is backed by the evidence.
 *
 * This is the guard that matters. `reviewProgression` says what *should* happen;
 * this says whether what was *asked for* is allowed to happen. They are separate
 * because the asker is not always the reviewer — the Copilot proposes, a scheduled
 * job proposes, and a user clicks a button — and none of them may talk a plan into
 * advancing while completion is poor.
 *
 * The rules:
 *  * STAY and ASK_USER always pass; neither changes a stage.
 *  * COPILOT never passes on its own — not even when it happens to agree with the
 *    review. A suggestion is not a decision, and "the model asked for the same
 *    thing the numbers did" is still the model moving someone's goal without
 *    being asked. It gets recorded as a proposal and waits for a person.
 *  * A request matching the verdict passes.
 *  * A user answering an ASK_USER proposal passes, either way. They were asked.
 *  * A user may always make a plan EASIER. Refusing that would be paternalistic.
 *  * A user may make it harder only by confirming explicitly, which is why
 *    `userConfirmed` exists rather than being inferred from source alone.
 */
export function authorizeAction(
  request: ActionRequest,
  verdict: ProgressionVerdict,
): ActionAuthorization {
  const stay = { allowed: true, toStageIndex: verdict.fromStageIndex };

  if (request.action === 'STAY' || request.action === 'ASK_USER') return stay;

  // Checked before the agreement test below, deliberately. Agreement is what
  // makes a Copilot proposal worth showing the user; it is not permission.
  if (request.source === 'COPILOT') {
    return {
      ...stay,
      allowed: false,
      refusal:
        request.action === verdict.action
          ? `The Copilot can only suggest ${request.action}; applying it is the user's decision.`
          : `The Copilot can only suggest ${request.action}; the review says ${verdict.action}.`,
    };
  }

  if (request.action === verdict.action) {
    return { allowed: true, toStageIndex: verdict.toStageIndex };
  }

  const oneRung =
    request.action === 'ADVANCE' ? verdict.fromStageIndex + 1 : verdict.fromStageIndex - 1;

  if (request.source === 'USER') {
    // The system raised the question; their answer settles it.
    if (verdict.action === 'ASK_USER' && request.userConfirmed) {
      return { allowed: true, toStageIndex: verdict.toStageIndex };
    }
    if (request.action === 'REDUCE') return { allowed: true, toStageIndex: oneRung };
    if (request.action === 'ADVANCE' && request.userConfirmed) {
      return { allowed: true, toStageIndex: oneRung };
    }
    return {
      ...stay,
      allowed: false,
      refusal: `ADVANCE needs an explicit confirmation at ${verdict.completionRate}% completion.`,
    };
  }

  // SYSTEM: a scheduled review asking for something its own numbers do not back.
  return {
    ...stay,
    allowed: false,
    refusal: `${request.action} is not supported by the numbers; the review says ${verdict.action}.`,
  };
}

/**
 * The target a given day should ask for. Days already stamped keep their stamp —
 * that is the whole point — so this is only consulted when materialising a day or
 * restamping a future one.
 */
export function targetForStage(stages: ProgressionStageInput[], stageIndex: number): number | null {
  return stageAt(stages, stageIndex)?.target ?? null;
}
