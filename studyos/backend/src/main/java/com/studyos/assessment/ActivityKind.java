package com.studyos.assessment;

import java.util.Locale;
import java.util.Objects;

/**
 * The kinds of activity StudyOS can put in front of a student. They differ in how much support is
 * allowed while answering and how strongly the result counts as mastery evidence: a checkpoint or a
 * mock exam says more about what the student can do alone than a guided practice item does.
 */
public enum ActivityKind {
    PRACTICE("Practice", true, 0, 1.0),
    GUIDED_PRACTICE("Guided practice", true, 1, .7),
    INDEPENDENT_EXERCISE("Independent exercise", true, 0, 1.0),
    QUIZ("Quiz", false, 0, 1.05),
    CHECKPOINT("Checkpoint", false, 0, 1.15),
    MOCK_EXAM("Mock exam", false, 0, 1.25),
    FINAL_ASSESSMENT("Final assessment", false, 0, 1.35);

    private final String label;
    private final boolean supportAllowed;
    private final int openingSupportLevel;
    private final double evidenceMultiplier;

    ActivityKind(String label, boolean supportAllowed, int openingSupportLevel, double evidenceMultiplier) {
        this.label = label;
        this.supportAllowed = supportAllowed;
        this.openingSupportLevel = openingSupportLevel;
        this.evidenceMultiplier = evidenceMultiplier;
    }

    public String label() { return label; }
    /** Whether hints may be requested at all while the activity is open. */
    public boolean supportAllowed() { return supportAllowed; }
    /** Support shown before the student starts — guided practice opens with the first hint. */
    public int openingSupportLevel() { return openingSupportLevel; }
    /** How strongly a graded result of this kind counts as evidence. */
    public double evidenceMultiplier() { return evidenceMultiplier; }
    /** Higher-stakes activities are the ones worth reporting as readiness evidence. */
    public boolean highStakes() { return evidenceMultiplier >= QUIZ.evidenceMultiplier; }

    public static ActivityKind of(String value) { return of(value, PRACTICE); }
    public static ActivityKind of(String value, ActivityKind fallback) {
        String normalized = Objects.toString(value, "").trim().toUpperCase(Locale.ROOT).replace(' ', '_').replace('-', '_');
        for (ActivityKind kind : values()) if (kind.name().equals(normalized)) return kind;
        return fallback;
    }
}
