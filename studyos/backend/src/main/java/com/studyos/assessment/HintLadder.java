package com.studyos.assessment;

/**
 * Pure hint-ladder rules. StudyOS never answers an exercise on request: support is released one rung
 * at a time, the full solution is gated behind real effort, and everything revealed discounts how
 * much mastery evidence the eventual answer is worth.
 */
public final class HintLadder {
    public static final int RUNGS = 5;
    /** Rungs 1..4 are authored hints stored with the item; rung 5 is the reference answer. */
    public static final int HINT_RUNGS = 4;
    private static final double[] EVIDENCE_WEIGHTS = {1, .9, .75, .6, .4, .15};
    private static final int ATTEMPTS_FOR_SOLUTION = 2;

    private HintLadder() {}

    public enum Rung {
        CONCEPTUAL_DIRECTION(1, "Which idea this belongs to"),
        RELEVANT_CONCEPT(2, "The rule or definition it rests on"),
        FIRST_STEP(3, "How to start"),
        PARTIAL_SOLUTION(4, "Most of the way there"),
        SOLUTION(5, "Full worked solution");

        private final int level;
        private final String label;
        Rung(int level, String label) { this.level = level; this.label = label; }
        public int level() { return level; }
        public String label() { return label; }
        public boolean revealsSolution() { return this == SOLUTION; }
    }

    public static Rung rung(int level) {
        int bounded = Math.max(1, Math.min(RUNGS, level));
        for (Rung rung : Rung.values()) if (rung.level == bounded) return rung;
        return Rung.CONCEPTUAL_DIRECTION;
    }

    /**
     * Decides which rung may actually be released. A rung above the next one is never handed out, and a
     * request for the worked solution that has not been earned is answered with the next hint instead,
     * plus the reason the solution is still closed.
     *
     * @param requestedLevel  what the caller asked for
     * @param highestRevealed highest rung already released for this item (0 when nothing was shown)
     * @param gradedAttempts  graded attempts the student has already submitted for this item
     */
    public static Release release(int requestedLevel, int highestRevealed, int gradedAttempts) {
        int requested = Math.max(1, Math.min(RUNGS, requestedLevel));
        int revealed = Math.max(0, Math.min(RUNGS, highestRevealed));
        int attempts = Math.max(0, gradedAttempts);
        if (requested >= RUNGS && (revealed >= HINT_RUNGS || attempts >= ATTEMPTS_FOR_SOLUTION))
            return new Release(RUNGS, Rung.SOLUTION, true, false, null);
        int granted = Math.min(Math.min(requested, revealed + 1), HINT_RUNGS);
        if (requested <= granted) return new Release(granted, rung(granted), false, false, null);
        return new Release(granted, rung(granted), false, true,
                requested >= RUNGS ? solutionGateReason(granted, revealed, attempts) : skipReason(granted));
    }

    private static String solutionGateReason(int granted, int revealed, int attempts) {
        return "The full solution unlocks once all " + HINT_RUNGS + " hints have been used or after " + ATTEMPTS_FOR_SOLUTION
                + " graded attempts — you have used " + revealed + " and made " + attempts + ". Releasing hint " + granted
                + " of " + HINT_RUNGS + " instead.";
    }

    private static String skipReason(int granted) {
        return "Support is released one step at a time — showing hint " + granted + " of " + HINT_RUNGS + " first.";
    }

    /** How much a graded answer still counts as evidence once support has been revealed. */
    public static double evidenceWeight(int highestRevealed) {
        int revealed = Math.max(0, Math.min(RUNGS, highestRevealed));
        return EVIDENCE_WEIGHTS[revealed];
    }

    public record Release(int level, Rung rung, boolean revealsSolution, boolean gated, String gateReason) {}
}
