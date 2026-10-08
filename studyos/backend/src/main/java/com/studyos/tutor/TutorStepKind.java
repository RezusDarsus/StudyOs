package com.studyos.tutor;

import com.studyos.assessment.ActivityKind;
import java.util.Locale;
import java.util.Objects;

/**
 * The kinds of step a tutor session can contain. Together they cover the teaching sequence StudyOS
 * follows: build intuition, formalise it, show it working, check recall, practise with support, take
 * the support away, and finally push to the level an examiner would set.
 *
 * <p>Each kind carries a default length, how much of the remaining gap one step of it is expected to
 * close, and — when the step is something the student answers — the activity kind that decides how
 * much support is allowed and how strongly the result counts as evidence.
 */
public enum TutorStepKind {
    /** Spaced retest of something learned earlier, so it is not quietly forgotten. */
    REVIEW("Review", 5, .10, ActivityKind.QUIZ),
    /** Teach the prerequisite that is holding a later idea back, before returning to it. */
    REMEDIATE_PREREQUISITE("Repair prerequisite", 12, .22, null),
    /** Probe below the failing level to find what is actually missing. */
    DIAGNOSTIC("Diagnostic", 6, .05, ActivityKind.QUIZ),
    /** Intuitive explanation followed by the formal definition. */
    LEARN("Learn", 10, .22, null),
    /** Walk through an example from the material, step by step. */
    WORKED_EXAMPLE("Worked example", 8, .15, null),
    /** A short conceptual question that checks the idea landed. */
    RECALL_CHECK("Recall check", 4, .08, ActivityKind.PRACTICE),
    /** First attempt with the opening hint already visible. */
    GUIDED_PRACTICE("Guided practice", 10, .14, ActivityKind.GUIDED_PRACTICE),
    /** Straightforward practice at the level the ladder currently sits at. */
    PRACTICE("Practice", 8, .12, ActivityKind.PRACTICE),
    /** Unaided exercise, with support only released one rung at a time on request. */
    EXERCISE("Independent exercise", 12, .18, ActivityKind.INDEPENDENT_EXERCISE),
    /** A transformed problem of the kind an examiner would set. */
    EXAM_STYLE("Exam-style problem", 18, .20, ActivityKind.CHECKPOINT),
    /** Unaided check that a whole stretch of the curriculum is actually held. */
    CHECKPOINT("Checkpoint", 15, .10, ActivityKind.CHECKPOINT);

    private final String label;
    private final int defaultMinutes;
    private final double learningWeight;
    private final ActivityKind activityKind;

    TutorStepKind(String label, int defaultMinutes, double learningWeight, ActivityKind activityKind) {
        this.label = label;
        this.defaultMinutes = defaultMinutes;
        this.learningWeight = learningWeight;
        this.activityKind = activityKind;
    }

    public String label() { return label; }
    public int defaultMinutes() { return defaultMinutes; }

    /** Share of the remaining gap one step of this kind is expected to close when it goes well. */
    public double learningWeight() { return learningWeight; }

    /** How the answer is graded, or null when the step is something to read rather than answer. */
    public ActivityKind activityKind() { return activityKind; }

    /** True when the step produces an answer that can be graded and recorded as evidence. */
    public boolean graded() { return activityKind != null; }

    /** True when hints may be requested during the step at all. */
    public boolean supportAllowed() { return activityKind != null && activityKind.supportAllowed(); }

    public static TutorStepKind of(String value) { return of(value, PRACTICE); }

    public static TutorStepKind of(String value, TutorStepKind fallback) {
        String normalized = Objects.toString(value, "").trim().toUpperCase(Locale.ROOT).replace(' ', '_').replace('-', '_');
        for (TutorStepKind kind : values()) if (kind.name().equals(normalized)) return kind;
        return fallback;
    }
}
