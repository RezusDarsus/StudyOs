package com.studyos.prediction;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Deterministic temporal-drift detection: a recent-vs-old comparison of topic and structure
 * distributions. No ML — a fixed recent window against everything before it, with the difference
 * measured as total variation distance. A strong drift score is a reason to test recency
 * weighting in backtesting, never a licence to change weights by itself.
 */
public final class DriftAnalyzer {

    private DriftAnalyzer() {}

    public record DriftReport(double topicDrift, double structureDrift, double topicDriftRecentHalf,
                              double topicDriftOldHalf, int recentWindow, boolean strongDrift,
                              Map<String, Double> risingTopics, Map<String, Double> fallingTopics,
                              Map<String, Double> structureShift, String summary) {}

    /** Strong means the recent half of the history differs from the older half by more than a third. */
    public static final double STRONG_THRESHOLD = 0.34;

    public static DriftReport analyze(List<BacktestEngine.ExamGroundTruth> exams) {
        int recentWindow = Math.max(1, exams.size() / 3);
        int split = Math.max(1, exams.size() - recentWindow);
        if (exams.size() < 4) {
            return new DriftReport(0, 0, 0, 0, recentWindow, false, Map.of(), Map.of(), Map.of(),
                    "Too few historical exams for drift analysis; at least four are needed.");
        }

        List<BacktestEngine.ExamGroundTruth> older = exams.subList(0, split);
        List<BacktestEngine.ExamGroundTruth> recent = exams.subList(split, exams.size());

        Map<UUID, Double> olderTopics = topicDistribution(older);
        Map<UUID, Double> recentTopics = topicDistribution(recent);
        Map<String, Double> olderStructure = structureDistribution(older);
        Map<String, Double> recentStructure = structureDistribution(recent);

        double topicDrift = PredictionMetrics.totalVariationDistance(toUuidKey(recentTopics), toUuidKey(olderTopics));
        double structureDrift = PredictionMetrics.totalVariationDistance(recentStructure, olderStructure);

        // Sub-split drifts say whether drift is accelerating (recent half differs from its own predecessor).
        double topicDriftRecentHalf = halfDrift(recent);
        double topicDriftOldHalf = halfDrift(older);

        Map<String, Double> rising = new LinkedHashMap<>();
        Map<String, Double> falling = new LinkedHashMap<>();
        Set<UUID> labels = new HashSet<>();
        labels.addAll(olderTopics.keySet());
        labels.addAll(recentTopics.keySet());
        for (UUID topicId : labels) {
            double change = recentTopics.getOrDefault(topicId, 0.0) - olderTopics.getOrDefault(topicId, 0.0);
            if (change >= 0.15) rising.put(topicId.toString(), round(change));
            if (change <= -0.15) falling.put(topicId.toString(), round(-change));
        }
        Map<String, Double> structureShift = new LinkedHashMap<>();
        Set<String> structureLabels = new HashSet<>();
        structureLabels.addAll(olderStructure.keySet());
        structureLabels.addAll(recentStructure.keySet());
        for (String type : structureLabels) {
            double change = recentStructure.getOrDefault(type, 0.0) - olderStructure.getOrDefault(type, 0.0);
            if (Math.abs(change) >= 0.1) structureShift.put(type, round(change));
        }

        boolean strong = topicDrift >= STRONG_THRESHOLD || structureDrift >= STRONG_THRESHOLD;
        String summary = strong
                ? String.format("Recent exams differ from older ones (topic drift %.2f, structure drift %.2f). Recency weighting should be tested, adopted only if backtesting improves.", topicDrift, structureDrift)
                : String.format("No strong drift detected (topic drift %.2f, structure drift %.2f).", topicDrift, structureDrift);
        return new DriftReport(round(topicDrift), round(structureDrift), round(topicDriftRecentHalf),
                round(topicDriftOldHalf), recentWindow, strong, rising, falling, structureShift, summary);
    }

    private static double halfDrift(List<BacktestEngine.ExamGroundTruth> exams) {
        if (exams.size() < 2) return 0;
        int half = exams.size() / 2;
        Map<UUID, Double> first = topicDistribution(exams.subList(0, half));
        Map<UUID, Double> second = topicDistribution(exams.subList(half, exams.size()));
        return PredictionMetrics.totalVariationDistance(toUuidKey(second), toUuidKey(first));
    }

    private static Map<UUID, Double> topicDistribution(List<BacktestEngine.ExamGroundTruth> exams) {
        Map<UUID, Double> distribution = new HashMap<>();
        if (exams.isEmpty()) return distribution;
        for (BacktestEngine.ExamGroundTruth exam : exams) {
            double totalWeight = exam.topicWeights().values().stream().mapToDouble(Double::doubleValue).sum();
            if (totalWeight <= 0) continue;
            for (Map.Entry<UUID, Double> entry : exam.topicWeights().entrySet()) {
                distribution.merge(entry.getKey(), entry.getValue() / totalWeight, Double::sum);
            }
        }
        double examCount = exams.size();
        distribution.replaceAll((key, value) -> value / examCount);
        return distribution;
    }

    private static Map<String, Double> structureDistribution(List<BacktestEngine.ExamGroundTruth> exams) {
        Map<String, Double> distribution = new HashMap<>();
        if (exams.isEmpty()) return distribution;
        for (BacktestEngine.ExamGroundTruth exam : exams) {
            double total = exam.structures().values().stream().mapToDouble(Integer::doubleValue).sum();
            if (total <= 0) continue;
            for (Map.Entry<String, Integer> entry : exam.structures().entrySet()) {
                distribution.merge(entry.getKey(), entry.getValue() / total, Double::sum);
            }
        }
        double examCount = exams.size();
        distribution.replaceAll((key, value) -> value / examCount);
        return distribution;
    }

    private static Map<String, Double> toUuidKey(Map<UUID, Double> distribution) {
        Map<String, Double> result = new HashMap<>();
        distribution.forEach((key, value) -> result.put(key.toString(), value));
        return result;
    }

    private static double round(double value) { return Math.round(value * 1000) / 1000.0; }
}
