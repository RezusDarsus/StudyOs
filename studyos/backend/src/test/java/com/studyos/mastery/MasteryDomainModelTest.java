package com.studyos.mastery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.junit.jupiter.api.Test;

class MasteryDomainModelTest {
    @Test void betaEvidenceUpdatePreservesMasteryAndConfidenceFormula() {
        var result = BetaEvidenceModel.update(new BetaEvidenceModel.State(2, 2, 0), 1, 2);
        assertThat(result.alpha()).isEqualTo(4);
        assertThat(result.beta()).isEqualTo(2);
        assertThat(result.mastery()).isCloseTo(2.0 / 3, within(.0000001));
        assertThat(result.confidence()).isCloseTo(1.0 / 9, within(.0000001));
        assertThat(result.reviewDays()).isEqualTo(5);
    }

    @Test void betaEvidenceClampsScoreAndDifficulty() {
        var result = BetaEvidenceModel.update(new BetaEvidenceModel.State(2, 2, 0), 3, 9);
        assertThat(result.boundedScore()).isEqualTo(1);
        assertThat(result.weight()).isEqualTo(2);
    }

    @Test void betaEvidenceClampsNegativeScoreAndDifficulty() {
        var result = BetaEvidenceModel.update(new BetaEvidenceModel.State(2, 2, 0), -1, -2);
        assertThat(result.boundedScore()).isZero();
        assertThat(result.weight()).isEqualTo(.5);
    }

    /**
     * Retention follows the scheduling model's forgetting curve, so the assertion is what that curve promises:
     * nine tenths recalled exactly one stability later, and never a reading of nothing however long it has been.
     * A year-old topic that was well established is still mostly retained — the floor is for the weakly held.
     */
    @Test void retentionDecaysAtTheTopicsOwnRateWithoutDroppingBelowFloor() {
        Instant now = Instant.parse("2026-08-14T00:00:00Z");
        double stability = 10;
        assertThat(RetentionModel.retention(now.minus(10, ChronoUnit.DAYS), now, stability)).isCloseTo(.9, within(.0001));
        assertThat(RetentionModel.retention(now.minus(365, ChronoUnit.DAYS), now, stability)).isBetween(.2, .4);
        assertThat(RetentionModel.retention(now.minus(365, ChronoUnit.DAYS), now, 1)).isEqualTo(.2);
        assertThat(RetentionModel.retention(now.minus(1, ChronoUnit.HOURS), now, stability)).isGreaterThan(.99);
    }

    /** A topic proved often decays more slowly than one scraped through, which a fixed curve could not express. */
    @Test void aMoreStableTopicIsRetainedBetterThanALessStableOneAtTheSameAge() {
        Instant now = Instant.parse("2026-08-14T00:00:00Z");
        Instant anchor = now.minus(20, ChronoUnit.DAYS);
        assertThat(RetentionModel.retention(anchor, now, 60)).isGreaterThan(RetentionModel.retention(anchor, now, 5));
    }

    /** An unmeasured stability is treated as weakly held rather than as unknown-and-therefore-permanent. */
    @Test void anUnknownStabilityFallsBackToWhatOneAdequateAnswerEarns() {
        Instant now = Instant.parse("2026-08-14T00:00:00Z");
        for (double unusable : new double[] {0, -5, Double.NaN})
            assertThat(RetentionModel.retention(now.minus(7, ChronoUnit.DAYS), now, unusable))
                    .isEqualTo(RetentionModel.retention(now.minus(7, ChronoUnit.DAYS), now, RetentionModel.DEFAULT_STABILITY_DAYS));
    }

    @Test void futureAnchorDoesNotCreateNegativeDecay() {
        Instant now = Instant.parse("2026-08-14T00:00:00Z");
        assertThat(RetentionModel.retention(now.plus(5, ChronoUnit.DAYS), now)).isEqualTo(1);
    }
}
