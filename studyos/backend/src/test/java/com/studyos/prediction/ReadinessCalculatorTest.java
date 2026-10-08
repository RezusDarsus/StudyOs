package com.studyos.prediction;

import static org.junit.jupiter.api.Assertions.assertTrue;
import java.util.List;
import org.junit.jupiter.api.Test;

class ReadinessCalculatorTest {
    @Test void improvesWithMasteryCoverageAndRetention(){var low=ReadinessCalculator.calculate(List.of(new ReadinessCalculator.Topic(.35,.9,.45,0)),1);var high=ReadinessCalculator.calculate(List.of(new ReadinessCalculator.Topic(.8,.9,.9,3)),0);assertTrue(high.readiness()>low.readiness());}
    @Test void unresolvedMisconceptionsReduceReadiness(){var topics=List.of(new ReadinessCalculator.Topic(.8,.8,.9,3));assertTrue(ReadinessCalculator.calculate(topics,0).readiness()>ReadinessCalculator.calculate(topics,3).readiness());}
}
