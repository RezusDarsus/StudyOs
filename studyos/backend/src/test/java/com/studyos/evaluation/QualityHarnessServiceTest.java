package com.studyos.evaluation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class QualityHarnessServiceTest {
    @Test void permanentDeterministicFixturesPass(){var report=new QualityHarnessService().run();assertEquals("PASS",report.status());assertEquals(report.total(),report.passed());}
}
