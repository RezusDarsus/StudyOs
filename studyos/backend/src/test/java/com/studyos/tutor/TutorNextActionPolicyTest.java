package com.studyos.tutor;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Table-driven tutor next-action policy: for each learner state, the planned arc must be the
 * pedagogically sensible one. Every row of the table is a state the brief demands the tutor handle
 * deliberately, not accidentally.
 */
class TutorNextActionPolicyTest {

    private TutorSessionPlanner.Focus focus(double mastery, int level, int target, boolean diagnostic,
                                            String remediation, boolean reviewDue, Double confidence) {
        return new TutorSessionPlanner.Focus(UUID.randomUUID(), null, "Sliding Window", mastery, .7,
                level, target, diagnostic, remediation == null ? null : UUID.randomUUID(), remediation, reviewDue, confidence);
    }

    private List<TutorStepKind> plan(TutorSessionPlanner.Focus focus) {
        TutorSessionPlanner.Session session = TutorSessionPlanner.plan(new TutorSessionPlanner.Request(
                List.of(focus), 60, .5, 1.0, TutorSessionPlanner.Settings.DEFAULTS));
        return session.steps().stream().map(TutorSessionPlanner.Step::kind).toList();
    }

    @Test
    void weakPrerequisiteIsRepairedBeforeTheTopicReturns() {
        List<TutorStepKind> kinds = plan(focus(.65, 3, 4, false, "Sequence Numbers", false, .7));
        assertThat(kinds).first().isEqualTo(TutorStepKind.REMEDIATE_PREREQUISITE);
        assertThat(kinds).containsSubsequence(TutorStepKind.REMEDIATE_PREREQUISITE, TutorStepKind.GUIDED_PRACTICE);
        // No exam-style demand in the same breath as remediation.
        assertThat(kinds).doesNotContain(TutorStepKind.EXAM_STYLE);
    }

    @Test
    void aPendingDiagnosticComesBeforeEverythingElse() {
        List<TutorStepKind> kinds = plan(focus(.2, 2, 4, true, null, false, null));
        assertThat(kinds).first().isEqualTo(TutorStepKind.DIAGNOSTIC);
    }

    @Test
    void coldTopicGetsExplanationThenExampleThenGuidedPractice() {
        List<TutorStepKind> kinds = plan(focus(.15, 1, 4, false, null, false, null));
        assertThat(kinds).containsSubsequence(
                TutorStepKind.LEARN, TutorStepKind.WORKED_EXAMPLE, TutorStepKind.RECALL_CHECK, TutorStepKind.GUIDED_PRACTICE);
    }

    @Test
    void lowMasteryGetsPracticeWithSupportThenIndependent() {
        List<TutorStepKind> kinds = plan(focus(.45, 3, 4, false, null, false, .7));
        assertThat(kinds).containsSubsequence(TutorStepKind.PRACTICE, TutorStepKind.EXERCISE);
    }

    @Test
    void heldTopicWithThinEvidenceGetsAConfirmationStepInsteadOfAHarderOne() {
        // Mastery says strong, confidence says "you barely measured this": confirm independently,
        // do not push to exam level on thin evidence.
        List<TutorStepKind> thin = plan(focus(.85, 4, 5, false, null, false, .28));
        assertThat(thin).contains(TutorStepKind.EXERCISE);
        assertThat(thin).doesNotContain(TutorStepKind.EXAM_STYLE);
        List<TutorStepKind> solid = plan(focus(.85, 4, 5, false, null, false, .8));
        assertThat(solid).contains(TutorStepKind.EXAM_STYLE);
    }

    @Test
    void heldTopicWithSolidEvidenceMovesOnToExamStyle() {
        List<TutorStepKind> kinds = plan(focus(.85, 4, 5, false, null, false, .8));
        assertThat(kinds).containsSubsequence(TutorStepKind.EXERCISE, TutorStepKind.EXAM_STYLE);
    }

    @Test
    void reviewDueOnAHeldTopicIsASpacedReviewNotANewLesson() {
        List<TutorStepKind> kinds = plan(focus(.8, 4, 5, false, null, true, .8));
        assertThat(kinds).first().isEqualTo(TutorStepKind.REVIEW);
        assertThat(kinds).hasSize(1);
    }

    @Test
    void aReviewDueTopicBelowTheBarIsNotTreatedAsAReview() {
        // Review of something never really held would be a waste: the low-mastery arc applies.
        List<TutorStepKind> kinds = plan(focus(.4, 3, 4, false, null, true, .6));
        assertThat(kinds).first().isNotEqualTo(TutorStepKind.REVIEW);
    }

    @Test
    void theSessionFitsTheTimeBudget() {
        TutorSessionPlanner.Session session = TutorSessionPlanner.plan(new TutorSessionPlanner.Request(
                List.of(focus(.2, 1, 4, false, null, false, null)), 25, .5, 1.0, TutorSessionPlanner.Settings.DEFAULTS));
        assertThat(session.totalMinutes()).isLessThanOrEqualTo(25);
        assertThat(session.steps()).isNotEmpty();
    }
}
