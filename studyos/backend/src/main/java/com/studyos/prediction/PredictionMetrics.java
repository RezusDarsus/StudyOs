package com.studyos.prediction;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Evaluation metrics for probabilistic exam predictions, kept pure so they can be tested against
 * hand-computed values. These are engineering/evaluation metrics: ranking metrics say how well the
 * predictor orders topics, the Brier score says how honest its probabilities are, and calibration
 * buckets say where it is over- or under-confident. None of them belong in a learner's face.
 */
public final class PredictionMetrics {

    private PredictionMetrics() {}

    /** One ranked prediction: a topic and its predicted probability of appearing. */
    public record ScoredTopic(UUID topicId, double probability) {}

    /** One probability paired with what actually happened, for Brier and calibration. */
    public record PredictionOutcome(double predicted, boolean occurred) {
        public PredictionOutcome {
            predicted = Math.max(0, Math.min(1, predicted));
        }
    }

    /** One calibration bucket: predicted range, mean prediction, observed occurrence rate, volume. */
    public record CalibrationBucket(double from, double to, double meanPredicted, double observedRate, int count) {}

    public record RankingMetrics(double precisionAtK, double recallAtK, double mrr, double ndcgAtK) {}

    /** Full per-fold ranking snapshot. No rounding happens anywhere in this class. */
    public record RankingStats(double precisionAt3, double precisionAt5, double recallAt3, double recallAt5,
                               double mrr, double ndcgAt5, double ndcgAt10, double spearman) {
        public static final RankingStats EMPTY = new RankingStats(0, 0, 0, 0, 0, 0, 0, 0);
    }

    /** Structure-distribution metrics. Total variation is chosen because it is a true metric on
     *  distributions (bounded 0..1, symmetric, interpretable as "share of mass misplaced"), unlike
     *  Euclidean distance which squares away small-but-real shifts. Count error complements it
     *  with an absolute, human-readable magnitude. */
    public record StructureStats(double brier, double meanAbsoluteCountError, double totalVariationDistance) {
        public static final StructureStats EMPTY = new StructureStats(0, 0, 0);
    }

    public static double precisionAtK(List<ScoredTopic> ranked, Set<UUID> actual, int k) {
        if (ranked.isEmpty() || actual.isEmpty() || k <= 0) return 0;
        int hits = 0;
        int taken = 0;
        for (ScoredTopic topic : ranked) {
            if (taken >= k) break;
            taken++;
            if (actual.contains(topic.topicId())) hits++;
        }
        return (double) hits / taken;
    }

    public static double recallAtK(List<ScoredTopic> ranked, Set<UUID> actual, int k) {
        if (ranked.isEmpty() || actual.isEmpty() || k <= 0) return 0;
        int hits = 0;
        int taken = 0;
        for (ScoredTopic topic : ranked) {
            if (taken >= k) break;
            taken++;
            if (actual.contains(topic.topicId())) hits++;
        }
        return (double) hits / actual.size();
    }

    /** 1 / rank of the first actual topic in the ranking; 0 when none appears. */
    public static double reciprocalRank(List<ScoredTopic> ranked, Set<UUID> actual) {
        if (ranked.isEmpty() || actual.isEmpty()) return 0;
        int rank = 0;
        for (ScoredTopic topic : ranked) {
            rank++;
            if (actual.contains(topic.topicId())) return 1.0 / rank;
        }
        return 0;
    }

    /** Binary-gain NDCG@K: actual topics are gains of 1 at their predicted positions. */
    public static double ndcgAtK(List<ScoredTopic> ranked, Set<UUID> actual, int k) {
        if (ranked.isEmpty() || actual.isEmpty() || k <= 0) return 0;
        double dcg = 0;
        int taken = 0;
        for (ScoredTopic topic : ranked) {
            if (taken >= k) break;
            taken++;
            if (actual.contains(topic.topicId())) dcg += 1 / log2(taken + 1);
        }
        int idealHits = Math.min(actual.size(), k);
        double idcg = 0;
        for (int position = 1; position <= idealHits; position++) idcg += 1 / log2(position + 1);
        return idcg == 0 ? 0 : dcg / idcg;
    }

    /**
     * Spearman rank correlation between two value lists of equal length (paired by index). Ties
     * get average ranks. Returns 0 when fewer than two pairs or when either side is constant.
     */
    public static double spearman(List<Double> left, List<Double> right) {
        if (left == null || right == null || left.size() != right.size() || left.size() < 2) return 0;
        List<Integer> leftRanks = ranks(left);
        List<Integer> rightRanks = ranks(right);
        double meanLeft = leftRanks.stream().mapToDouble(Integer::intValue).average().orElse(0);
        double meanRight = rightRanks.stream().mapToDouble(Integer::intValue).average().orElse(0);
        double covariance = 0, varianceLeft = 0, varianceRight = 0;
        for (int index = 0; index < leftRanks.size(); index++) {
            double dl = leftRanks.get(index) - meanLeft;
            double dr = rightRanks.get(index) - meanRight;
            covariance += dl * dr;
            varianceLeft += dl * dl;
            varianceRight += dr * dr;
        }
        if (varianceLeft == 0 || varianceRight == 0) return 0;
        return covariance / Math.sqrt(varianceLeft * varianceRight);
    }

    /** Mean squared error between predicted probabilities and binary outcomes, 0..1, lower is better. */
    public static double brierScore(List<PredictionOutcome> outcomes) {
        if (outcomes == null || outcomes.isEmpty()) return 0;
        return outcomes.stream().mapToDouble(outcome -> {
            double actual = outcome.occurred() ? 1 : 0;
            return (outcome.predicted() - actual) * (outcome.predicted() - actual);
        }).average().orElse(0);
    }

    /** Fixed-width calibration buckets, ordered from low to high predicted probability. */
    public static List<CalibrationBucket> calibrationBuckets(List<PredictionOutcome> outcomes, double bucketWidth) {
        if (bucketWidth <= 0) return List.of();
        int bucketCount = (int) Math.ceil(1.0 / bucketWidth);
        List<List<PredictionOutcome>> grouped = new ArrayList<>();
        for (int index = 0; index < bucketCount; index++) grouped.add(new ArrayList<>());
        for (PredictionOutcome outcome : outcomes) {
            int bucket = Math.min(bucketCount - 1, (int) Math.floor(outcome.predicted() / bucketWidth));
            grouped.get(bucket).add(outcome);
        }
        List<CalibrationBucket> result = new ArrayList<>();
        for (int index = 0; index < bucketCount; index++) {
            List<PredictionOutcome> bucket = grouped.get(index);
            if (bucket.isEmpty()) continue;
            double meanPredicted = bucket.stream().mapToDouble(PredictionOutcome::predicted).average().orElse(0);
            double observed = bucket.stream().filter(PredictionOutcome::occurred).count() / (double) bucket.size();
            result.add(new CalibrationBucket(index * bucketWidth, (index + 1) * bucketWidth, meanPredicted, observed, bucket.size()));
        }
        return result;
    }

    /** Mean absolute calibration error across buckets, weighted by bucket volume. */
    public static double calibrationError(List<CalibrationBucket> buckets) {
        if (buckets == null || buckets.isEmpty()) return 0;
        double weightedError = 0;
        long total = 0;
        for (CalibrationBucket bucket : buckets) {
            weightedError += Math.abs(bucket.meanPredicted() - bucket.observedRate()) * bucket.count();
            total += bucket.count();
        }
        return total == 0 ? 0 : weightedError / total;
    }

    /** Orders a ranking by predicted probability descending, which is how predictions are exposed. */
    public static List<ScoredTopic> sorted(List<ScoredTopic> ranked) {
        return ranked.stream().sorted(Comparator.comparingDouble((ScoredTopic topic) -> topic.probability()).reversed()).toList();
    }

    /** Total variation distance between two distributions over the same label set: 0.5·Σ|p−q|. */
    public static double totalVariationDistance(java.util.Map<String, Double> predicted, java.util.Map<String, Double> actual) {
        java.util.Set<String> labels = new HashSet<>();
        labels.addAll(predicted.keySet());
        labels.addAll(actual.keySet());
        double absolute = 0;
        for (String label : labels) {
            absolute += Math.abs(predicted.getOrDefault(label, 0.0) - actual.getOrDefault(label, 0.0));
        }
        return absolute / 2.0;
    }

    /** Mean absolute error between predicted and actual counts over the union of the label sets. */
    public static double meanAbsoluteCountError(java.util.Map<String, Double> predictedCounts, java.util.Map<String, Double> actualCounts) {
        java.util.Set<String> labels = new HashSet<>();
        labels.addAll(predictedCounts.keySet());
        labels.addAll(actualCounts.keySet());
        if (labels.isEmpty()) return 0;
        double total = 0;
        for (String label : labels) {
            total += Math.abs(predictedCounts.getOrDefault(label, 0.0) - actualCounts.getOrDefault(label, 0.0));
        }
        return total / labels.size();
    }

    private static List<Integer> ranks(List<Double> values) {
        List<Integer> indices = new ArrayList<>();
        for (int index = 0; index < values.size(); index++) indices.add(index);
        indices.sort((a, b) -> Double.compare(values.get(a), values.get(b)));
        Integer[] ranks = new Integer[values.size()];
        int position = 0;
        while (position < indices.size()) {
            int end = position;
            while (end + 1 < indices.size() && Double.compare(values.get(indices.get(end + 1)), values.get(indices.get(position))) == 0) end++;
            double averageRank = (position + end) / 2.0 + 1;
            for (int index = position; index <= end; index++) ranks[indices.get(index)] = (int) Math.round(averageRank);
            position = end + 1;
        }
        return List.of(ranks);
    }

    private static double log2(double value) { return Math.log(value) / Math.log(2); }

    /** Set helper for building actual-topic sets from rows. */
    public static Set<UUID> actualOf(UUID... topicIds) {
        Set<UUID> set = new HashSet<>();
        for (UUID id : topicIds) set.add(id);
        return set;
    }
}
