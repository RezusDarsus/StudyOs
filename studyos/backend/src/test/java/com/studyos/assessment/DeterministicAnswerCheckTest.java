package com.studyos.assessment;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The deterministic gate on objectively gradable answers. */
class DeterministicAnswerCheckTest {

    @Test
    void onlyObjectivelyGradableTypesAreHandled() {
        assertTrue(DeterministicAnswerCheck.objectivelyGradable("MULTIPLE_CHOICE"));
        assertTrue(DeterministicAnswerCheck.objectivelyGradable("NUMERIC"));
        assertFalse(DeterministicAnswerCheck.objectivelyGradable("TEXT"));
        assertFalse(DeterministicAnswerCheck.objectivelyGradable("PROOF"));
        assertFalse(DeterministicAnswerCheck.objectivelyGradable(null));
    }

    @Test
    void aMatchingAnswerIsFullCreditWhateverTheModelProposed() {
        assertEquals(1.0, DeterministicAnswerCheck.bound(0.2, true));
        assertEquals(1.0, DeterministicAnswerCheck.bound(1.0, true));
    }

    @Test
    void aMismatchingAnswerCanNeverReachPartialCredit() {
        assertEquals(0.1, DeterministicAnswerCheck.bound(0.95, false));
        assertEquals(0.0, DeterministicAnswerCheck.bound(0.0, false));
    }

    @Test
    void exactMatchesAreRecognisedAcrossSpellingNoise() {
        assertTrue(DeterministicAnswerCheck.matches("Read Committed", "read committed"));
        assertTrue(DeterministicAnswerCheck.matches("  READ  COMMITTED. ", "read committed"));
    }

    @Test
    void numericAnswersMatchByValueNotByString() {
        assertTrue(DeterministicAnswerCheck.matches("0.5", ".50"));
        assertTrue(DeterministicAnswerCheck.matches("1/2", "0.5"));
        assertTrue(DeterministicAnswerCheck.matches("42", " 42.0 "));
        assertFalse(DeterministicAnswerCheck.matches("0.45", "0.5"));
        assertFalse(DeterministicAnswerCheck.matches("1/0", "0"));
        assertFalse(DeterministicAnswerCheck.matches("abc", "1.0"));
    }

    @Test
    void blankOrNullNeverMatches() {
        assertFalse(DeterministicAnswerCheck.matches("", "0.5"));
        assertFalse(DeterministicAnswerCheck.matches(null, "0.5"));
        assertFalse(DeterministicAnswerCheck.matches("42", null));
    }
}
