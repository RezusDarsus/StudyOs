package com.studyos.adaptive;

/**
 * Pure cognitive-ladder decision. Given the ladder state for one topic and the outcome of one
 * attempt, it decides which level the next activity should sit at and states why in plain language.
 *
 * <p>The rules are deliberately deterministic: promotion needs repeated unaided success, repeated
 * failure at an applied level triggers a diagnostic descent rather than a blind step down, and a
 * failed diagnostic hands over to prerequisite remediation.
 */
public final class DifficultyLadder {
    public static final Settings DEFAULTS = new Settings(2, 2, .85, .35, CognitiveLevel.L3_APPLY, 2, 4);

    private DifficultyLadder() {}

    public enum Outcome {
        SUCCESS, PARTIAL, FAILURE;
        public static Outcome of(double score, Settings settings) {
            if (score >= settings.successThreshold()) return SUCCESS;
            return score >= settings.partialThreshold() ? PARTIAL : FAILURE;
        }
    }

    /** Where a topic enters the ladder when it has no recorded ladder state yet. */
    public static CognitiveLevel startingLevel(double effectiveMastery, int evidenceCount) {
        if (evidenceCount <= 0) return CognitiveLevel.L2_UNDERSTAND;
        double mastery = Math.max(0, Math.min(1, effectiveMastery));
        if (mastery >= .9) return CognitiveLevel.L6_NOVEL;
        if (mastery >= .8) return CognitiveLevel.L5_COMBINE;
        if (mastery >= .65) return CognitiveLevel.L4_ANALYZE;
        if (mastery >= .5) return CognitiveLevel.L3_APPLY;
        if (mastery >= .3) return CognitiveLevel.L2_UNDERSTAND;
        return CognitiveLevel.L1_RECALL;
    }

    public static Decision decide(State state, Attempt attempt, Context context) {
        return decide(state, attempt, context, DEFAULTS);
    }

    public static Decision decide(State state, Attempt attempt, Context context, Settings settings) {
        Outcome outcome = Outcome.of(attempt.score(), settings);
        CognitiveLevel level = state.level() == null ? CognitiveLevel.lowest() : state.level();
        CognitiveLevel ceiling = context.ceiling() == null ? CognitiveLevel.highest() : context.ceiling();
        if (state.diagnosticPending()) return afterDiagnostic(state, level, outcome, context);
        if (outcome == Outcome.SUCCESS) return afterSuccess(state, attempt, level, ceiling, context, settings);
        if (outcome == Outcome.PARTIAL) return decision(LadderAction.HOLD, level, state.returnLevel(), 0, state.consecutiveFailure(), false, context,
                "Partly correct at " + level.label() + " — staying at this level until the reasoning is complete.");
        return afterFailure(state, level, context, settings);
    }

    private static Decision afterSuccess(State state, Attempt attempt, CognitiveLevel level, CognitiveLevel ceiling, Context context, Settings settings) {
        if (attempt.supportLevelUsed() >= settings.supportGateLevel())
            return decision(LadderAction.HOLD, level, state.returnLevel(), 0, 0, false, context,
                    "Correct, but only with near-solution support — repeating " + level.label() + " unaided before moving up.");
        int successes = state.consecutiveSuccess() + 1;
        if (successes < settings.promoteAfter())
            return decision(LadderAction.HOLD, level, state.returnLevel(), successes, 0, false, context,
                    "Correct at " + level.label() + " — one more unaided success promotes this topic.");
        if (level.rank() >= ceiling.rank())
            return decision(LadderAction.HOLD, level, state.returnLevel(), successes, 0, false, context,
                    "Already working at " + level.label() + " — consolidating here instead of escalating further.");
        CognitiveLevel next = level.up();
        return decision(LadderAction.PROMOTE, next, null, 0, 0, false, context,
                settings.promoteAfter() + " unaided successes at " + level.label() + " — moving up to " + next.label() + ".");
    }

    private static Decision afterFailure(State state, CognitiveLevel level, Context context, Settings settings) {
        int failures = state.consecutiveFailure() + 1;
        if (failures < settings.demoteAfter())
            return decision(LadderAction.HOLD, level, state.returnLevel(), 0, failures, false, context,
                    "First miss at " + level.label() + " — retrying at the same level from a different angle.");
        if (level.rank() >= settings.diagnosticFloor().rank()) {
            CognitiveLevel probe = level.shift(-settings.diagnosticDrop());
            return decision(LadderAction.DIAGNOSE, probe, level, 0, 0, true, context,
                    failures + " misses at " + level.label() + " — dropping to " + probe.label()
                            + " to find what is actually missing before returning to " + level.label() + ".");
        }
        if (level.rank() <= CognitiveLevel.lowest().rank())
            return decision(LadderAction.HOLD, level, state.returnLevel(), 0, failures, false, context,
                    "Still missing at " + level.label() + " — re-explaining this differently before testing again.");
        CognitiveLevel next = level.down();
        return decision(LadderAction.DEMOTE, next, state.returnLevel(), 0, 0, false, context,
                failures + " misses at " + level.label() + " — stepping down to " + next.label() + " to rebuild the basics.");
    }

    private static Decision afterDiagnostic(State state, CognitiveLevel level, Outcome outcome, Context context) {
        CognitiveLevel returnLevel = state.returnLevel() == null ? level.up() : state.returnLevel();
        if (outcome == Outcome.SUCCESS)
            return decision(LadderAction.RESUME_AFTER_DIAGNOSTIC, returnLevel, null, 0, 0, false, context,
                    "Diagnostic passed at " + level.label() + " — returning to " + returnLevel.label() + ".");
        if (context.weakPrerequisiteAvailable())
            return decision(LadderAction.REMEDIATE_PREREQUISITE, level, returnLevel, 0, 0, false, context,
                    "The diagnostic at " + level.label() + " also failed — teaching the weakest prerequisite first, then returning to "
                            + returnLevel.label() + ".");
        if (level.rank() <= CognitiveLevel.lowest().rank())
            return decision(LadderAction.HOLD, level, returnLevel, 0, 0, false, context,
                    "The diagnostic at " + level.label() + " failed and there is no weaker prerequisite to fall back on — re-teaching this from scratch.");
        CognitiveLevel next = level.down();
        return decision(LadderAction.DEMOTE, next, returnLevel, 0, 0, false, context,
                "The diagnostic at " + level.label() + " failed with no weaker prerequisite recorded — rebuilding at " + next.label() + ".");
    }

    private static Decision decision(LadderAction action, CognitiveLevel level, CognitiveLevel returnLevel, int successes, int failures,
                                     boolean diagnosticPending, Context context, String reason) {
        return new Decision(action, level, returnLevel, successes, failures, diagnosticPending,
                level.difficultyFor(context.effectiveMastery()), reason);
    }

    public record State(CognitiveLevel level, CognitiveLevel returnLevel, int consecutiveSuccess, int consecutiveFailure,
                        int attempts, boolean diagnosticPending) {
        public static State fresh(CognitiveLevel level) { return new State(level, null, 0, 0, 0, false); }
    }

    public record Attempt(double score, int supportLevelUsed) {
        public Attempt(double score) { this(score, 0); }
    }

    public record Context(double effectiveMastery, CognitiveLevel ceiling, boolean weakPrerequisiteAvailable) {}

    public record Decision(LadderAction action, CognitiveLevel level, CognitiveLevel returnLevel, int consecutiveSuccess,
                           int consecutiveFailure, boolean diagnosticPending, double difficulty, String reason) {}

    /**
     * @param promoteAfter       unaided successes required to move up one level
     * @param demoteAfter        consecutive misses that trigger a descent
     * @param successThreshold   score counted as a full success
     * @param partialThreshold   score counted as partially correct rather than a miss
     * @param diagnosticFloor    lowest level at which a miss triggers a diagnostic instead of a plain step down
     * @param diagnosticDrop     how many levels the diagnostic probe drops
     * @param supportGateLevel   support rung from which a success no longer counts toward promotion
     */
    public record Settings(int promoteAfter, int demoteAfter, double successThreshold, double partialThreshold,
                           CognitiveLevel diagnosticFloor, int diagnosticDrop, int supportGateLevel) {}
}
