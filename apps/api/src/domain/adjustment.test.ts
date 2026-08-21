import { describe, expect, it } from 'vitest';
import {
  MAX_OFFERS,
  deriveAdjustment,
  deriveAdjustments,
  type AdjustmentInput,
  type LadderState,
} from './adjustment.js';
import { summarizeFeedback, type FeedbackEntry } from './feedback.js';

// Milestone 14. The rule these tests exist to protect: an offer is an offer. It is
// derived from what the user said, it is honest about whether the numbers agree with
// it, and it never appears when there is no real control behind it — a button that
// cannot help is worse than silence.

const TODAY = '2026-08-21';

/** n days of the same rating, ending today, summarised the way the service does. */
function felt(rating: FeedbackEntry['rating'], count: number) {
  const entries = Array.from({ length: count }, (_, i) => {
    const date = new Date(`${TODAY}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - i);
    return { day: date.toISOString().slice(0, 10), rating };
  });
  return summarizeFeedback(entries, TODAY);
}

const LADDER: LadderState = {
  reviewAction: 'STAY',
  completionRate: 70,
  atFirstStage: false,
  atFinalStage: false,
  previousTarget: 20,
  nextTarget: 30,
  unitLabel: 'min',
};

function input(over: Partial<AdjustmentInput> = {}): AdjustmentInput {
  return {
    taskId: 'task-1',
    taskTitle: 'Evening walk',
    difficulty: null,
    ladder: null,
    ...over,
  };
}

describe('when nothing should be offered', () => {
  it('offers nothing on a task nobody has rated', () => {
    expect(deriveAdjustment(input({ ladder: LADDER }))).toBeNull();
  });

  it('offers nothing when the task is feeling about right', () => {
    expect(deriveAdjustment(input({ difficulty: felt('JUST_RIGHT', 6), ladder: LADDER }))).toBeNull();
  });

  it('offers nothing on a single bad day', () => {
    // summarizeFeedback holds the signal at UNKNOWN below its minimum, and that
    // threshold is the only thing standing between one rough evening and a prompt to
    // make the goal easier.
    const one = felt('TOO_HARD', 1);
    expect(one.signal).toBe('UNKNOWN');
    expect(deriveAdjustment(input({ difficulty: one, ladder: LADDER }))).toBeNull();
  });

  it('offers nothing when the days genuinely differed', () => {
    const mixed = summarizeFeedback(
      [
        { day: '2026-08-21', rating: 'TOO_HARD' },
        { day: '2026-08-20', rating: 'TOO_EASY' },
        { day: '2026-08-19', rating: 'TOO_HARD' },
        { day: '2026-08-18', rating: 'TOO_EASY' },
      ],
      TODAY,
    );
    expect(mixed.signal).toBe('MIXED');
    expect(deriveAdjustment(input({ difficulty: mixed, ladder: LADDER }))).toBeNull();
  });

  it('stays quiet about a too-hard task already on its easiest step', () => {
    // There is nowhere to drop back to, and the answer — change the task, not the
    // target — is not something this module can do. A button here would be a lie.
    const offer = deriveAdjustment(
      input({
        difficulty: felt('TOO_HARD', 5),
        ladder: { ...LADDER, atFirstStage: true, previousTarget: null },
      }),
    );
    expect(offer).toBeNull();
  });

  it('stays quiet about a too-easy task already at the top of its ladder', () => {
    const offer = deriveAdjustment(
      input({
        difficulty: felt('TOO_EASY', 5),
        ladder: { ...LADDER, atFinalStage: true, nextTarget: null },
      }),
    );
    expect(offer).toBeNull();
  });
});

describe('easing a task off', () => {
  it('offers the step below, naming the target it would drop to', () => {
    const offer = deriveAdjustment(input({ difficulty: felt('TOO_HARD', 4), ladder: LADDER }))!;
    expect(offer.kind).toBe('EASE_STAGE');
    expect(offer.suggestedAction).toBe('REDUCE');
    expect(offer.headline).toContain('20 min');
    expect(offer.because).toContain('too hard');
  });

  it('never asks the user to override anything to be kinder to themselves', () => {
    // Completion is fine, so the review says STAY — and easing off anyway is still
    // the user's prerogative. authorizeAction agrees: REDUCE from a USER always
    // passes.
    const offer = deriveAdjustment(
      input({ difficulty: felt('TOO_HARD', 4), ladder: { ...LADDER, reviewAction: 'STAY' } }),
    )!;
    expect(offer.needsOverride).toBe(false);
    // But it does not claim the numbers agree when they do not.
    expect(offer.because).not.toContain('Completion agrees');
    expect(offer.because).toContain('70%');
  });

  it('says the numbers agree when the review reached the same conclusion', () => {
    const offer = deriveAdjustment(
      input({
        difficulty: felt('TOO_HARD', 4),
        ladder: { ...LADDER, reviewAction: 'REDUCE', completionRate: 30 },
      }),
    )!;
    expect(offer.because).toContain('Completion agrees');
    expect(offer.because).toContain('30%');
  });

  it('offers a build-up for a too-hard task that has no ladder at all', () => {
    const offer = deriveAdjustment(input({ difficulty: felt('TOO_HARD', 3) }))!;
    expect(offer.kind).toBe('START_LADDER');
    // Nothing to apply: this points at the form where the user sets the stages.
    expect(offer.suggestedAction).toBeNull();
    expect(offer.needsOverride).toBe(false);
  });
});

describe('stepping a task up', () => {
  it('flags a step up the completion rate does not support', () => {
    // The heart of it. Five days of "too easy" with 45% of them actually done is
    // exactly the case where a naive rule would raise the target on someone who is
    // already skipping days.
    const offer = deriveAdjustment(
      input({
        difficulty: felt('TOO_EASY', 5),
        ladder: { ...LADDER, reviewAction: 'STAY', completionRate: 45 },
      }),
    )!;
    expect(offer.kind).toBe('ADVANCE_STAGE');
    expect(offer.needsOverride).toBe(true);
    expect(offer.because).toContain('45%');
    expect(offer.because).toContain('against the numbers');
  });

  it('does not call it an override when the review already agrees', () => {
    const offer = deriveAdjustment(
      input({
        difficulty: felt('TOO_EASY', 5),
        ladder: { ...LADDER, reviewAction: 'ADVANCE', completionRate: 95 },
      }),
    )!;
    expect(offer.needsOverride).toBe(false);
    expect(offer.headline).toContain('30 min');
    expect(offer.because).toContain('Completion agrees');
  });

  it('does not call it an override when the review is the one asking', () => {
    // ASK_USER means the app raised the question because the jump is large. Answering
    // it is not going against anything.
    const offer = deriveAdjustment(
      input({
        difficulty: felt('TOO_EASY', 4),
        ladder: { ...LADDER, reviewAction: 'ASK_USER', completionRate: 90 },
      }),
    )!;
    expect(offer.needsOverride).toBe(false);
    expect(offer.because).toContain('confirm');
  });

  it('offers a build-up for a too-easy task that has no ladder', () => {
    const offer = deriveAdjustment(input({ difficulty: felt('TOO_EASY', 3) }))!;
    expect(offer.kind).toBe('START_LADDER');
    expect(offer.suggestedAction).toBeNull();
  });
});

describe('wording the evidence', () => {
  it('counts only the days that carry the signal', () => {
    const summary = summarizeFeedback(
      [
        { day: '2026-08-21', rating: 'TOO_HARD' },
        { day: '2026-08-20', rating: 'TOO_HARD' },
        { day: '2026-08-19', rating: 'TOO_HARD' },
        { day: '2026-08-18', rating: 'JUST_RIGHT' },
      ],
      TODAY,
    );
    const offer = deriveAdjustment(input({ difficulty: summary, ladder: LADDER }))!;
    expect(offer.because).toContain('3 of the last 4 days');
  });

  it('says "all" rather than "4 of the last 4"', () => {
    const offer = deriveAdjustment(input({ difficulty: felt('TOO_HARD', 4), ladder: LADDER }))!;
    expect(offer.because).toContain('all 4 days');
  });

  it('drops the unit when the ladder has none', () => {
    const offer = deriveAdjustment(
      input({ difficulty: felt('TOO_EASY', 4), ladder: { ...LADDER, unitLabel: '' } }),
    )!;
    expect(offer.headline).toContain('up to 30');
    expect(offer.headline).not.toContain('undefined');
  });
});

describe('ordering and restraint across a goal', () => {
  it('puts struggle before slack', () => {
    const offers = deriveAdjustments([
      input({ taskId: 'easy', taskTitle: 'Water', difficulty: felt('TOO_EASY', 8) }),
      input({ taskId: 'hard', taskTitle: 'Gym', difficulty: felt('TOO_HARD', 3) }),
    ]);
    // The too-easy task has more evidence behind it and still comes second: someone
    // finding a task too hard is the one closer to giving up.
    expect(offers.map((o) => o.taskId)).toEqual(['hard', 'easy']);
  });

  it('leads with the task it knows most about, within the same signal', () => {
    const offers = deriveAdjustments([
      input({ taskId: 'thin', taskTitle: 'Gym', difficulty: felt('TOO_HARD', 3) }),
      input({ taskId: 'thick', taskTitle: 'Run', difficulty: felt('TOO_HARD', 9) }),
    ]);
    expect(offers.map((o) => o.taskId)).toEqual(['thick', 'thin']);
  });

  it('never turns a goal into a list of complaints', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      input({ taskId: `t${i}`, taskTitle: `Task ${i}`, difficulty: felt('TOO_HARD', 4 + i) }),
    );
    expect(deriveAdjustments(many)).toHaveLength(MAX_OFFERS);
    expect(MAX_OFFERS).toBe(3);
  });

  it('returns nothing for a goal where every task is fine', () => {
    expect(
      deriveAdjustments([
        input({ taskId: 'a', difficulty: felt('JUST_RIGHT', 5), ladder: LADDER }),
        input({ taskId: 'b' }),
      ]),
    ).toEqual([]);
  });
});
