package com.studyos.tutor;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The session quality gate: an incoherent arc must be caught before a learner sits through it. */
class SessionQualityValidatorTest {

    private TutorSessionPlanner.Step step(int ordinal, TutorStepKind kind, UUID topicId, String title, int minutes, int targetLevel, double difficulty) {
        return new TutorSessionPlanner.Step(ordinal, kind, topicId, null, title, "because", minutes, targetLevel, difficulty);
    }

    @Test
    void aWellFormedSessionProducesNoErrors() {
        UUID topic = UUID.randomUUID();
        List<TutorSessionPlanner.Step> steps = List.of(
                step(0, TutorStepKind.REVIEW, topic, "Review", 5, 3, .5),
                step(1, TutorStepKind.LEARN, topic, "Learn", 10, 2, .35),
                step(2, TutorStepKind.GUIDED_PRACTICE, topic, "Guided", 10, 3, .5),
                step(3, TutorStepKind.EXAM_STYLE, topic, "Exam-style", 18, 5, .8));
        List<SessionQualityValidator.Finding> findings = SessionQualityValidator.validate(steps, 60);
        assertThat(SessionQualityValidator.showable(findings)).isTrue();
        assertThat(findings).isEmpty();
    }

    @Test
    void aRepeatedIdenticalStepIsAnError() {
        UUID topic = UUID.randomUUID();
        List<TutorSessionPlanner.Step> steps = List.of(
                step(0, TutorStepKind.PRACTICE, topic, "Practice", 8, 3, .5),
                step(1, TutorStepKind.PRACTICE, topic, "Practice", 8, 3, .5));
        List<SessionQualityValidator.Finding> findings = SessionQualityValidator.validate(steps, 30);
        assertThat(findings).anyMatch(finding -> finding.severity() == SessionQualityValidator.Severity.ERROR
                && finding.code().equals("REPEATED_STEP"));
        assertThat(SessionQualityValidator.showable(findings)).isFalse();
    }

    @Test
    void anImpossibleDifficultyJumpIsAWarning() {
        UUID topic = UUID.randomUUID();
        List<TutorSessionPlanner.Step> steps = List.of(
                step(0, TutorStepKind.PRACTICE, topic, "Practice", 8, 1, .15),
                step(1, TutorStepKind.EXAM_STYLE, topic, "Exam-style", 18, 6, .9));
        List<SessionQualityValidator.Finding> findings = SessionQualityValidator.validate(steps, 40);
        assertThat(findings).anyMatch(finding -> finding.code().equals("DIFFICULTY_JUMP")
                && finding.severity() == SessionQualityValidator.Severity.WARNING);
    }

    @Test
    void anUnpreparedHighStakesStepIsFlaggedUnlessRemediationCameFirst() {
        UUID topic = UUID.randomUUID();
        List<TutorSessionPlanner.Step> unprepared = List.of(
                step(0, TutorStepKind.EXAM_STYLE, topic, "Exam-style", 18, 5, .8));
        assertThat(SessionQualityValidator.validate(unprepared, 30))
                .anyMatch(finding -> finding.code().equals("UNPREPARED_ASSESSMENT"));
        // After remediation the same shape is acceptable: the gap was the known problem.
        List<TutorSessionPlanner.Step> afterRemediation = List.of(
                step(0, TutorStepKind.REMEDIATE_PREREQUISITE, topic, "Repair", 12, 2, .3),
                step(1, TutorStepKind.EXAM_STYLE, topic, "Exam-style", 18, 5, .8));
        assertThat(SessionQualityValidator.validate(afterRemediation, 40))
                .noneMatch(finding -> finding.code().equals("UNPREPARED_ASSESSMENT")
                        && finding.severity() == SessionQualityValidator.Severity.WARNING);
    }

    @Test
    void overBudgetIsAnErrorAndEndingOnADiagnosticIsAWarning() {
        UUID topic = UUID.randomUUID();
        List<TutorSessionPlanner.Step> overBudget = List.of(
                step(0, TutorStepKind.LEARN, topic, "Learn", 10, 2, .3),
                step(1, TutorStepKind.PRACTICE, topic, "Practice", 8, 3, .5),
                step(2, TutorStepKind.EXAM_STYLE, topic, "Exam-style", 18, 5, .8));
        assertThat(SessionQualityValidator.validate(overBudget, 15))
                .anyMatch(finding -> finding.code().equals("OVER_BUDGET")
                        && finding.severity() == SessionQualityValidator.Severity.ERROR);
        List<TutorSessionPlanner.Step> endsOnDiagnostic = List.of(
                step(0, TutorStepKind.DIAGNOSTIC, topic, "Diagnostic", 6, 2, .3));
        List<SessionQualityValidator.Finding> findings = SessionQualityValidator.validate(endsOnDiagnostic, 30);
        assertThat(findings).anyMatch(finding -> finding.code().equals("ENDS_ON_DIAGNOSTIC"));
    }
}
