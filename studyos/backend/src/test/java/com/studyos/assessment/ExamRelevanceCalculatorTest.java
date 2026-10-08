package com.studyos.assessment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import org.junit.jupiter.api.Test;

class ExamRelevanceCalculatorTest {
    @Test void preservesExistingFairnessRelevanceCalculation() {
        var result = ExamRelevanceCalculator.calculate(new ExamRelevanceCalculator.Input(2, 80, 3, 1, 0, 2, 0, 0, 2, 230, 27, 0, 6, 3));
        assertThat(result.relevance()).isCloseTo(.47402576489533005, within(.0000001));
        assertThat(result.confidence()).isCloseTo(.6, within(.0000001));
    }

    @Test void hasNoEvidenceFallbackForEmptyTopic() {
        var result = ExamRelevanceCalculator.calculate(new ExamRelevanceCalculator.Input(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1));
        assertThat(result.relevance()).isZero();
        assertThat(result.confidence()).isEqualTo(.2);
    }
}
