package com.studyos.learner;

import java.util.Locale;

/**
 * The kinds of long-term observation StudyOS keeps about a student. Every kind describes how this
 * person learns rather than what they are learning, so the same eleven traits describe a chemistry
 * student, a law student and someone teaching themselves a framework from scratch.
 *
 * <p>Each kind carries a teaching hint: the concrete change a tutor or chat should make when the
 * trait is present. That is what turns the profile from a description into something that acts.
 */
public enum LearnerTraitKind {
    FAST_ACQUISITION("Picks up quickly", Polarity.STRENGTH,
            "move on as soon as it is shown once; skip redundant drill"),
    SLOW_ACQUISITION("Needs more repetition", Polarity.RISK,
            "budget extra repetition and smaller steps before raising difficulty"),
    STRENGTH("Strong area", Polarity.STRENGTH,
            "use as the familiar anchor when introducing something new"),
    WEAKNESS("Weak area", Polarity.RISK,
            "teach from the prerequisites up before pushing difficulty"),
    RECURRING_MISTAKE("Recurring mistake", Polarity.RISK,
            "check explicitly for this error before accepting an answer as correct"),
    SUPPORT_RELIANCE("Leans on hints", Polarity.RISK,
            "hold hints back one extra beat and ask for a first step first"),
    RETENTION_RISK("Forgets between sessions", Polarity.RISK,
            "prefer short spaced reviews over one long session"),
    LEVEL_CEILING("Stalls at this demand level", Polarity.RISK,
            "bridge into this level with a worked example before an independent problem"),
    TASK_AVOIDANCE("Skips the harder steps", Polarity.RISK,
            "keep demanding steps short and say up front what they are for"),
    STUDY_RHYTHM("Study rhythm", Polarity.NEUTRAL,
            "plan around how often this student actually shows up"),
    SESSION_LENGTH("Typical session length", Polarity.NEUTRAL,
            "size a session to the length they finish rather than the length they intend");

    /** Whether the trait is something to build on, something to work around, or neither. */
    public enum Polarity { STRENGTH, RISK, NEUTRAL }

    private final String label;
    private final Polarity polarity;
    private final String teachingHint;

    LearnerTraitKind(String label, Polarity polarity, String teachingHint) {
        this.label = label;
        this.polarity = polarity;
        this.teachingHint = teachingHint;
    }

    public String label() { return label; }
    public Polarity polarity() { return polarity; }

    /** What to do differently when this trait holds. Deliberately free of subject vocabulary. */
    public String teachingHint() { return teachingHint; }

    public boolean strength() { return polarity == Polarity.STRENGTH; }
    public boolean risk() { return polarity == Polarity.RISK; }

    /** True when the trait names a topic; the rest describe behaviour across the whole workspace. */
    public boolean topicScoped() {
        return this == FAST_ACQUISITION || this == SLOW_ACQUISITION || this == STRENGTH
                || this == WEAKNESS || this == RECURRING_MISTAKE;
    }

    public static LearnerTraitKind of(String value) { return of(value, WEAKNESS); }

    public static LearnerTraitKind of(String value, LearnerTraitKind fallback) {
        if (value == null || value.isBlank()) return fallback;
        String normalized = value.trim().toUpperCase(Locale.ROOT);
        for (LearnerTraitKind kind : values()) if (kind.name().equals(normalized)) return kind;
        return fallback;
    }
}
