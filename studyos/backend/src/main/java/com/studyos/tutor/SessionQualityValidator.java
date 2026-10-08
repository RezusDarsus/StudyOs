package com.studyos.tutor;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Pure quality gate for a planned tutor session: the learning arc must be pedagogically coherent
 * before a learner ever sees it. Deterministic, DB-free, testable — the planner stays in charge of
 * building sessions, this class only inspects the result and reports what it finds, with a severity
 * a caller can act on without parsing prose.
 *
 * <p>Findings are findings, not failures: ERROR means the session must not be shown as-is,
 * WARNING means the learner experience is degraded, INFO is context.
 */
public final class SessionQualityValidator {

    private SessionQualityValidator() {}

    public enum Severity { ERROR, WARNING, INFO }

    public record Finding(Severity severity, String code, String message) {}

    /** Structure kinds that demand enough preparation before they are fair to ask. */
    private static final Set<TutorStepKind> HIGH_STAKES =
            Set.of(TutorStepKind.EXAM_STYLE, TutorStepKind.CHECKPOINT);
    /** Preparation that makes a high-stakes step fair on the same topic. */
    private static final Set<TutorStepKind> PREPARATION = Set.of(
            TutorStepKind.LEARN, TutorStepKind.WORKED_EXAMPLE, TutorStepKind.RECALL_CHECK,
            TutorStepKind.GUIDED_PRACTICE, TutorStepKind.PRACTICE, TutorStepKind.EXERCISE, TutorStepKind.REVIEW);
    /** A difficulty jump larger than this between consecutive assessed steps on one topic is a cliff. */
    private static final double MAX_DIFFICULTY_JUMP = .34;

    public static List<Finding> validate(List<TutorSessionPlanner.Step> steps, int budgetMinutes) {
        List<Finding> findings = new ArrayList<>();
        if (steps == null || steps.isEmpty()) return findings;

        int totalMinutes = steps.stream().mapToInt(TutorSessionPlanner.Step::minutes).sum();
        if (totalMinutes > budgetMinutes)
            findings.add(new Finding(Severity.ERROR, "OVER_BUDGET",
                    "The session plans " + totalMinutes + " minutes against a " + budgetMinutes + " minute budget."));

        Set<String> seen = new HashSet<>();
        boolean anyAssessment = false;
        TutorSessionPlanner.Step previousAssessed = null;
        Set<UUID> preparedTopics = new HashSet<>();
        boolean remediationSeen = false;

        for (TutorSessionPlanner.Step step : steps) {
            String key = step.kind() + ":" + step.topicId() + ":" + step.title();
            if (!seen.add(key))
                findings.add(new Finding(Severity.ERROR, "REPEATED_STEP",
                        "Step " + step.ordinal() + " repeats an identical step: " + step.title() + "."));

            boolean assessed = step.kind().activityKind() != null;
            if (assessed) {
                if (previousAssessed != null && previousAssessed.topicId() != null
                        && previousAssessed.topicId().equals(step.topicId())
                        && step.difficulty() - previousAssessed.difficulty() > MAX_DIFFICULTY_JUMP)
                    findings.add(new Finding(Severity.WARNING, "DIFFICULTY_JUMP",
                            "Difficulty jumps from " + previousAssessed.difficulty() + " to " + step.difficulty()
                                    + " between assessed steps on the same topic."));
                if (HIGH_STAKES.contains(step.kind()) && step.topicId() != null && !preparedTopics.contains(step.topicId()))
                    findings.add(new Finding(remediationSeen ? Severity.INFO : Severity.WARNING, "UNPREPARED_ASSESSMENT",
                            "A " + step.kind().label() + " on this topic asks more than the session has prepared for."));
                previousAssessed = step;
                anyAssessment = true;
            }
            if (step.kind() == TutorStepKind.REMEDIATE_PREREQUISITE) remediationSeen = true;
            if (PREPARATION.contains(step.kind()) && step.topicId() != null) preparedTopics.add(step.topicId());
            // A diagnostic always comes first when it is present: the loop depends on finding the gap
            // before practising over it.
            if (step.kind() == TutorStepKind.DIAGNOSTIC && steps.stream().findFirst().orElseThrow() != step)
                findings.add(new Finding(Severity.WARNING, "DIAGNOSTIC_NOT_FIRST",
                        "A diagnostic step works best at the very start of the session."));
        }

        if (!anyAssessment)
            findings.add(new Finding(Severity.INFO, "NO_ASSESSMENT",
                    "The session teaches and explains but never checks anything."));
        TutorSessionPlanner.Step last = steps.get(steps.size() - 1);
        if (last.kind() == TutorStepKind.DIAGNOSTIC)
            findings.add(new Finding(Severity.WARNING, "ENDS_ON_DIAGNOSTIC",
                    "The session ends on a diagnostic — its result is never acted on in this session."));
        return findings;
    }

    /** True when the session may be shown: no finding blocks it. */
    public static boolean showable(List<Finding> findings) {
        return findings.stream().noneMatch(finding -> finding.severity() == Severity.ERROR);
    }
}
