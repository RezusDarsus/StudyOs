package com.studyos.tutor;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class TutorSessionPlannerTest {
    private static final UUID TOPIC = UUID.randomUUID();
    private static final UUID LESSON = UUID.randomUUID();

    private TutorSessionPlanner.Request request(List<TutorSessionPlanner.Focus> focus, int minutes, double readiness) {
        double weight = focus.stream().mapToDouble(f -> Math.max(.05, f.examRelevance())).sum();
        return new TutorSessionPlanner.Request(focus, minutes, readiness, Math.max(1e-9, weight), TutorSessionPlanner.Settings.DEFAULTS);
    }

    private TutorSessionPlanner.Focus focus(double mastery, int current, int target, boolean diagnostic, String remediation, boolean reviewDue) {
        return new TutorSessionPlanner.Focus(TOPIC, LESSON, "Gradient Descent", mastery, .8, current, target, diagnostic, diagnostic ? UUID.randomUUID() : null, remediation, reviewDue);
    }

    @Test
    void aColdTopicStartsFromIntuitionNotAnExamProblem() {
        var session = TutorSessionPlanner.plan(request(List.of(focus(.1, 1, 5, false, null, false)), 60, .3));

        assertThat(session.steps()).isNotEmpty();
        assertThat(session.steps().get(0).kind()).isEqualTo(TutorStepKind.LEARN);
        assertThat(session.steps()).noneMatch(step -> step.kind() == TutorStepKind.EXAM_STYLE);
        assertThat(session.steps().get(0).title()).contains("Gradient Descent");
    }

    @Test
    void aHeldTopicIsPushedTowardExamLevel() {
        var session = TutorSessionPlanner.plan(request(List.of(focus(.85, 4, 6, false, null, false)), 60, .7));

        assertThat(session.steps()).anyMatch(step -> step.kind() == TutorStepKind.EXAM_STYLE);
        assertThat(session.steps()).noneMatch(step -> step.kind() == TutorStepKind.LEARN);
        assertThat(session.steps().stream().mapToInt(TutorSessionPlanner.Step::targetLevel).max().orElse(0)).isEqualTo(6);
    }

    @Test
    void aPendingDiagnosticComesBeforeAnythingElse() {
        var session = TutorSessionPlanner.plan(request(List.of(focus(.4, 4, 5, true, null, false)), 60, .5));

        assertThat(session.steps().get(0).kind()).isEqualTo(TutorStepKind.DIAGNOSTIC);
    }

    @Test
    void aWeakPrerequisiteIsRepairedBeforeReturningWithSupport() {        var focus = new TutorSessionPlanner.Focus(TOPIC, LESSON, "Backpropagation", .35, .9, 4, 5, false, UUID.randomUUID(), "Chain Rule", false);
        var session = TutorSessionPlanner.plan(request(List.of(focus), 60, .5));

        assertThat(session.steps().get(0).kind()).isEqualTo(TutorStepKind.REMEDIATE_PREREQUISITE);
        assertThat(session.steps().get(0).title()).contains("Chain Rule");
        assertThat(session.steps().get(1).kind()).isEqualTo(TutorStepKind.GUIDED_PRACTICE);
    }

    @Test
    void aDueReviewOfAKnownTopicIsJustAReview() {
        var session = TutorSessionPlanner.plan(request(List.of(focus(.8, 4, 5, false, null, true)), 60, .7));

        assertThat(session.steps().get(0).kind()).isEqualTo(TutorStepKind.REVIEW);
    }

    @Test
    void theSessionNeverExceedsTheTimeAvailable() {
        var session = TutorSessionPlanner.plan(request(List.of(
                focus(.1, 1, 5, false, null, false),
                new TutorSessionPlanner.Focus(UUID.randomUUID(), UUID.randomUUID(), "Second Topic", .2, .7, 1, 4, false, null, null, false)), 20, .3));

        assertThat(session.totalMinutes()).isLessThanOrEqualTo(20);
        assertThat(session.steps()).isNotEmpty();
    }

    @Test
    void projectedReadinessRisesButStaysAModestClaim() {
        var session = TutorSessionPlanner.plan(request(List.of(focus(.3, 2, 5, false, null, false)), 120, .6));

        assertThat(session.readinessProjected()).isGreaterThanOrEqualTo(session.readinessBefore());
        assertThat(session.readinessProjected() - session.readinessBefore()).isLessThanOrEqualTo(.15 + 1e-9);
        assertThat(session.readinessProjected()).isLessThanOrEqualTo(.98 + 1e-9);
    }

    @Test
    void withNoFocusTopicsTheSessionIsEmpty() {
        var session = TutorSessionPlanner.plan(request(List.of(), 60, .4));

        assertThat(session.steps()).isEmpty();
        assertThat(session.totalMinutes()).isZero();
        assertThat(session.readinessProjected()).isEqualTo(session.readinessBefore());
    }

    @Test
    void everyStepCarriesAReasonAndAPositiveDuration() {
        var session = TutorSessionPlanner.plan(request(List.of(focus(.45, 3, 5, false, null, false)), 90, .5));

        assertThat(session.steps()).allSatisfy(step -> {
            assertThat(step.why()).isNotBlank();
            assertThat(step.minutes()).isPositive();
            assertThat(step.targetLevel()).isBetween(1, 6);
            assertThat(step.difficulty()).isBetween(0.0, 1.0);
        });
    }

    @Test
    void highExamProbabilityNeverSkipsAWeakPrerequisite() {
        // The spec's own case: exam relevance .9, prerequisite mastery .2 — the prerequisite is
        // still reviewed first, because pedagogical constraints outrank predicted exam weight.
        var prerequisite = new TutorSessionPlanner.Focus(UUID.randomUUID(), UUID.randomUUID(), "Dependency Injection",
                .2, .9, 2, 4, false, null, null, false);
        var dependent = new TutorSessionPlanner.Focus(UUID.randomUUID(), UUID.randomUUID(), "Spring Security",
                .55, .9, 3, 5, false, UUID.randomUUID(), "Dependency Injection", false);
        var session = TutorSessionPlanner.plan(request(List.of(dependent, prerequisite), 60, .4));

        assertThat(session.steps()).isNotEmpty();
        int firstPrerequisiteWork = -1;
        int firstDependentWork = -1;
        for (TutorSessionPlanner.Step step : session.steps()) {
            boolean isRemediation = step.kind() == TutorStepKind.REMEDIATE_PREREQUISITE;
            boolean targetsDependent = "Spring Security".equals(step.title()) || step.title().endsWith("Spring Security");
            if (isRemediation && firstPrerequisiteWork < 0) firstPrerequisiteWork = step.ordinal();
            if (targetsDependent && firstDependentWork < 0) firstDependentWork = step.ordinal();
        }
        assertThat(firstPrerequisiteWork).isGreaterThanOrEqualTo(0);
        if (firstDependentWork >= 0) {
            assertThat(firstPrerequisiteWork).isLessThan(firstDependentWork);
        }
    }
}
