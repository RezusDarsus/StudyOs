package com.studyos.tutor;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Turns what a workspace should study next into a single ordered study session: a sequence of steps,
 * each with a length, a plain-language reason, and a target cognitive level, plus an honest estimate
 * of where the session leaves the student's readiness.
 *
 * <p>The class is pure and deterministic. It knows nothing about databases, AI, or any subject; it
 * only shapes an already-chosen set of focus topics into the teaching arc StudyOS follows — build
 * intuition, formalise, show it working, check, practise with support, remove the support, and push
 * to exam level — while respecting the diagnostic-then-prerequisite loop and the time available.
 */
public final class TutorSessionPlanner {
    /** Below this effective mastery a topic is treated as not yet understood. Mirrors the graph bar. */
    public static final double MASTERY_BAR = .6;
    /** Below this evidence confidence an apparently-strong mastery gets a confirmation step first. */
    public static final double CONFIRMATION_BAR = .45;
    /** A topic with essentially no evidence starts from the very beginning of the arc. */
    private static final double COLD_MASTERY = .3;
    /** Readiness weight carried by concept mastery, matching ReadinessCalculator's mastery term. */
    private static final double MASTERY_SHARE = .40;
    /** How much a single session is ever allowed to claim it moves overall readiness. */
    private static final double MAX_SESSION_GAIN = .15;
    private static final double MAX_READINESS = .98;

    private TutorSessionPlanner() {}

    public static Session plan(Request request) {
        Settings settings = request.settings() == null ? Settings.DEFAULTS : request.settings();
        int budget = Math.max(settings.minimumMinutes(), Math.min(settings.maximumMinutes(), request.availableMinutes()));
        double totalRelevanceWeight = Math.max(1e-9, request.totalRelevanceWeight());
        List<Step> steps = new ArrayList<>();
        double projectedReadiness = clamp(request.currentReadiness());
        int used = 0;
        int ordinal = 0;

        for (Focus focus : request.focus()) {
            if (used >= budget) break;
            List<Draft> arc = arc(focus, settings);
            double topicShare = Math.max(.05, focus.examRelevance()) / totalRelevanceWeight;
            double mastery = clamp(focus.effectiveMastery());
            for (Draft draft : arc) {
                if (used > 0 && used + draft.minutes() > budget) continue; // keep filling smaller steps
                double before = mastery;
                mastery = clamp(mastery + draft.kind().learningWeight() * (1 - mastery));
                double gain = Math.min(MAX_SESSION_GAIN, (mastery - before) * topicShare * MASTERY_SHARE);
                projectedReadiness = clamp(Math.min(MAX_READINESS, projectedReadiness + gain));
                steps.add(new Step(ordinal++, draft.kind(), focus.topicId(), focus.lessonId(), draft.title(), draft.why(),
                        draft.minutes(), draft.targetLevel(), draft.difficulty()));
                used += draft.minutes();
                if (used >= budget) break;
            }
        }

        if (steps.isEmpty() && !request.focus().isEmpty()) {
            Focus focus = request.focus().get(0);
            Draft draft = arc(focus, settings).get(0);
            steps.add(new Step(0, draft.kind(), focus.topicId(), focus.lessonId(), draft.title(), draft.why(),
                    Math.min(budget, draft.minutes()), draft.targetLevel(), draft.difficulty()));
            used = steps.get(0).minutes();
        }

        return new Session(steps, used, clamp(request.currentReadiness()), projectedReadiness);
    }

    /** The teaching arc for one focus topic, chosen from the state it is currently in. */
    private static List<Draft> arc(Focus focus, Settings settings) {
        List<Draft> arc = new ArrayList<>();
        String topic = focus.title();
        int level = clampLevel(focus.currentLevel());
        int target = Math.max(level, clampLevel(focus.targetLevel()));
        double mastery = clamp(focus.effectiveMastery());

        // The diagnostic-then-prerequisite loop always takes precedence: find and repair the gap first.
        if (focus.diagnosticPending())
            arc.add(new Draft(TutorStepKind.DIAGNOSTIC, "Diagnostic on " + topic,
                    "Locate exactly what is missing under " + topic + " before returning to it.", level, difficulty(level, mastery)));
        if (focus.remediationTitle() != null && !focus.remediationTitle().isBlank()) {
            arc.add(new Draft(TutorStepKind.REMEDIATE_PREREQUISITE, "Repair prerequisite: " + focus.remediationTitle(),
                    focus.remediationTitle() + " is holding " + topic + " back — rebuild it first.", Math.max(1, level - 1), difficulty(level - 1, 0)));
            arc.add(new Draft(TutorStepKind.GUIDED_PRACTICE, "Guided practice: " + topic,
                    "Return to " + topic + " with support now that the prerequisite is back in place.", level, difficulty(level, mastery)));
            return arc;
        }

        if (focus.reviewDue() && mastery >= MASTERY_BAR) {
            arc.add(new Draft(TutorStepKind.REVIEW, "Review " + topic,
                    "Spaced review so " + topic + " is not quietly forgotten before the exam.", level, difficulty(level, mastery)));
            return arc;
        }

        if (mastery < COLD_MASTERY || focus.currentLevel() <= 1) {
            arc.add(new Draft(TutorStepKind.LEARN, "Learn " + topic,
                    "Build intuition for " + topic + ", then pin down the formal definition.", Math.min(2, target), difficulty(2, mastery)));
            arc.add(new Draft(TutorStepKind.WORKED_EXAMPLE, "Worked example: " + topic,
                    "See " + topic + " used step by step on an example from the material.", Math.min(3, target), difficulty(3, mastery)));
            arc.add(new Draft(TutorStepKind.RECALL_CHECK, "Quick check: " + topic,
                    "A short question to confirm the idea of " + topic + " landed.", Math.min(2, target), difficulty(2, mastery)));
            arc.add(new Draft(TutorStepKind.GUIDED_PRACTICE, "Guided practice: " + topic,
                    "First problem on " + topic + " with the opening hint already in view.", Math.min(3, target), difficulty(3, mastery)));
            return arc;
        }

        if (mastery < MASTERY_BAR) {
            arc.add(new Draft(TutorStepKind.PRACTICE, "Practice " + topic,
                    "Work " + topic + " at " + levelLabel(level) + " until it is steady.", level, difficulty(level, mastery)));
            arc.add(new Draft(TutorStepKind.EXERCISE, "Exercise: " + topic,
                    "An unaided " + topic + " problem — hints only if you ask, one step at a time.", level, difficulty(level, mastery)));
            if (target > level && settings.pushToTarget())
                arc.add(new Draft(TutorStepKind.EXAM_STYLE, "Exam-style: " + topic,
                        "Stretch " + topic + " toward " + levelLabel(target) + " with a transformed problem.", target, difficulty(target, mastery)));
            return arc;
        }

        // Held well enough: consolidate and push to the exam-level target.
        // High mastery but thin evidence is a different state: confirm it independently before pushing
        // the demand up. Confidence below .45 means the mastery figure rests on too little graded work.
        if (focus.confidence() != null && focus.confidence() < CONFIRMATION_BAR) {
            arc.add(new Draft(TutorStepKind.EXERCISE, "Confirm " + topic,
                    topic + " looks strong but the evidence is thin (" + Math.round(focus.confidence() * 100)
                            + "% confidence) — one more independent answer before pushing harder.", level, difficulty(level, mastery)));
            return arc;
        }
        arc.add(new Draft(TutorStepKind.EXERCISE, "Exercise: " + topic,
                "Confirm " + topic + " is still solid with an unaided problem.", level, difficulty(level, mastery)));
        arc.add(new Draft(TutorStepKind.EXAM_STYLE, "Exam-style: " + topic,
                "A transformed, exam-level " + topic + " problem of the kind an examiner would set.", target, difficulty(target, mastery)));
        return arc;
    }

    private static double difficulty(int level, double mastery) {
        int bounded = clampLevel(level);
        double lower = (bounded - 1) / 6.0;
        double upper = bounded / 6.0;
        return round(lower + (upper - lower) * clamp(mastery));
    }

    private static String levelLabel(int level) {
        return switch (clampLevel(level)) {
            case 1 -> "recall"; case 2 -> "understanding"; case 3 -> "applying it";
            case 4 -> "analysis"; case 5 -> "combining concepts"; default -> "exam level";
        };
    }

    private static int clampLevel(int level) { return Math.max(1, Math.min(6, level)); }
    private static double clamp(double value) { return Math.max(0, Math.min(1, value)); }
    private static double round(double value) { return Math.round(value * 1000) / 1000.0; }

    private record Draft(TutorStepKind kind, String title, String why, int targetLevel, double difficulty) {
        int minutes() { return kind.defaultMinutes(); }
    }

    /**
     * One focus topic and everything the planner needs to shape its arc.
     *
     * @param currentLevel the cognitive level the ladder currently sits at (1..6)
     * @param targetLevel  the level the curriculum wants this topic taken to (1..6)
     * @param confidence   how much graded evidence stands behind the mastery figure; null when unmeasured
     */
    public record Focus(UUID topicId, UUID lessonId, String title, double effectiveMastery, double examRelevance,
                        int currentLevel, int targetLevel, boolean diagnosticPending, UUID remediationTopicId,
                        String remediationTitle, boolean reviewDue, Double confidence) {
        /** Compat constructor for callers that do not track confidence yet. */
        public Focus(UUID topicId, UUID lessonId, String title, double effectiveMastery, double examRelevance,
                     int currentLevel, int targetLevel, boolean diagnosticPending, UUID remediationTopicId,
                     String remediationTitle, boolean reviewDue) {
            this(topicId, lessonId, title, effectiveMastery, examRelevance, currentLevel, targetLevel,
                    diagnosticPending, remediationTopicId, remediationTitle, reviewDue, null);
        }
    }

    /**
     * @param focus                focus topics already in teaching order (frontier first)
     * @param totalRelevanceWeight sum of exam relevance across every topic in the workspace, so each
     *                             topic's projected mastery gain is scaled to its share of readiness
     */
    public record Request(List<Focus> focus, int availableMinutes, double currentReadiness,
                          double totalRelevanceWeight, Settings settings) {}

    public record Step(int ordinal, TutorStepKind kind, UUID topicId, UUID lessonId, String title, String why,
                       int minutes, int targetLevel, double difficulty) {}

    public record Session(List<Step> steps, int totalMinutes, double readinessBefore, double readinessProjected) {}

    /**
     * @param minimumMinutes floor on the session length
     * @param maximumMinutes ceiling on the session length
     * @param pushToTarget   whether a not-yet-mastered topic still gets an exam-style stretch step
     */
    public record Settings(int minimumMinutes, int maximumMinutes, boolean pushToTarget) {
        public static final Settings DEFAULTS = new Settings(10, 180, true);
    }
}
