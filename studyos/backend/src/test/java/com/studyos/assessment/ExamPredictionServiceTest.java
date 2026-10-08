package com.studyos.assessment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class ExamPredictionServiceTest {
    @Test void labelsConfidenceWithoutFalsePrecision(){assertEquals("LOW",ExamPredictionService.confidence(.2));assertEquals("MEDIUM",ExamPredictionService.confidence(.6));assertEquals("HIGH",ExamPredictionService.confidence(.8));}
}
