package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The verification budget and what a turn says when it hits it. The recorded 80-prompt run has a generated-exercise
 * turn spending 21 upstream attempts across 271 seconds under a 240-second budget, then answering with a generic
 * fallback: batches, their parse retries and the adversarial audit multiplied together with nothing bounding the
 * product, and the work already done was thrown away. These tests hold the two halves of the fix — a shared
 * ceiling on calls, and counts that keep "never checked" apart from "checked and rejected".
 *
 * <p>Nothing here mentions a subject. A call budget, a clock and three counters are the same for a networking
 * exercise, a proof, a translation drill or a case analysis.
 */
class ExamPredictionBudgetTest {
    private static ExamPredictionVerificationService.PredictionDiagnostics diagnostics(int unverified, int unaudited, String budgetStop) {
        return new ExamPredictionVerificationService.PredictionDiagnostics(6, 0, 0, 0, 0, 4, 1_200, List.of(), 0, 0,
                new ExamPredictionVerificationService.GateExecution(true, true, true, true, true, true), unverified, unaudited, budgetStop);
    }

    /** One call with no second opinion is not verification, so even a single candidate is allowed two. */
    @Test void theBudgetNeverFallsBelowOnePassAndItsSecondOpinion() {
        assertThat(ExamPredictionVerificationService.verifierCallBudget(0)).isEqualTo(2);
        assertThat(ExamPredictionVerificationService.verifierCallBudget(1)).isEqualTo(2);
        assertThat(ExamPredictionVerificationService.verifierCallBudget(3)).isEqualTo(2);
        assertThat(ExamPredictionVerificationService.verifierCallBudget(-4)).isEqualTo(2);
    }

    @Test void theBudgetGrowsWithTheBatchesThereActuallyAre() {
        assertThat(ExamPredictionVerificationService.verifierCallBudget(4)).isEqualTo(4);
        assertThat(ExamPredictionVerificationService.verifierCallBudget(6)).isEqualTo(4);
        assertThat(ExamPredictionVerificationService.verifierCallBudget(7)).isEqualTo(6);
    }

    /** The ceiling is what stops the multiplication; past it a turn keeps what it has instead of asking again. */
    @Test void theBudgetIsCappedNoMatterHowManyCandidatesWereGenerated() {
        for (int candidates = 0; candidates <= 200; candidates++)
            assertThat(ExamPredictionVerificationService.verifierCallBudget(candidates))
                    .describedAs("budget for %s candidates", candidates)
                    .isBetween(2, ExamPredictionVerificationService.VERIFIER_CALL_CEILING);
        assertThat(ExamPredictionVerificationService.verifierCallBudget(200)).isEqualTo(ExamPredictionVerificationService.VERIFIER_CALL_CEILING);
    }

    @Test void moreCandidatesNeverBuyFewerCalls() {
        int previous = 0;
        for (int candidates = 0; candidates <= 60; candidates++) {
            int budget = ExamPredictionVerificationService.verifierCallBudget(candidates);
            assertThat(budget).describedAs("budget for %s candidates", candidates).isGreaterThanOrEqualTo(previous);
            previous = budget;
        }
    }

    /** A turn that finished every check it started is not truncated, and must not claim to be. */
    @Test void aCompletedVerificationReportsNothingMissing() {
        var complete = diagnostics(0, 0, null);
        assertThat(complete.truncated()).isFalse();
        assertThat(complete.budgetStop()).isNull();
    }

    /**
     * Unchecked and unaudited each make a turn truncated on their own. A candidate nobody looked at, and a
     * candidate only one verifier looked at, are both facts the reply owes the learner — a stop reason is not the
     * only way verification can come up short.
     */
    @Test void anyUnfinishedCheckMakesTheTurnTruncated() {
        assertThat(diagnostics(2, 0, null).truncated()).isTrue();
        assertThat(diagnostics(0, 3, null).truncated()).isTrue();
        assertThat(diagnostics(0, 0, "BUDGET: verification stopped after 6 verifier calls (cap 6)").truncated()).isTrue();
    }

    /** The first stop is the one that explains the turn; a later stage must not overwrite the reason. */
    @Test void theRecordedStopReasonIsTheFirstOneAndSurvivesLaterStages() {
        var stopped = diagnostics(0, 1, "BUDGET: verification stopped after 6 verifier calls (cap 6)");
        assertThat(stopped.withBudgetStop("DEADLINE: generation stopped at the repair pass").budgetStop())
                .isEqualTo("BUDGET: verification stopped after 6 verifier calls (cap 6)");
        assertThat(diagnostics(0, 0, null).withBudgetStop(null).budgetStop()).isNull();
        assertThat(diagnostics(0, 0, null).withBudgetStop("DEADLINE: generation stopped at verification").budgetStop())
                .isEqualTo("DEADLINE: generation stopped at verification");
    }

    /** Adding a stop reason may not disturb any measurement already recorded. */
    @Test void recordingAStopKeepsEveryOtherCountIntact() {
        var before = diagnostics(1, 2, null);
        var after = before.withBudgetStop("DEADLINE: generation stopped at verification");
        assertThat(after.candidateCount()).isEqualTo(before.candidateCount());
        assertThat(after.verifierCalls()).isEqualTo(before.verifierCalls());
        assertThat(after.unverifiedCandidates()).isEqualTo(before.unverifiedCandidates());
        assertThat(after.unauditedCandidates()).isEqualTo(before.unauditedCandidates());
        assertThat(after.totalLatencyMs()).isEqualTo(before.totalLatencyMs());
        assertThat(after.gates()).isEqualTo(before.gates());
    }

    /** A gate that never ran reads as unrun, so a stopped turn can never be mistaken for a clean one. */
    @Test void noGateCountsAsRunUntilItHasRun() {
        var none = ExamPredictionVerificationService.GateExecution.none();
        assertThat(List.of(none.structural(), none.scope(), none.citation(), none.similarity(), none.localNovelty(), none.verifier()))
                .containsOnly(false);
    }
}
