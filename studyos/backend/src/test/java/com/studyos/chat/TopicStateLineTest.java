package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class TopicStateLineTest {
    /** The failure this wording exists for: an unmeasured topic must never read as a topic that scored badly. */
    @Test void anAbsentMeasurementNeverReadsAsAScore() {
        String line = TopicStateLine.render("Cyclic codes", null, null, .4, null, null);
        assertThat(line).isEqualTo("- Cyclic codes: not yet assessed, exam relevance 40%");
        assertThat(line).doesNotContain("0%,").doesNotContain("mastery");
    }

    /** A measured zero is a measurement, and has to stay distinguishable from the line above. */
    @Test void aMeasuredZeroIsReportedAsAMeasurement() {
        assertThat(TopicStateLine.render("Cyclic codes", 0.0, 0.2, .4, null, null))
                .isEqualTo("- Cyclic codes: mastery 0%, confidence 20%, exam relevance 40%");
    }

    /** Recall answers "could they do this today", which is a different figure from the mastery average. */
    @Test void recallIsReportedBesideTheMasteryAverageWhenItWasMeasured() {
        assertThat(TopicStateLine.render("Parity checks", .62, .33, .8, .41, 3L))
                .isEqualTo("- Parity checks: mastery 62%, confidence 33%, recall now 41%, review due in 3 days, exam relevance 80%");
        assertThat(TopicStateLine.render("Parity checks", .62, .33, .8, null, null))
                .doesNotContain("recall").doesNotContain("review");
    }

    /** Nothing derived from a measurement may be attached to a topic that has none. */
    @Test void aTopicWithNoMasteryCarriesNoDerivedFigures() {
        assertThat(TopicStateLine.render("Parity checks", null, null, null, .41, -6L))
                .isEqualTo("- Parity checks: not yet assessed, exam relevance unknown");
    }

    /** "Due in minus six days" is not something a plan can act on. */
    @Test void anOverdueReviewSaysSo() {
        assertThat(TopicStateLine.render("Burst errors", .5, .5, .5, .3, -6L)).contains("review overdue by 6 days");
        assertThat(TopicStateLine.render("Burst errors", .5, .5, .5, .3, -1L)).contains("review overdue by 1 day");
        assertThat(TopicStateLine.render("Burst errors", .5, .5, .5, .3, 0L)).contains("review due today");
        assertThat(TopicStateLine.render("Burst errors", .5, .5, .5, .3, 1L)).contains("review due in 1 day");
    }

    @Test void missingConfidenceIsSaidRatherThanShownAsZero() {
        assertThat(TopicStateLine.render("Hamming distance", .5, null, .1, null, null))
                .contains("confidence not recorded").doesNotContain("confidence 0%");
    }

    @Test void figuresOutsideTheUnitRangeAreBounded() {
        assertThat(TopicStateLine.render("Generator polynomials", 1.4, -.2, 2.0, 1.1, null))
                .isEqualTo("- Generator polynomials: mastery 100%, confidence 0%, recall now 100%, exam relevance 100%");
    }
}
