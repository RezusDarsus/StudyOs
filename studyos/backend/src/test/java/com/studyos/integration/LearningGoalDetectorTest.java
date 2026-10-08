package com.studyos.integration;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

class LearningGoalDetectorTest {
    @Test void offersOptionalActivationForLearningGoals(){assertTrue(LearningGoalDetector.detect("Pass AWS certification","").offerStudyOs());assertTrue(LearningGoalDetector.detect("Improve German", "language practice").learningOriented());}
    @Test void doesNotForceStudyOsForOrdinaryGoals(){assertFalse(LearningGoalDetector.detect("Clean the garage","").offerStudyOs());}
}
