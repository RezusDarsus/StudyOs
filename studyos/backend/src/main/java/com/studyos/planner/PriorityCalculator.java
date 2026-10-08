package com.studyos.planner;

import java.util.ArrayList;
import java.util.List;

/** Pure, configured priority calculation for a single study topic. */
public final class PriorityCalculator {
    private PriorityCalculator() {}

    public static Result calculate(Input input, Weights weights) {
        double examGap = weights.examGap() * input.relevance() * (1 - input.effectiveMastery());
        double reviewUrgency = weights.reviewUrgency() * (input.reviewDue() ? 1 : input.retention() < .65 ? .55 : 0);
        double misconception = weights.misconception() * input.misconception();
        double recentFailure = weights.recentFailure() * input.recentFailure();
        double prerequisite = weights.prerequisiteGap() * input.prerequisiteGap();
        double deadline = weights.deadline() * (input.daysUntilExam() <= 14 ? Math.min(1, Math.max(0, (15 - Math.max(0, input.daysUntilExam())) / 15.0)) : 0);
        double value = Math.min(1, examGap + reviewUrgency + misconception + recentFailure + prerequisite + deadline);
        String action = input.misconception() >= .6 ? "REVIEW_MISTAKE" : input.effectiveMastery() < .35 ? "LEARN" : input.relevance() >= .75 && input.effectiveMastery() >= .7 ? "EXAM_STYLE_TEST" : (input.reviewDue() || input.retention() < .65) ? "REVIEW" : "PRACTICE";
        List<String> codes = new ArrayList<>();
        if (input.relevance() >= .7) codes.add("HIGH_EXAM_RELEVANCE");
        if (input.effectiveMastery() < .6) codes.add("LOW_MASTERY");
        if (input.misconception() >= .5) codes.add("ACTIVE_MISCONCEPTION");
        if (input.reviewDue() || input.retention() < .65) codes.add("REVIEW_DUE");
        if (input.evidenceConfidence() < .5) codes.add("LOW_EVIDENCE_CONFIDENCE");
        if (input.prerequisiteGap() > 0) codes.add("PREREQUISITE_GAP");
        if (input.daysUntilExam() <= 14) codes.add("EXAM_DEADLINE");
        return new Result(value, action, List.copyOf(codes), examGap, reviewUrgency, misconception, recentFailure, prerequisite, deadline);
    }

    public record Input(double relevance, double effectiveMastery, double retention, double evidenceConfidence,
                        double misconception, double recentFailure, double prerequisiteGap, boolean reviewDue,
                        long daysUntilExam) {}
    public record Weights(double examGap, double reviewUrgency, double misconception, double recentFailure,
                          double prerequisiteGap, double deadline) {}
    public record Result(double value, String action, List<String> reasonCodes, double examGap,
                         double reviewUrgency, double misconception, double recentFailure,
                         double prerequisite, double deadline) {}
}
