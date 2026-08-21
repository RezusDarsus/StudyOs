import { describe, expect, it } from 'vitest';
import {
  authorizeAction,
  completionRate,
  reviewProgression,
  stageAt,
  stageLabel,
  validateStages,
  type ProgressionEvidence,
  type ProgressionReviewInput,
  type ProgressionStageInput,
} from './progression.js';

// Milestone 10. The rule these tests exist to protect: a progression must never
// advance on poor completion, no matter how it is asked. Everything else here is
// support for that one guarantee.

const ladder: ProgressionStageInput[] = [
  { stageIndex: 0, target: 15, minDays: 7 },
  { stageIndex: 1, target: 20, minDays: 7 },
  { stageIndex: 2, target: 25, minDays: 7 },
  { stageIndex: 3, target: 30, minDays: 7 },
];

const evidence = (over: Partial<ProgressionEvidence> = {}): ProgressionEvidence => ({
  windowStart: '2026-08-01',
  windowEnd: '2026-08-07',
  eligibleCount: 7,
  completedCount: 7,
  ...over,
});

const review = (over: Partial<ProgressionReviewInput> = {}) =>
  reviewProgression({
    stages: ladder,
    currentStageIndex: 1,
    stageStartedOn: '2026-08-01',
    today: '2026-08-08',
    advanceThreshold: 80,
    reduceThreshold: 40,
    evidence: evidence(),
    ...over,
  });

describe('completionRate', () => {
  it('is a whole percentage of the eligible days', () => {
    expect(completionRate(evidence({ eligibleCount: 7, completedCount: 6 }))).toBe(86);
  });

  it('is zero rather than NaN when nothing was scheduled', () => {
    expect(completionRate(evidence({ eligibleCount: 0, completedCount: 0 }))).toBe(0);
  });
});

describe('validateStages', () => {
  it('accepts a rising ladder', () => {
    expect(validateStages(ladder)).toEqual([]);
  });

  it('rejects a single stage, which is not a progression', () => {
    expect(validateStages([{ stageIndex: 0, target: 15, minDays: 7 }])).toContain(
      'A progression needs at least 2 stages.',
    );
  });

  it('rejects a stage that does not ask for more than the one before', () => {
    const flat: ProgressionStageInput[] = [
      { stageIndex: 0, target: 15, minDays: 7 },
      { stageIndex: 1, target: 15, minDays: 7 },
    ];
    expect(validateStages(flat)).toContain('Stage 2 must ask for more than stage 1.');
  });

  it('rejects a gap in the indexes', () => {
    const gapped: ProgressionStageInput[] = [
      { stageIndex: 0, target: 15, minDays: 7 },
      { stageIndex: 2, target: 20, minDays: 7 },
    ];
    expect(validateStages(gapped)).toContain('Stage indexes must run 0..1 with no gaps.');
  });

  it('rejects a non-positive target', () => {
    const zeroed: ProgressionStageInput[] = [
      { stageIndex: 0, target: 0, minDays: 7 },
      { stageIndex: 1, target: 20, minDays: 7 },
    ];
    expect(validateStages(zeroed)).toContain('Stage 1 target must be above zero.');
  });
});

describe('reviewProgression advances only when earned', () => {
  it('advances one rung on a full week at the target', () => {
    const verdict = review();
    expect(verdict.action).toBe('ADVANCE');
    expect(verdict.fromStageIndex).toBe(1);
    expect(verdict.toStageIndex).toBe(2);
    expect(verdict.reason).toContain('Ready for 25');
  });

  it('holds when completion is under the advance threshold', () => {
    const verdict = review({ evidence: evidence({ eligibleCount: 7, completedCount: 5 }) });
    expect(verdict.action).toBe('STAY');
    expect(verdict.toStageIndex).toBe(1);
    expect(verdict.completionRate).toBe(71);
  });

  it('holds when the stage has not been held for its minimum days', () => {
    const verdict = review({ today: '2026-08-04' });
    expect(verdict.action).toBe('STAY');
    expect(verdict.reason).toContain('only run 3 of 7');
  });

  it('holds at the top of the ladder instead of inventing a stage', () => {
    const verdict = review({ currentStageIndex: 3 });
    expect(verdict.action).toBe('STAY');
    expect(verdict.toStageIndex).toBe(3);
    expect(verdict.reason).toContain('final stage');
  });

  it('asks rather than advancing when the next step is a big jump', () => {
    const steep: ProgressionStageInput[] = [
      { stageIndex: 0, target: 10, minDays: 7 },
      { stageIndex: 1, target: 30, minDays: 7 },
    ];
    const verdict = review({ stages: steep, currentStageIndex: 0 });
    expect(verdict.action).toBe('ASK_USER');
    expect(verdict.toStageIndex).toBe(1);
    expect(verdict.reason).toContain('big step');
  });
});

describe('reviewProgression backs off when the user is struggling', () => {
  it('proposes a reduction below the reduce threshold', () => {
    const verdict = review({ evidence: evidence({ eligibleCount: 7, completedCount: 2 }) });
    expect(verdict.action).toBe('REDUCE');
    expect(verdict.fromStageIndex).toBe(1);
    expect(verdict.toStageIndex).toBe(0);
    expect(verdict.reason).toContain('Dropping back to 15');
  });

  it('does not reduce below the first stage', () => {
    const verdict = review({
      currentStageIndex: 0,
      evidence: evidence({ eligibleCount: 7, completedCount: 1 }),
    });
    expect(verdict.action).toBe('STAY');
    expect(verdict.reason).toContain('easiest stage');
  });

  it('refuses to conclude anything from one or two days', () => {
    const verdict = review({ evidence: evidence({ eligibleCount: 2, completedCount: 0 }) });
    expect(verdict.action).toBe('STAY');
    expect(verdict.reason).toContain('not enough to judge');
  });

  it('never advances on a perfect rate over too little evidence', () => {
    const verdict = review({ evidence: evidence({ eligibleCount: 2, completedCount: 2 }) });
    expect(verdict.action).toBe('STAY');
  });
});

describe('helpers the UI reads', () => {
  it('numbers stages from one for display', () => {
    expect(stageLabel(1, 4)).toBe('Stage 2 of 4');
  });

  it('finds a stage by index and returns null outside the ladder', () => {
    expect(stageAt(ladder, 2)?.target).toBe(25);
    expect(stageAt(ladder, 9)).toBeNull();
  });

  it('reviews an unknown current stage as a hold rather than throwing', () => {
    const verdict = review({ currentStageIndex: 9 });
    expect(verdict.action).toBe('STAY');
    expect(verdict.reason).toContain('no current stage');
  });

  // These reasons are shown to the user word for word, so they have to read like
  // English rather than like a template.
  it('writes reasons without a plural placeholder', () => {
    const reasons = [
      review({ evidence: evidence({ eligibleCount: 0, completedCount: 0 }) }),
      review({ evidence: evidence({ eligibleCount: 1, completedCount: 1 }) }),
      review({ evidence: evidence({ eligibleCount: 7, completedCount: 7 }) }),
      review({ evidence: evidence({ eligibleCount: 7, completedCount: 2 }) }),
      review({ today: '2026-08-05', evidence: evidence({ eligibleCount: 4, completedCount: 4 }) }),
    ].map((v) => v.reason);

    for (const reason of reasons) expect(reason).not.toContain('(s)');
    expect(reasons[0]).toBe('No scheduled days at this stage yet — nothing to judge.');
    expect(reasons[1]).toContain('Only 1 day scheduled so far');
    expect(reasons[2]).toContain('over 7 days at 20');
    expect(reasons[4]).toContain('only run 4 of 7 days');
  });
});

// This block is the security boundary. `reviewProgression` says what should
// happen; `authorizeAction` says whether what was *asked* may happen. The Copilot,
// a scheduled job and a button click all arrive here, and none of them may talk a
// plan into advancing while completion is poor.
describe('authorizeAction', () => {
  const struggling = review({ evidence: evidence({ eligibleCount: 7, completedCount: 3 }) });
  const earned = review();
  const asked = review({
    stages: [
      { stageIndex: 0, target: 10, minDays: 7 },
      { stageIndex: 1, target: 30, minDays: 7 },
    ],
    currentStageIndex: 0,
  });

  it('refuses a Copilot advance when the review says reduce', () => {
    const auth = authorizeAction({ action: 'ADVANCE', source: 'COPILOT' }, struggling);
    expect(auth.allowed).toBe(false);
    expect(auth.toStageIndex).toBe(struggling.fromStageIndex);
    expect(auth.refusal).toContain('can only suggest');
  });

  it('refuses a Copilot reduce too — a suggestion is not a decision', () => {
    const auth = authorizeAction({ action: 'REDUCE', source: 'COPILOT' }, earned);
    expect(auth.allowed).toBe(false);
  });

  // The one that matters for milestone 12. Agreement is what makes a Copilot
  // proposal worth showing someone; it is not permission to act. If the model
  // could apply whatever the review already concluded, "the AI never changes your
  // goal on its own" would be false the moment the two happened to line up.
  it('refuses a Copilot advance even when the review agrees', () => {
    const auth = authorizeAction({ action: 'ADVANCE', source: 'COPILOT' }, earned);
    expect(auth.allowed).toBe(false);
    expect(auth.toStageIndex).toBe(earned.fromStageIndex);
    expect(auth.refusal).toContain("the user's decision");
  });

  it('cannot be talked into applying by claiming the user confirmed it', () => {
    const auth = authorizeAction(
      { action: 'ADVANCE', source: 'COPILOT', userConfirmed: true },
      earned,
    );
    expect(auth.allowed).toBe(false);
  });

  it('refuses a system advance the numbers do not support', () => {
    const auth = authorizeAction({ action: 'ADVANCE', source: 'SYSTEM' }, struggling);
    expect(auth.allowed).toBe(false);
    expect(auth.refusal).toContain('not supported by the numbers');
  });

  it('allows a system advance the review itself reached', () => {
    const auth = authorizeAction({ action: 'ADVANCE', source: 'SYSTEM' }, earned);
    expect(auth.allowed).toBe(true);
    expect(auth.toStageIndex).toBe(2);
  });

  it('refuses an unconfirmed user advance at a poor completion rate', () => {
    const auth = authorizeAction({ action: 'ADVANCE', source: 'USER' }, struggling);
    expect(auth.allowed).toBe(false);
    expect(auth.refusal).toContain('explicit confirmation');
  });

  it('allows a user to insist on advancing once they confirm', () => {
    const auth = authorizeAction(
      { action: 'ADVANCE', source: 'USER', userConfirmed: true },
      struggling,
    );
    expect(auth.allowed).toBe(true);
    expect(auth.toStageIndex).toBe(struggling.fromStageIndex + 1);
  });

  it('always lets a user make a plan easier', () => {
    const auth = authorizeAction({ action: 'REDUCE', source: 'USER' }, earned);
    expect(auth.allowed).toBe(true);
    expect(auth.toStageIndex).toBe(earned.fromStageIndex - 1);
  });

  it('settles an ASK_USER proposal in the direction the user answers', () => {
    const yes = authorizeAction(
      { action: 'ADVANCE', source: 'USER', userConfirmed: true },
      asked,
    );
    expect(yes).toMatchObject({ allowed: true, toStageIndex: 1 });

    const no = authorizeAction({ action: 'STAY', source: 'USER' }, asked);
    expect(no).toMatchObject({ allowed: true, toStageIndex: 0 });
  });

  it('treats STAY and ASK_USER as no-ops from any source', () => {
    for (const source of ['SYSTEM', 'USER', 'COPILOT'] as const) {
      expect(authorizeAction({ action: 'STAY', source }, struggling)).toMatchObject({
        allowed: true,
        toStageIndex: struggling.fromStageIndex,
      });
      expect(authorizeAction({ action: 'ASK_USER', source }, earned)).toMatchObject({
        allowed: true,
        toStageIndex: earned.fromStageIndex,
      });
    }
  });
});
