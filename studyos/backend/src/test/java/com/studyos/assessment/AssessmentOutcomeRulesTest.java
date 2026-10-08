package com.studyos.assessment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class AssessmentOutcomeRulesTest {
    @Test void preservesPartialCredit(){assertEquals("PARTIALLY_CORRECT",AssessmentOutcomeRules.correctness(.65,"expected"));assertEquals("EXERCISE_PARTIAL",AssessmentOutcomeRules.eventType("PARTIALLY_CORRECT"));}
    @Test void refusesToGradeWithoutExpectedAnswer(){assertEquals("UNSUPPORTED",AssessmentOutcomeRules.correctness(.9,null));assertEquals("UNSUPPORTED",AssessmentOutcomeRules.errorType("anything","UNSUPPORTED"));}
    @Test void normalizesStableErrorCodes(){assertEquals("MISSED_INVARIANT",AssessmentOutcomeRules.errorType("missed invariant","INCORRECT"));assertEquals("NONE",AssessmentOutcomeRules.errorType("wrong arithmetic","CORRECT"));}
}
