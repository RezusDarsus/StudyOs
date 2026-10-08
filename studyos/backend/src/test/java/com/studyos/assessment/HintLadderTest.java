package com.studyos.assessment;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Hint-ladder contract: one rung at a time, never skipping, the solution earned rather than asked
 * for, idempotent re-requests, and evidence that decays honestly with support used.
 */
class HintLadderTest {

    @Test
    void hintsAreReleasedOneRungAtATime() {
        HintLadder.Release first = HintLadder.release(3, 0, 0);
        assertThat(first.level()).isEqualTo(1);
        assertThat(first.gated()).isTrue();
        HintLadder.Release second = HintLadder.release(2, 1, 0);
        assertThat(second.level()).isEqualTo(2);
        assertThat(second.gated()).isFalse();
        HintLadder.Release fourth = HintLadder.release(4, 3, 0);
        assertThat(fourth.level()).isEqualTo(4);
        assertThat(fourth.rung()).isEqualTo(HintLadder.Rung.PARTIAL_SOLUTION);
    }

    @Test
    void theFullSolutionIsEarnedNotRequested() {
        // Asking for the solution with no hints used: a hint comes instead, with a reason.
        HintLadder.Release premature = HintLadder.release(5, 0, 0);
        assertThat(premature.revealsSolution()).isFalse();
        assertThat(premature.gated()).isTrue();
        assertThat(premature.gateReason()).contains("solution unlocks");
        // After all four authored hints: the solution opens.
        assertThat(HintLadder.release(5, 4, 0).revealsSolution()).isTrue();
        // Or after two graded attempts: effort earns it too.
        assertThat(HintLadder.release(5, 1, 2).revealsSolution()).isTrue();
    }

    @Test
    void repeatedHintRequestsAreIdempotent() {
        HintLadder.Release first = HintLadder.release(2, 1, 0);
        HintLadder.Release repeat = HintLadder.release(2, 1, 0);
        assertThat(repeat.level()).isEqualTo(first.level());
        assertThat(repeat.rung()).isEqualTo(first.rung());
        assertThat(repeat.gated()).isFalse();
    }

    @Test
    void evidenceWeightFallsWithEveryRung() {
        double previous = HintLadder.evidenceWeight(0);
        for (int rung = 1; rung <= HintLadder.RUNGS; rung++) {
            double weight = HintLadder.evidenceWeight(rung);
            assertThat(weight).isLessThan(previous);
            assertThat(weight).isGreaterThan(0);
            previous = weight;
        }
        // The full solution leaves almost no mastery evidence.
        assertThat(HintLadder.evidenceWeight(5)).isLessThanOrEqualTo(.15);
    }

    @Test
    void outOfRangeRequestsAreBoundedNotRejected() {
        assertThat(HintLadder.release(-3, 0, 0).level()).isEqualTo(1);
        assertThat(HintLadder.release(99, 0, 0).level()).isEqualTo(1);
        assertThat(HintLadder.evidenceWeight(42)).isEqualTo(HintLadder.evidenceWeight(HintLadder.RUNGS));
    }

    @Test
    void theRungVocabularyMatchesTheProgressiveContract() {
        assertThat(HintLadder.Rung.CONCEPTUAL_DIRECTION.revealsSolution()).isFalse();
        assertThat(HintLadder.Rung.RELEVANT_CONCEPT.revealsSolution()).isFalse();
        assertThat(HintLadder.Rung.FIRST_STEP.revealsSolution()).isFalse();
        assertThat(HintLadder.Rung.PARTIAL_SOLUTION.revealsSolution()).isFalse();
        assertThat(HintLadder.Rung.SOLUTION.revealsSolution()).isTrue();
        assertThat(HintLadder.HINT_RUNGS).isEqualTo(4);
    }
}
