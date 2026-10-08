package com.studyos.assessment;

import static org.junit.jupiter.api.Assertions.*;
import java.util.List;
import org.junit.jupiter.api.Test;

class SyllabusParserTest {
    @Test void extractsWeeksObjectivesAndReadings(){String text="Week 1 - Reliability\nCRC\nLearning objective: detect burst errors\nReading: Chapter 3\nWeek 2: Coordination\nLeader Election";List<SyllabusParser.Unit> units=SyllabusParser.parse(text);assertEquals(2,units.size());assertEquals(1,units.getFirst().weekNumber());assertTrue(units.getFirst().topics().contains("CRC"));assertFalse(units.getFirst().learningObjectives().isEmpty());assertFalse(units.getFirst().requiredReadings().isEmpty());}
    @Test void extractsAssessmentDatesAndWeights(){var values=SyllabusParser.assessments("Midterm exam: 2026-10-14 (35%)\nFinal exam 12/18/2026 45%");assertEquals(2,values.size());assertEquals(35d,values.getFirst().weightPercent());assertEquals(java.time.LocalDate.of(2026,12,18),values.get(1).date());}
}
