package com.studyos.tutor;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Builds a dedicated exam-preparation session from the systems that already exist: relevance
 * predictions, mastery, retention, misconceptions and prerequisite state.
 *
 * <p>The output is a single bounded "today" plan whose every block carries machine-readable reason
 * codes, so the learner can always ask "why am I studying this?" and get an answer composed of
 * mastery, exam relevance, review timing and past mistakes — not a bare score. Exam probability
 * influences ordering, never pedagogy: a weak prerequisite still comes first.
 */
public final class ExamModePlanner {

    /** Machine-readable reasons. Learner-facing text is derived from these, never the reverse. */
    public static final String MASTERY_WEAK = "MASTERY_WEAK";
    public static final String EXAM_RELEVANCE_HIGH = "EXAM_RELEVANCE_HIGH";
    public static final String RETENTION_RISK = "RETENTION_RISK";
    public static final String MISCONCEPTION_ACTIVE = "MISCONCEPTION_ACTIVE";
    public static final String PREREQUISITE_GAP = "PREREQUISITE_GAP";
    public static final String EXAM_STRUCTURE_MIX = "EXAM_STRUCTURE_MIX";
    public static final String RECENT_MISTAKE = "RECENT_MISTAKE";

    /** One candidate topic with everything the planner weighs. */
    public record Candidate(UUID topicId, String name, double effectiveMastery, double examRelevance,
                            double misconceptionSeverity, boolean reviewDue, boolean recentFailure,
                            String prerequisiteName, double prerequisiteMastery) {}

    /** One predicted exam question structure, from the historical-exam predictor. */
    public record Structure(String type, double probability) {}

    public record Block(int ordinal, String title, int minutes, UUID topicId,
                        List<String> reasonCodes, String reason) {}

    public record Plan(int budgetMinutes, int totalMinutes, Long daysToExam, List<Block> blocks, String note) {}

    private ExamModePlanner() {}

    public static Plan plan(List<Candidate> candidates, List<Structure> structures, int budgetMinutes, Long daysToExam) {
        int budget = Math.max(20, budgetMinutes);
        List<Block> blocks = new ArrayList<>();
        int ordinal = 0;
        int used = 0;

        List<Candidate> sorted = candidates.stream()
                .sorted((left, right) -> Double.compare(risk(right), risk(left)))
                .toList();

        // 1. Remediation first: an active misconception or a weak prerequisite outranks exam weight.
        Candidate remediation = sorted.stream().filter(ExamModePlanner::needsRemediation).findFirst().orElse(null);
        if (remediation != null) {
            int minutes = slice(budget, .16, used);
            List<String> codes = new ArrayList<>();
            codes.add(remediation.misconceptionSeverity() >= .5 ? MISCONCEPTION_ACTIVE : PREREQUISITE_GAP);
            if (remediation.recentFailure()) codes.add(RECENT_MISTAKE);
            String title = remediation.misconceptionSeverity() >= .5
                    ? remediation.name() + " misconception repair"
                    : remediation.name() + " prerequisite repair (" + remediation.prerequisiteName() + ")";
            blocks.add(new Block(ordinal++, title, minutes, remediation.topicId(), codes,
                    remediation.misconceptionSeverity() >= .5
                            ? "An unresolved misconception on " + remediation.name() + " is active — clear it before exam practice."
                            : remediation.prerequisiteName() + " is still weak and is holding " + remediation.name() + " back."));
            used += minutes;
        }

        // 2. Application on the highest-relevance weak topic.
        Candidate application = sorted.stream()
                .filter(candidate -> candidate.effectiveMastery() < .6 && candidate.examRelevance() >= .5)
                .filter(candidate -> candidate != remediation)
                .findFirst().orElse(null);
        if (application != null && used < budget) {
            int minutes = slice(budget, .20, used);
            List<String> codes = new ArrayList<>();
            if (application.examRelevance() >= .7) codes.add(EXAM_RELEVANCE_HIGH);
            codes.add(MASTERY_WEAK);
            blocks.add(new Block(ordinal++, application.name() + " application", minutes, application.topicId(), codes,
                    application.name() + " is highly exam-relevant but mastery is at " + Math.round(application.effectiveMastery() * 100) + "%."));
            used += minutes;
        }

        // 3. Retrieval check on a due review.
        Candidate retrieval = sorted.stream()
                .filter(candidate -> candidate.reviewDue() && candidate.effectiveMastery() >= .5 && candidate != remediation && candidate != application)
                .findFirst().orElse(null);
        if (retrieval != null && used < budget) {
            int minutes = slice(budget, .11, used);
            blocks.add(new Block(ordinal++, retrieval.name() + " retrieval check", minutes, retrieval.topicId(),
                    List.of(RETENTION_RISK),
                    retrieval.name() + " is due for spaced review before the exam."));
            used += minutes;
        }

        // 4. Mixed exam-style problems shaped by the historical structure prediction.
        if (!sorted.isEmpty() && used < budget && !structures.isEmpty()) {
            int minutes = slice(budget, .32, used);
            String types = structures.stream()
                    .sorted((left, right) -> Double.compare(right.probability(), left.probability()))
                    .limit(3)
                    .map(Structure::type)
                    .reduce((left, right) -> left + ", " + right)
                    .orElse("mixed");
            blocks.add(new Block(ordinal++, "Mixed exam-style problems (" + types + ")", minutes, null,
                    List.of(EXAM_STRUCTURE_MIX),
                    "Historical exams lean toward " + types + " — practise that shape, not invented formats."));
            used += minutes;
        }

        // 5. Retest of the weakest remaining topic.
        Candidate retest = sorted.stream()
                .filter(candidate -> candidate != remediation && candidate != application && candidate != retrieval)
                .filter(candidate -> candidate.effectiveMastery() < .7)
                .findFirst().orElse(null);
        if (retest != null && used < budget) {
            int minutes = slice(budget, .13, used);
            List<String> codes = new ArrayList<>();
            codes.add(MASTERY_WEAK);
            if (retest.examRelevance() >= .7) codes.add(EXAM_RELEVANCE_HIGH);
            blocks.add(new Block(ordinal++, retest.name() + " retest", minutes, retest.topicId(), codes,
                    retest.name() + " stays below the mastery bar — one more pass before the exam."));
            used += minutes;
        }

        // 6. Session summary with a small fixed slice, never the whole remaining budget.
        if (!blocks.isEmpty() && used < budget) {
            int minutes = Math.min(budget - used, 10);
            blocks.add(new Block(ordinal++, "Session summary", minutes, null,
                    List.of(),
                    "Write down what changed today; it is the cheapest retention tool there is."));
            used += minutes;
        }

        String note = blocks.isEmpty()
                ? "Nothing needs exam-mode work right now: no high-relevance gaps, due reviews or weak prerequisites were found."
                : null;
        return new Plan(budget, used, daysToExam, blocks, note);
    }

    private static boolean needsRemediation(Candidate candidate) {
        return candidate.misconceptionSeverity() >= .5
                || (candidate.prerequisiteName() != null && candidate.prerequisiteMastery() < .6);
    }

    /** Risk = exam weight times the knowledge gap, lifted by misconceptions and overdue reviews. */
    private static double risk(Candidate candidate) {
        double risk = candidate.examRelevance() * (1 - candidate.effectiveMastery());
        risk += candidate.misconceptionSeverity() * .15;
        risk += candidate.reviewDue() ? .1 : 0;
        risk += candidate.prerequisiteName() != null && candidate.prerequisiteMastery() < .6 ? .1 : 0;
        return risk;
    }

    private static int slice(int budget, double share, int used) {
        return Math.max(4, Math.min(budget - used, (int) Math.round(budget * share)));
    }
}
