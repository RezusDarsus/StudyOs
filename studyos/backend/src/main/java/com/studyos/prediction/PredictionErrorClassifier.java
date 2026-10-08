package com.studyos.prediction;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Deterministic classification of why a held-out topic prediction missed. Every category is
 * decided by a checkable rule over the training snapshot; when no rule fires the miss stays
 * UNKNOWN instead of inventing an explanation.
 */
public final class PredictionErrorClassifier {

    private PredictionErrorClassifier() {}

    public enum Category {
        RECENCY_OVERWEIGHT,       // baseline B ranks it in the top-K, the live model does not
        FREQUENCY_OVERWEIGHT,     // baseline A ranks it in the top-K, the live model does not
        COURSE_IMPORTANCE_MISWEIGHT, // baseline C ranks it in the top-K, the live model does not
        TOPIC_ALIAS_MISMATCH,     // the missed topic was observed under a merged-away alias in training
        TOPIC_RECONCILIATION_FAILURE, // the missed topic merged into another and lost its identity in scoring
        STRUCTURE_SHIFT,          // the exam's question-format drifted from training
        INSUFFICIENT_HISTORY,     // fewer than three training exams — any miss is weakly diagnosable
        UNSEEN_TOPIC,             // the topic never appeared in training at all
        UNKNOWN                   // no rule fires; explanation stays honest
    }

    public record ClassifiedMiss(UUID topicId, String topicName, Category category, String reason) {}

    /** Threshold above which a baseline's probability counts as "would have ranked it". */
    public static final double BASELINE_TOP_K_PROBABILITY = 0.34;

    public static List<ClassifiedMiss> classify(BacktestEngine.Snapshot snapshot, int foldIndex,
                                                List<PredictionMetrics.ScoredTopic> predicted, Set<UUID> actual) {
        List<ClassifiedMiss> misses = new ArrayList<>();
        int training = foldIndex;
        if (actual.isEmpty()) return misses;
        int k = Math.min(5, predicted.size());
        Set<UUID> predictedTopK = new java.util.HashSet<>();
        int taken = 0;
        for (PredictionMetrics.ScoredTopic scored : predicted) {
            if (taken >= k) break;
            // A zero-probability entry sits in the ranking only because the universe includes it;
            // counting it as "predicted" would hide real misses behind technicalities.
            if (scored.probability() <= 0) break;
            predictedTopK.add(scored.topicId());
            taken++;
        }
        BacktestEngine.ModelFold recency = BacktestEngine.evaluateBaselineFold(snapshot, foldIndex, "RECENCY");
        BacktestEngine.ModelFold frequency = BacktestEngine.evaluateBaselineFold(snapshot, foldIndex, "FREQUENCY");
        BacktestEngine.ModelFold importance = BacktestEngine.evaluateBaselineFold(snapshot, foldIndex, "IMPORTANCE");

        BacktestEngine.ExamGroundTruth evaluated = snapshot.exams().get(foldIndex);
        boolean structureShift = structureDriftFrom(snapshot.exams().subList(0, foldIndex), evaluated);

        for (UUID missed : actual) {
            if (predictedTopK.contains(missed)) continue;
            Category category = Category.UNKNOWN;
            String reason = "No rule could explain this miss; the evidence does not support a stronger claim.";
            if (training < 3) {
                category = Category.INSUFFICIENT_HISTORY;
                reason = "Only " + training + " training exam(s): any ranking this early is weakly grounded.";
            } else if (inBaselineTopK(recency, missed)) {
                category = Category.RECENCY_OVERWEIGHT;
                reason = "The recency-weighted baseline ranked this topic highly; the live model's other factors pushed it down.";
            } else if (inBaselineTopK(frequency, missed)) {
                category = Category.FREQUENCY_OVERWEIGHT;
                reason = "The plain frequency baseline ranked this topic highly; the live model's other factors pushed it down.";
            } else if (inBaselineTopK(importance, missed)) {
                category = Category.COURSE_IMPORTANCE_MISWEIGHT;
                reason = "The course-importance baseline ranked this topic highly; the live model undervalued measured importance.";
            } else if (observedOnlyThroughMergedAlias(snapshot, missed, foldIndex)) {
                category = Category.TOPIC_ALIAS_MISMATCH;
                reason = "This topic's evidence exists in training under a merged-away alias; canonical resolution should have carried it.";
            } else if (snapshot.canonicalOf().containsKey(missed)) {
                category = Category.TOPIC_RECONCILIATION_FAILURE;
                reason = "This topic id is itself a merged-away row; scoring should have resolved it to the canonical topic.";
            } else if (structureShift) {
                category = Category.STRUCTURE_SHIFT;
                reason = "The held-out exam's question-format drifted from the training exams, which reshuffled topic emphasis.";
            } else if (trainingObservations(snapshot, foldIndex, missed) == 0) {
                category = Category.UNSEEN_TOPIC;
                reason = "This topic never appeared in the training exams, so no frequency-based model could rank it.";
            }
            misses.add(new ClassifiedMiss(missed, nameOf(snapshot, missed), category, reason));
        }
        return misses;
    }

    private static boolean inBaselineTopK(BacktestEngine.ModelFold fold, UUID topicId) {
        if (fold.ranking() == null) return false;
        // The baseline fold does not keep its full ranking, so the rule uses the model's own
        // probability of the missed topic relative to the top-K cut: recomputing just the score.
        return fold.scoreOf(topicId) >= BASELINE_TOP_K_PROBABILITY;
    }

    private static boolean observedOnlyThroughMergedAlias(BacktestEngine.Snapshot snapshot, UUID missed, int foldIndex) {
        // A miss is alias-related when the missed topic itself was never in training, but a topic
        // that canonicalises to it was (which would be a reconciliation loss, not an unseen topic).
        for (int index = 0; index < foldIndex; index++) {
            if (snapshot.exams().get(index).topicIds().contains(missed)) return false;
        }
        for (Map.Entry<UUID, UUID> redirect : snapshot.canonicalOf().entrySet()) {
            if (redirect.getValue().equals(missed)) {
                for (int index = 0; index < foldIndex; index++) {
                    if (snapshot.exams().get(index).topicIds().contains(redirect.getKey())) return true;
                }
            }
        }
        return false;
    }

    /** Structure drift: the held-out exam's format distribution differs from training's by more than a third. */
    private static boolean structureDriftFrom(List<BacktestEngine.ExamGroundTruth> training, BacktestEngine.ExamGroundTruth evaluated) {
        if (training.isEmpty()) return false;
        Map<String, Double> trainingDistribution = new HashMap<>();
        for (BacktestEngine.ExamGroundTruth exam : training) {
            double total = exam.structures().values().stream().mapToDouble(Integer::doubleValue).sum();
            if (total <= 0) continue;
            for (Map.Entry<String, Integer> entry : exam.structures().entrySet()) {
                trainingDistribution.merge(entry.getKey(), entry.getValue() / total, Double::sum);
            }
        }
        double examCount = training.size();
        trainingDistribution.replaceAll((key, value) -> value / examCount);
        double totalQuestions = evaluated.structures().values().stream().mapToDouble(Integer::doubleValue).sum();
        Map<String, Double> evaluatedDistribution = new HashMap<>();
        if (totalQuestions > 0) {
            for (Map.Entry<String, Integer> entry : evaluated.structures().entrySet()) {
                evaluatedDistribution.put(entry.getKey(), entry.getValue() / totalQuestions);
            }
        }
        return PredictionMetrics.totalVariationDistance(evaluatedDistribution, trainingDistribution) >= 0.34;
    }

    private static int trainingObservations(BacktestEngine.Snapshot snapshot, int foldIndex, UUID topicId) {
        int observations = 0;
        for (int index = 0; index < foldIndex; index++) {
            if (snapshot.exams().get(index).topicIds().contains(topicId)) observations++;
        }
        return observations;
    }

    private static String nameOf(BacktestEngine.Snapshot snapshot, UUID topicId) {
        BacktestEngine.TopicProfile profile = snapshot.topics().get(topicId);
        return profile == null ? topicId.toString() : profile.name();
    }
}
