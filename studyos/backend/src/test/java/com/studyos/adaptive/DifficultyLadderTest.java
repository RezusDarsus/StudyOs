package com.studyos.adaptive;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

/**
 * The ladder is what makes StudyOS control difficulty rather than react to it. The behaviour that
 * matters is the shape of the response to repeated failure: at an applied level a second miss must
 * drop to a diagnostic and remember where to return, not blindly hand out an easier question.
 */
class DifficultyLadderTest {
    private static final DifficultyLadder.Context MIDDLING = new DifficultyLadder.Context(.5, null, false);

    @Test void oneUnaidedSuccessHoldsAndTheSecondPromotes() {
        DifficultyLadder.State fresh = DifficultyLadder.State.fresh(CognitiveLevel.L3_APPLY);
        DifficultyLadder.Decision first = DifficultyLadder.decide(fresh, new DifficultyLadder.Attempt(1), MIDDLING);
        assertThat(first.action()).isEqualTo(LadderAction.HOLD);
        assertThat(first.level()).isEqualTo(CognitiveLevel.L3_APPLY);
        assertThat(first.consecutiveSuccess()).isEqualTo(1);

        DifficultyLadder.Decision second = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L3_APPLY, null, 1, 0, 1, false), new DifficultyLadder.Attempt(1), MIDDLING);
        assertThat(second.action()).isEqualTo(LadderAction.PROMOTE);
        assertThat(second.level()).isEqualTo(CognitiveLevel.L4_ANALYZE);
        assertThat(second.consecutiveSuccess()).isZero();
    }

    @Test void aSuccessLeaningOnNearSolutionSupportDoesNotCountTowardPromotion() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L3_APPLY, null, 1, 0, 3, false), new DifficultyLadder.Attempt(1, 4), MIDDLING);
        assertThat(decision.action()).isEqualTo(LadderAction.HOLD);
        assertThat(decision.level()).isEqualTo(CognitiveLevel.L3_APPLY);
        assertThat(decision.consecutiveSuccess()).isZero();
        assertThat(decision.reason()).contains("unaided");
    }

    @Test void aPartialAnswerHoldsTheLevelAndClearsTheSuccessRun() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L4_ANALYZE, null, 1, 0, 4, false), new DifficultyLadder.Attempt(.5), MIDDLING);
        assertThat(decision.action()).isEqualTo(LadderAction.HOLD);
        assertThat(decision.level()).isEqualTo(CognitiveLevel.L4_ANALYZE);
        assertThat(decision.consecutiveSuccess()).isZero();
        assertThat(decision.consecutiveFailure()).isZero();
    }

    @Test void theFirstMissRetriesTheSameLevel() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                DifficultyLadder.State.fresh(CognitiveLevel.L4_ANALYZE), new DifficultyLadder.Attempt(.1), MIDDLING);
        assertThat(decision.action()).isEqualTo(LadderAction.HOLD);
        assertThat(decision.level()).isEqualTo(CognitiveLevel.L4_ANALYZE);
        assertThat(decision.consecutiveFailure()).isEqualTo(1);
        assertThat(decision.diagnosticPending()).isFalse();
    }

    @Test void repeatedFailureAtAnAppliedLevelDiagnosesInsteadOfSteppingDown() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L4_ANALYZE, null, 0, 1, 5, false), new DifficultyLadder.Attempt(.1), MIDDLING);
        assertThat(decision.action()).isEqualTo(LadderAction.DIAGNOSE);
        assertThat(decision.diagnosticPending()).isTrue();
        assertThat(decision.level()).isEqualTo(CognitiveLevel.L2_UNDERSTAND);
        assertThat(decision.returnLevel()).isEqualTo(CognitiveLevel.L4_ANALYZE);
    }

    @Test void repeatedFailureBelowTheDiagnosticFloorJustStepsDown() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L2_UNDERSTAND, null, 0, 1, 5, false), new DifficultyLadder.Attempt(0), MIDDLING);
        assertThat(decision.action()).isEqualTo(LadderAction.DEMOTE);
        assertThat(decision.level()).isEqualTo(CognitiveLevel.L1_RECALL);
        assertThat(decision.diagnosticPending()).isFalse();
    }

    @Test void theLowestLevelIsReExplainedRatherThanDemotedFurther() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L1_RECALL, null, 0, 1, 5, false), new DifficultyLadder.Attempt(0), MIDDLING);
        assertThat(decision.action()).isEqualTo(LadderAction.HOLD);
        assertThat(decision.level()).isEqualTo(CognitiveLevel.L1_RECALL);
    }

    @Test void aPassedDiagnosticReturnsToTheLevelThatFailed() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L2_UNDERSTAND, CognitiveLevel.L4_ANALYZE, 0, 0, 6, true),
                new DifficultyLadder.Attempt(1), MIDDLING);
        assertThat(decision.action()).isEqualTo(LadderAction.RESUME_AFTER_DIAGNOSTIC);
        assertThat(decision.level()).isEqualTo(CognitiveLevel.L4_ANALYZE);
        assertThat(decision.diagnosticPending()).isFalse();
    }

    @Test void aFailedDiagnosticTeachesThePrerequisiteWhenThereIsOne() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L2_UNDERSTAND, CognitiveLevel.L4_ANALYZE, 0, 0, 6, true),
                new DifficultyLadder.Attempt(.1), new DifficultyLadder.Context(.4, null, true));
        assertThat(decision.action()).isEqualTo(LadderAction.REMEDIATE_PREREQUISITE);
        assertThat(decision.returnLevel()).isEqualTo(CognitiveLevel.L4_ANALYZE);
    }

    @Test void aFailedDiagnosticWithNoPrerequisiteRebuildsLower() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L3_APPLY, CognitiveLevel.L5_COMBINE, 0, 0, 6, true),
                new DifficultyLadder.Attempt(.1), MIDDLING);
        assertThat(decision.action()).isEqualTo(LadderAction.DEMOTE);
        assertThat(decision.level()).isEqualTo(CognitiveLevel.L2_UNDERSTAND);
        assertThat(decision.returnLevel()).isEqualTo(CognitiveLevel.L5_COMBINE);
    }

    @Test void aCeilingConsolidatesInsteadOfEscalatingPastIt() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L3_APPLY, null, 1, 0, 4, false), new DifficultyLadder.Attempt(1),
                new DifficultyLadder.Context(.7, CognitiveLevel.L3_APPLY, false));
        assertThat(decision.action()).isEqualTo(LadderAction.HOLD);
        assertThat(decision.level()).isEqualTo(CognitiveLevel.L3_APPLY);
    }

    @Test void anUnseenTopicStartsWhereItCanBeTaughtNotWhereItCanBeTested() {
        assertThat(DifficultyLadder.startingLevel(0, 0)).isEqualTo(CognitiveLevel.L2_UNDERSTAND);
        assertThat(DifficultyLadder.startingLevel(.95, 0)).isEqualTo(CognitiveLevel.L2_UNDERSTAND);
    }

    @Test void aRecordedMasteryPlacesTheTopicOnTheLadder() {
        assertThat(DifficultyLadder.startingLevel(.05, 3)).isEqualTo(CognitiveLevel.L1_RECALL);
        assertThat(DifficultyLadder.startingLevel(.35, 3)).isEqualTo(CognitiveLevel.L2_UNDERSTAND);
        assertThat(DifficultyLadder.startingLevel(.55, 3)).isEqualTo(CognitiveLevel.L3_APPLY);
        assertThat(DifficultyLadder.startingLevel(.7, 3)).isEqualTo(CognitiveLevel.L4_ANALYZE);
        assertThat(DifficultyLadder.startingLevel(.85, 3)).isEqualTo(CognitiveLevel.L5_COMBINE);
        assertThat(DifficultyLadder.startingLevel(.95, 3)).isEqualTo(CognitiveLevel.L6_NOVEL);
    }

    @Test void everyDecisionCarriesADifficultyInsideItsOwnLevelBand() {
        DifficultyLadder.Decision decision = DifficultyLadder.decide(
                new DifficultyLadder.State(CognitiveLevel.L3_APPLY, null, 1, 0, 2, false), new DifficultyLadder.Attempt(1), MIDDLING);
        assertThat(decision.difficulty())
                .isBetween(decision.level().lowerDifficulty(), decision.level().upperDifficulty());
    }

    @Test void everyDecisionExplainsItselfToTheStudent() {
        DifficultyLadder.State[] states = {
                DifficultyLadder.State.fresh(CognitiveLevel.L3_APPLY),
                new DifficultyLadder.State(CognitiveLevel.L4_ANALYZE, null, 0, 1, 5, false),
                new DifficultyLadder.State(CognitiveLevel.L2_UNDERSTAND, CognitiveLevel.L4_ANALYZE, 0, 0, 6, true)};
        for (DifficultyLadder.State state : states)
            for (double score : new double[] {1, .5, 0})
                assertThat(DifficultyLadder.decide(state, new DifficultyLadder.Attempt(score), MIDDLING).reason())
                        .as("reason for %s at score %s", state.level(), score).isNotBlank();
    }
}
