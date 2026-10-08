package com.studyos.assessment;

import java.util.LinkedHashMap;
import java.util.Map;

/** Pure relevance calculation from normalised exam-evidence inputs. */
public final class ExamRelevanceCalculator {
    private ExamRelevanceCalculator() {}

    /**
     * The EXAM_TOPIC_V1 weights. Every coefficient is named so backtests can vary one at a time;
     * DEFAULTS is the exact live model, and any other weight set is an experiment that must earn
     * its place through held-out backtesting before it can become a new model version.
     */
    public record Weights(double pastFrequency, double pastPoints, double homeworkFrequency,
                          double lectureCoverage, double professorEmphasisShare, double syllabusImportance,
                          double centrality) {
        public static final Weights V1_DEFAULTS = new Weights(.30, .15, .15, .15, .10, .10, .05);

        public Map<String, Double> asMap() {
            Map<String, Double> map = new LinkedHashMap<>();
            map.put("pastFrequency", pastFrequency);
            map.put("pastPoints", pastPoints);
            map.put("homeworkFrequency", homeworkFrequency);
            map.put("lectureCoverage", lectureCoverage);
            map.put("professorEmphasis", professorEmphasisShare);
            map.put("syllabusImportance", syllabusImportance);
            map.put("centrality", centrality);
            return map;
        }
    }

    public static Result calculate(Input input) {
        return calculate(input, Weights.V1_DEFAULTS);
    }

    public static Result calculate(Input input, Weights weights) {
        double pastFrequency = ratio(input.pastDocuments(), input.totalPastDocuments());
        double pastPoints = input.totalPastPoints() > 0 ? clamp(input.pastPoints() / input.totalPastPoints()) : clamp(input.pastItems() / 5.0);
        double homeworkFrequency = ratio(input.homeworkItems(), input.totalHomeworkItems());
        double lectureCoverage = ratio(input.lectureDocuments(), input.totalLectureDocuments());
        double syllabusImportance = input.syllabusDocuments() > 0 ? 1 : 0;
        double professorEmphasis = clamp(.65 * pastFrequency + .35 * homeworkFrequency);
        double quizFrequency = ratio(input.quizItems(), input.totalQuizItems());
        double recentLectureEmphasis = lectureCoverage;
        double centrality = clamp((double) input.centrality() / Math.max(1, input.maxCentrality()));
        double relevance = clamp(
                weights.pastFrequency() * pastFrequency
                        + weights.pastPoints() * pastPoints
                        + weights.homeworkFrequency() * homeworkFrequency
                        + weights.lectureCoverage() * lectureCoverage
                        + weights.professorEmphasisShare() * professorEmphasis
                        + weights.syllabusImportance() * syllabusImportance
                        + weights.centrality() * centrality);
        int evidenceCount = input.pastDocuments() + input.homeworkItems() + input.lectureDocuments() + input.syllabusDocuments();
        double confidence = clamp(.20 + .80 * Math.min(1, evidenceCount / 10.0));
        return new Result(pastFrequency, pastPoints, homeworkFrequency, lectureCoverage, syllabusImportance,
                professorEmphasis, quizFrequency, recentLectureEmphasis, centrality, relevance, confidence);
    }

    private static double ratio(double value, double total) { return total <= 0 ? 0 : clamp(value / total); }
    private static double clamp(double value) { return Math.max(0, Math.min(1, value)); }

    public record Input(int pastDocuments, double pastPoints, int pastItems, int homeworkItems, int quizItems,
                        int lectureDocuments, int syllabusDocuments, int centrality, int totalPastDocuments,
                        double totalPastPoints, int totalHomeworkItems, int totalQuizItems,
                        int totalLectureDocuments, int maxCentrality) {}
    public record Result(double pastFrequency, double pastPoints, double homeworkFrequency, double lectureCoverage,
                         double syllabusImportance, double professorEmphasis, double quizFrequency,
                         double recentLectureEmphasis, double centrality, double relevance, double confidence) {}
}
