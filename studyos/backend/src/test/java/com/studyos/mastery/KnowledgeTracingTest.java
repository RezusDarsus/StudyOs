package com.studyos.mastery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import org.junit.jupiter.api.Test;

class KnowledgeTracingTest {
    @Test void aCorrectAnswerRaisesTheEstimateAndAWrongOneLowersIt() {
        assertThat(KnowledgeTracing.update(.5, 1, .5, 0).known()).isGreaterThan(.5);
        assertThat(KnowledgeTracing.update(.5, 0, .5, 0).known()).isLessThan(.5);
    }

    /**
     * The point of the model. A correct answer to a trivial item is explainable by guessing, so it is weaker
     * evidence than the same answer to a demanding one.
     */
    @Test void aCorrectAnswerToAGuessableItemIsWeakerEvidenceThanToADemandingOne() {
        double easy = KnowledgeTracing.update(.4, 1, .05, 0).known();
        double hard = KnowledgeTracing.update(.4, 1, .95, 0).known();
        assertThat(easy).isLessThan(hard);
    }

    /** And the other half of it: a topic proved many times over survives one careless mistake. */
    @Test void oneWrongAnswerDoesNotEraseAWellEstablishedTopic() {
        double after = KnowledgeTracing.update(.95, 0, .9, 0).known();
        assertThat(after).isLessThan(.95).isGreaterThan(.3);
    }

    /** An answer produced after the next step was handed over is much more explainable without knowing. */
    @Test void helpUsedDiscountsWhatACorrectAnswerProves() {
        double unaided = KnowledgeTracing.update(.4, 1, .5, 0).known();
        double hinted = KnowledgeTracing.update(.4, 1, .5, 1).known();
        double handedOver = KnowledgeTracing.update(.4, 1, .5, 3).known();
        assertThat(handedOver).isLessThan(hinted);
        assertThat(hinted).isLessThan(unaided);
        assertThat(KnowledgeTracing.update(.4, 1, .5, 9).known()).isEqualTo(handedOver);
    }

    /** Partial credit is read as partly each, so a half-marked answer moves the estimate between the two. */
    @Test void aPartlyCorrectAnswerLandsBetweenTheTwoOutcomes() {
        double correct = KnowledgeTracing.update(.5, 1, .5, 0).known();
        double wrong = KnowledgeTracing.update(.5, 0, .5, 0).known();
        double half = KnowledgeTracing.update(.5, .5, .5, 0).known();
        assertThat(half).isBetween(wrong, correct);
        assertThat(KnowledgeTracing.update(.5, 1, .5, 0).posterior()).isCloseTo(KnowledgeTracing.update(.5, 1.4, .5, 0).posterior(), within(.0000001));
    }

    /**
     * An absorbing state would stop the model learning: at exactly one, no wrong answer could ever move the
     * estimate again, and the learner's next mistake would be invisible.
     */
    @Test void theEstimateNeverReachesCertaintyInEitherDirection() {
        double known = .5;
        for (int attempt = 0; attempt < 60; attempt++) known = KnowledgeTracing.update(known, 1, .9, 0).known();
        assertThat(known).isLessThan(1).isGreaterThan(.9);
        assertThat(KnowledgeTracing.update(known, 0, .9, 0).known()).isLessThan(known);
        double unknown = .5;
        for (int attempt = 0; attempt < 60; attempt++) unknown = KnowledgeTracing.update(unknown, 0, .1, 0).known();
        assertThat(unknown).isGreaterThan(0);
        assertThat(KnowledgeTracing.update(unknown, 1, .1, 0).known()).isGreaterThan(unknown);
    }

    /** Attempting a topic with feedback is itself practice, so a wrong answer still leaves room to have learnt. */
    @Test void anAttemptCountsAsPracticeAsWellAsEvidence() {
        var estimate = KnowledgeTracing.update(.3, 0, .5, 0);
        assertThat(estimate.known()).isGreaterThan(estimate.posterior());
        assertThat(estimate.change()).isEqualTo(estimate.known() - .3);
    }

    @Test void guessFallsWithDifficultyAndSlipRises() {
        assertThat(KnowledgeTracing.guess(0, 0)).isGreaterThan(KnowledgeTracing.guess(1, 0));
        assertThat(KnowledgeTracing.slip(1)).isGreaterThan(KnowledgeTracing.slip(0));
        for (double difficulty : new double[] {-1, 0, .5, 1, 4}) {
            assertThat(KnowledgeTracing.guess(difficulty, 0)).isBetween(.01, .99);
            assertThat(KnowledgeTracing.slip(difficulty)).isBetween(.01, .99);
        }
    }

    /** A topic with no attempt reports the prior, and no caller may present it as a measurement. */
    @Test void anUnassessedTopicCarriesThePriorAndNoEvidence() {
        var unassessed = KnowledgeTracing.unassessed();
        assertThat(unassessed.known()).isEqualTo(KnowledgeTracing.PRIOR_KNOWN).isLessThan(.5);
        assertThat(unassessed.change()).isZero();
    }

    /** Sustained correct work on hard items must actually get a topic to confident, not asymptote low. */
    @Test void repeatedEarnedSuccessReachesConfidence() {
        double known = KnowledgeTracing.PRIOR_KNOWN;
        for (int attempt = 0; attempt < 5; attempt++) known = KnowledgeTracing.update(known, 1, .7, 0).known();
        assertThat(known).isGreaterThan(.9);
    }

    @Test void nonsenseInputsFallBackRatherThanPropagating() {
        assertThat(KnowledgeTracing.update(Double.NaN, 1, .5, 0).known()).isBetween(.01, .99);
        assertThat(KnowledgeTracing.update(0, 1, .5, 0).known()).isGreaterThan(0);
        assertThat(KnowledgeTracing.update(1, 0, .5, 0).known()).isLessThan(1);
    }
}
