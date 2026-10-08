package com.studyos.planner;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import org.junit.jupiter.api.Test;

class PriorityCalculatorTest {
    private static final PriorityCalculator.Weights WEIGHTS = new PriorityCalculator.Weights(.40, .20, .15, .10, .10, .05);

    @Test void preservesCompositePriorityAndReasons() {
        var result = PriorityCalculator.calculate(new PriorityCalculator.Input(.8, .5, .6, .4, .2, .3, .4, false, 10), WEIGHTS);
        assertThat(result.value()).isCloseTo(.38666666666666666, within(0.0000001));
        assertThat(result.action()).isEqualTo("REVIEW");
        assertThat(result.reasonCodes()).containsExactly("HIGH_EXAM_RELEVANCE", "LOW_MASTERY", "REVIEW_DUE", "LOW_EVIDENCE_CONFIDENCE", "PREREQUISITE_GAP", "EXAM_DEADLINE");
    }

    @Test void misconceptionTakesPriorityOverOtherActions() {
        var result = PriorityCalculator.calculate(new PriorityCalculator.Input(.9, .1, .9, .9, .6, 0, 0, false, 30), WEIGHTS);
        assertThat(result.action()).isEqualTo("REVIEW_MISTAKE");
    }

    @Test void lowMasterySelectsLearn() {
        var result = PriorityCalculator.calculate(new PriorityCalculator.Input(.2, .34, .9, .9, 0, 0, 0, false, 30), WEIGHTS);
        assertThat(result.action()).isEqualTo("LEARN");
    }

    @Test void doesNotAddDeadlineOutsideConfiguredWindow() {
        var result = PriorityCalculator.calculate(new PriorityCalculator.Input(1, 0, .1, 0, 1, 1, 1, true, 15), WEIGHTS);
        assertThat(result.value()).isCloseTo(.95, within(.0000001));
        assertThat(result.reasonCodes()).doesNotContain("EXAM_DEADLINE");
    }
}
