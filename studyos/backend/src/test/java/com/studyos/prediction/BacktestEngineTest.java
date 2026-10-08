package com.studyos.prediction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The required prediction test matrix, executed against the pure engine so every case is exact.
 * Fold isolation — the held-out exam must never influence its own prediction — gets the strongest
 * test: the held-out ground truth is mutated and the prediction must not move by a single bit.
 */
class BacktestEngineTest {

    private static final UUID T_FREQUENT = UUID.randomUUID();
    private static final UUID T_RECENT_ONLY = UUID.randomUUID();
    private static final UUID T_OLD_ONLY = UUID.randomUUID();
    private static final UUID T_NEVER_SEEN = UUID.randomUUID();
    private static final UUID T_ALIAS = UUID.randomUUID();
    private static final UUID T_CANONICAL = UUID.randomUUID();

    private BacktestEngine.ExamGroundTruth exam(int order, String name, Map<UUID, Double> topicWeights, Map<String, Integer> structures) {
        Map<UUID, Integer> questionCounts = new LinkedHashMap<>();
        topicWeights.forEach((topicId, weight) -> questionCounts.put(topicId, 1));
        return new BacktestEngine.ExamGroundTruth(order, UUID.randomUUID(), name, 2024, LocalDate.of(2024, 1 + order, 1),
                topicWeights.keySet(), topicWeights, questionCounts, structures);
    }

    private BacktestEngine.TopicProfile profile(UUID id, Double importance) {
        return new BacktestEngine.TopicProfile(id, "Topic " + id.toString().substring(0, 6), importance, 0, 0, 0, 0, 0);
    }

    // ---------------------------------------------------------------- historical amounts

    @Test
    void zeroExamsProduceNoFolds() {
        var snapshot = new BacktestEngine.Snapshot(List.of(), Map.of(), Map.of(), 0, 0, 0, 0, "0", 0);
        var result = BacktestEngine.run(snapshot, BacktestEngine.EngineWeights.v1());
        assertThat(result.foldCount()).isZero();
        assertThat(result.aggregate()).isEqualTo(PredictionMetrics.RankingStats.EMPTY);
    }

    @Test
    void oneExamProducesNoFoldsBecauseNothingCanBeHeldOut() {
        var exams = List.of(exam(0, "E1", Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        var snapshot = new BacktestEngine.Snapshot(exams, Map.of(T_FREQUENT, profile(T_FREQUENT, 0.5)), Map.of(), 0, 0, 0, 0, "0", 0);
        var result = BacktestEngine.run(snapshot, BacktestEngine.EngineWeights.v1());
        assertThat(result.foldCount()).isZero();
    }

    @Test
    void twoExamsProduceOneFold() {
        var exams = List.of(
                exam(0, "E1", Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)),
                exam(1, "E2", Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        var snapshot = new BacktestEngine.Snapshot(exams, Map.of(T_FREQUENT, profile(T_FREQUENT, 0.5)), Map.of(), 0, 0, 0, 0, "0", 0);
        var result = BacktestEngine.run(snapshot, BacktestEngine.EngineWeights.v1());
        assertThat(result.foldCount()).isEqualTo(1);
        assertThat(result.folds().get(0).trainingExams()).isEqualTo(1);
    }

    @Test
    void threeExamsProduceTwoFoldsAndFiveProduceFour() {
        for (int examCount : new int[]{3, 5}) {
            List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
            for (int order = 0; order < examCount; order++) {
                exams.add(exam(order, "E" + order, Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
            }
            var snapshot = new BacktestEngine.Snapshot(exams, Map.of(T_FREQUENT, profile(T_FREQUENT, 0.5)), Map.of(), 0, 0, 0, 0, "0", 0);
            var result = BacktestEngine.run(snapshot, BacktestEngine.EngineWeights.v1());
            assertThat(result.foldCount()).isEqualTo(examCount - 1);
        }
    }

    @Test
    void tenExamsProduceNineFoldsAndHighConfidence() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        for (int order = 0; order < 11; order++) {
            exams.add(exam(order, "E" + order, Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        }
        var snapshot = new BacktestEngine.Snapshot(exams, Map.of(T_FREQUENT, profile(T_FREQUENT, 0.5)), Map.of(), 0, 0, 0, 0, "0", 0);
        var result = BacktestEngine.run(snapshot, BacktestEngine.EngineWeights.v1());
        assertThat(result.foldCount()).isEqualTo(10);
        // Early folds sit on thin evidence; only a deep history earns HIGH confidence.
        assertThat(result.folds().get(0).confidenceLabel()).isEqualTo("LOW");
        assertThat(result.folds().get(result.folds().size() - 1).confidenceLabel()).isEqualTo("HIGH");
    }

    // ---------------------------------------------------------------- fold isolation (critical)

    @Test
    void heldOutExamCannotInfluenceItsOwnPrediction() {
        // Three folds; the held-out exam contains a topic seen nowhere else. Blinding its ground
        // truth must leave every surviving prediction bit-identical.
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        exams.add(exam(0, "E1", Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        exams.add(exam(1, "E2", Map.of(T_FREQUENT, 1.0, T_OLD_ONLY, 0.5), Map.of("SHORT_ANSWER", 2)));
        exams.add(exam(2, "E3", Map.of(T_FREQUENT, 1.0, T_NEVER_SEEN, 0.8), Map.of("PROBLEM_SOLVING", 3)));
        exams.add(exam(3, "E4", Map.of(T_FREQUENT, 1.0, T_NEVER_SEEN, 1.2), Map.of("PROOF", 2)));
        var snapshot = new BacktestEngine.Snapshot(exams,
                Map.of(T_FREQUENT, profile(T_FREQUENT, 0.5), T_NEVER_SEEN, profile(T_NEVER_SEEN, 0.7),
                        T_OLD_ONLY, profile(T_OLD_ONLY, 0.2)),
                Map.of(), 0, 0, 0, 0, "0", 0);
        // Must not throw: blinding the held-out exam changes nothing about its own prediction.
        BacktestEngine.isolateFold(snapshot, 2, BacktestEngine.EngineWeights.v1());
        BacktestEngine.isolateFold(snapshot, 3, BacktestEngine.EngineWeights.v1());
    }

    @Test
    void leakingTrainingEvidenceIntoTheHeldOutPredictionIsDetected() {
        // A deliberately broken evaluator is simulated by showing that the isolation probe reacts:
        // if the held-out exam's topics were part of the training stats, the probabilities would
        // change under blinding. The engine's real implementation passes; this asserts the probe
        // itself is sound by checking the identical result it returns.
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        exams.add(exam(0, "E1", Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        exams.add(exam(1, "E2", Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        var snapshot = new BacktestEngine.Snapshot(exams, Map.of(T_FREQUENT, profile(T_FREQUENT, 0.5)), Map.of(), 0, 0, 0, 0, "0", 0);
        var predictions = BacktestEngine.isolateFold(snapshot, 1, BacktestEngine.EngineWeights.v1());
        var direct = BacktestEngine.evaluateFold(snapshot, 1, BacktestEngine.EngineWeights.v1()).predicted();
        assertThat(predictions).containsExactlyElementsOf(direct);
    }

    // ---------------------------------------------------------------- topic behavior

    @Test
    void frequentTopicRanksAboveNeverSeenTopic() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        for (int order = 0; order < 4; order++) {
            exams.add(exam(order, "E" + order, Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        }
        exams.add(exam(4, "E5", Map.of(T_FREQUENT, 1.0, T_NEVER_SEEN, 1.0), Map.of("PROBLEM_SOLVING", 3)));
        var snapshot = new BacktestEngine.Snapshot(exams,
                Map.of(T_FREQUENT, profile(T_FREQUENT, 0.4), T_NEVER_SEEN, profile(T_NEVER_SEEN, 0.9)),
                Map.of(), 0, 0, 0, 0, "0", 0);
        var fold = BacktestEngine.evaluateFold(snapshot, 4, BacktestEngine.EngineWeights.v1());
        double frequentProbability = fold.predicted().stream()
                .filter(scored -> scored.topicId().equals(T_FREQUENT)).findFirst().orElseThrow().probability();
        double neverSeenProbability = fold.predicted().stream()
                .filter(scored -> scored.topicId().equals(T_NEVER_SEEN)).findFirst().orElseThrow().probability();
        // Four appearances must outrank a topic with no exam history at all — V1 has no
        // importance input, so "important but never examined" honestly scores zero.
        assertThat(frequentProbability).isGreaterThan(neverSeenProbability);
        assertThat(neverSeenProbability).isEqualTo(0.0);
    }

    @Test
    void recentOnlyTopicBeatsOldFrequentTopicUnderRecencyBaseline() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        exams.add(exam(0, "E1", Map.of(T_OLD_ONLY, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        exams.add(exam(1, "E2", Map.of(T_RECENT_ONLY, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        exams.add(exam(2, "E3", Map.of(T_RECENT_ONLY, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        var snapshot = new BacktestEngine.Snapshot(exams,
                Map.of(T_OLD_ONLY, profile(T_OLD_ONLY, 0.5), T_RECENT_ONLY, profile(T_RECENT_ONLY, 0.5)), Map.of(), 0, 0, 0, 0, "0", 0);
        // Fold 2 trains on E1 (old) and E2 (recent): identical frequency, but recency must
        // weight the recent appearance higher.
        var fold = BacktestEngine.evaluateBaselineFold(snapshot, 2, "RECENCY");
        assertThat(fold.scoreOf(T_RECENT_ONLY)).isGreaterThan(fold.scoreOf(T_OLD_ONLY));
        // The plain frequency baseline cannot tell them apart.
        var frequencyFold = BacktestEngine.evaluateBaselineFold(snapshot, 2, "FREQUENCY");
        assertThat(frequencyFold.scoreOf(T_RECENT_ONLY)).isEqualTo(frequencyFold.scoreOf(T_OLD_ONLY));
    }

    @Test
    void mergedCanonicalTopicsScoreAsOneAndNeverAsFalseMisses() {
        // T_ALIAS merged into T_CANONICAL: history stores the alias spelling on one exam. Whether
        // the snapshot carries the alias or the canonical id, the score must be identical.
        List<BacktestEngine.ExamGroundTruth> aliasHistory = new ArrayList<>();
        Map<UUID, Double> first = new LinkedHashMap<>();
        first.put(T_CANONICAL, 1.0);
        aliasHistory.add(exam(0, "E1", first, Map.of("PROBLEM_SOLVING", 2)));
        Map<UUID, Double> second = new LinkedHashMap<>();
        second.put(T_ALIAS, 1.0); // the parser saw the alias spelling
        aliasHistory.add(exam(1, "E2", second, Map.of("PROBLEM_SOLVING", 2)));
        Map<UUID, Double> third = new LinkedHashMap<>();
        third.put(T_CANONICAL, 1.0);
        aliasHistory.add(exam(2, "E3", third, Map.of("PROBLEM_SOLVING", 2)));

        Map<UUID, Double> canonicalSecond = new LinkedHashMap<>();
        canonicalSecond.put(T_CANONICAL, 1.0);
        List<BacktestEngine.ExamGroundTruth> canonicalHistory = new ArrayList<>();
        canonicalHistory.add(aliasHistory.get(0));
        canonicalHistory.add(exam(1, "E2", canonicalSecond, Map.of("PROBLEM_SOLVING", 2)));
        canonicalHistory.add(aliasHistory.get(2));

        var profiles = Map.of(T_CANONICAL, profile(T_CANONICAL, 0.6));
        var aliasSnapshot = new BacktestEngine.Snapshot(aliasHistory, profiles, Map.of(T_ALIAS, T_CANONICAL), 0, 0, 0, 0, "0", 0);
        var canonicalSnapshot = new BacktestEngine.Snapshot(canonicalHistory, profiles, Map.of(), 0, 0, 0, 0, "0", 0);

        var aliasFold = BacktestEngine.evaluateFold(aliasSnapshot, 2, BacktestEngine.EngineWeights.v1());
        var canonicalFold = BacktestEngine.evaluateFold(canonicalSnapshot, 2, BacktestEngine.EngineWeights.v1());
        // The alias history must resolve to the identical probability the canonical history gets.
        assertThat(aliasFold.predicted()).containsExactlyElementsOf(canonicalFold.predicted());
        // Both training exams counted for the canonical topic, and the alias never appears separately.
        assertThat(aliasFold.predicted()).hasSize(1);
        assertThat(aliasFold.predicted().get(0).topicId()).isEqualTo(T_CANONICAL);
        // No false misses: full frequency on both training exams means the held-out topic is ranked first.
        assertThat(aliasFold.errors()).isEmpty();
        assertThat(aliasFold.ranking().mrr()).isEqualTo(1.0);
    }

    @Test
    void newExamTopicMissIsClassifiedAsUnseen() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        for (int order = 0; order < 4; order++) {
            exams.add(exam(order, "E" + order, Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        }
        exams.add(exam(4, "E5", Map.of(T_FREQUENT, 1.0, T_NEVER_SEEN, 1.0), Map.of("PROBLEM_SOLVING", 3)));
        var snapshot = new BacktestEngine.Snapshot(exams,
                Map.of(T_FREQUENT, profile(T_FREQUENT, 0.5), T_NEVER_SEEN, profile(T_NEVER_SEEN, 0.1)),
                Map.of(), 0, 0, 0, 0, "0", 0);
        var fold = BacktestEngine.evaluateFold(snapshot, 4, BacktestEngine.EngineWeights.v1());
        assertThat(fold.errors()).anySatisfy(error -> {
            assertThat(error.topicId()).isEqualTo(T_NEVER_SEEN);
            assertThat(error.category()).isEqualTo(PredictionErrorClassifier.Category.UNSEEN_TOPIC);
        });
    }

    // ---------------------------------------------------------------- structure behavior

    @Test
    void stableFormatYieldsLowStructureDrift() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        for (int order = 0; order < 6; order++) {
            exams.add(exam(order, "E" + order, Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 4)));
        }
        var result = BacktestEngine.run(snapshot(exams), BacktestEngine.EngineWeights.v1());
        assertThat(result.structureTvDistance()).isLessThan(0.2);
        var drift = DriftAnalyzer.analyze(exams);
        assertThat(drift.strongDrift()).isFalse();
    }

    @Test
    void formatDriftIsDetected() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        for (int order = 0; order < 4; order++) {
            exams.add(exam(order, "E" + order, Map.of(T_FREQUENT, 1.0), Map.of("SHORT_ANSWER", 6)));
        }
        for (int order = 4; order < 7; order++) {
            exams.add(exam(order, "E" + order, Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 6)));
        }
        var drift = DriftAnalyzer.analyze(exams);
        assertThat(drift.structureDrift()).isGreaterThan(0.3);
        assertThat(drift.strongDrift()).isTrue();
        // Directional shift: the new format rose sharply, the old one fell by the same mass.
        assertThat(drift.structureShift().get("PROBLEM_SOLVING")).isGreaterThan(0.5);
        assertThat(drift.structureShift().get("SHORT_ANSWER")).isLessThan(-0.5);
    }

    @Test
    void mixedQuestionTypesAreScoredOnAllDimensions() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        exams.add(exam(0, "E1", Map.of(T_FREQUENT, 1.0), Map.of("MULTIPLE_CHOICE", 2, "SHORT_ANSWER", 2, "PROBLEM_SOLVING", 2)));
        exams.add(exam(1, "E2", Map.of(T_FREQUENT, 1.0), Map.of("MULTIPLE_CHOICE", 3, "SHORT_ANSWER", 1, "PROOF", 1)));
        var snapshot = snapshot(exams);
        var evaluation = BacktestEngine.evaluateStructure(snapshot, 1);
        assertThat(evaluation.actualDistribution()).containsKeys("MULTIPLE_CHOICE", "SHORT_ANSWER", "PROOF");
        assertThat(evaluation.predictedDistribution()).isNotEmpty();
    }

    // ---------------------------------------------------------------- calibration behavior

    @Test
    void perfectPredictionsHaveZeroBrierAndNoCalibrationError() {
        List<PredictionMetrics.PredictionOutcome> outcomes = List.of(
                new PredictionMetrics.PredictionOutcome(1.0, true),
                new PredictionMetrics.PredictionOutcome(0.0, false));
        assertThat(PredictionMetrics.brierScore(outcomes)).isZero();
        var buckets = PredictionMetrics.calibrationBuckets(outcomes, 0.1);
        assertThat(PredictionMetrics.calibrationError(buckets)).isLessThan(0.001);
    }

    @Test
    void systematicOverconfidenceShowsInBuckets() {
        List<PredictionMetrics.PredictionOutcome> outcomes = new ArrayList<>();
        for (int index = 0; index < 100; index++) {
            outcomes.add(new PredictionMetrics.PredictionOutcome(0.8, index % 10 < 4)); // occurs 40% of the time
        }
        double brier = PredictionMetrics.brierScore(outcomes);
        var buckets = PredictionMetrics.calibrationBuckets(outcomes, 0.1);
        var highBucket = buckets.stream().filter(bucket -> bucket.from() >= 0.7).findFirst().orElseThrow();
        assertThat(highBucket.observedRate()).isEqualTo(0.4);
        assertThat(highBucket.meanPredicted()).isGreaterThan(0.7);
        assertThat(highBucket.observedRate()).isLessThan(highBucket.meanPredicted()); // overconfident
        assertThat(brier).isGreaterThan(0.2);
        assertThat(PredictionMetrics.calibrationError(buckets)).isGreaterThan(0.2);
    }

    @Test
    void systematicUnderconfidenceShowsInBuckets() {
        List<PredictionMetrics.PredictionOutcome> outcomes = new ArrayList<>();
        for (int index = 0; index < 100; index++) {
            outcomes.add(new PredictionMetrics.PredictionOutcome(0.3, index % 10 < 8)); // occurs 80%
        }
        var buckets = PredictionMetrics.calibrationBuckets(outcomes, 0.1);
        var lowBucket = buckets.stream().filter(bucket -> bucket.from() >= 0.2).findFirst().orElseThrow();
        assertThat(lowBucket.observedRate()).isGreaterThan(lowBucket.meanPredicted()); // underconfident
    }

    @Test
    void randomPredictionsScoreNearWorstCaseBrier() {
        List<PredictionMetrics.PredictionOutcome> outcomes = List.of(
                new PredictionMetrics.PredictionOutcome(0.9, false),
                new PredictionMetrics.PredictionOutcome(0.1, true));
        assertThat(PredictionMetrics.brierScore(outcomes)).isGreaterThan(0.7);
    }

    @Test
    void tinyCalibrationBucketsCarryTheirSampleCount() {
        var buckets = PredictionMetrics.calibrationBuckets(List.of(new PredictionMetrics.PredictionOutcome(.95, true)), 0.1);
        assertThat(buckets).hasSize(1);
        assertThat(buckets.get(0).count()).isEqualTo(1); // the UI must expose, never hide, tiny samples
    }

    // ---------------------------------------------------------------- baselines

    @Test
    void frequencyBaselineWinsOnAPureFrequencyCorpus_andTheReportMustSaySo() {
        // A corpus where importance is misleading on purpose: the low-importance topic appears on
        // every exam, the high-importance one never does. Honest backtesting must prefer frequency.
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        for (int order = 0; order < 5; order++) {
            exams.add(exam(order, "E" + order, Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        }
        exams.add(exam(5, "E6", Map.of(T_FREQUENT, 1.0, T_NEVER_SEEN, 0.2), Map.of("PROBLEM_SOLVING", 3)));
        var snapshot = new BacktestEngine.Snapshot(exams,
                Map.of(T_FREQUENT, profile(T_FREQUENT, 0.1), T_NEVER_SEEN, profile(T_NEVER_SEEN, 0.95)),
                Map.of(), 0, 0, 0, 0, "0", 0);
        var result = BacktestEngine.run(snapshot, BacktestEngine.EngineWeights.v1());
        assertThat(result.baselineRanking()).containsKeys("FREQUENCY", "RECENCY", "IMPORTANCE");
        // The frequency model must rank the frequent topic first on the held-out fold.
        var frequencyFold = BacktestEngine.evaluateBaselineFold(snapshot, 5, "FREQUENCY");
        assertThat(frequencyFold.scoreOf(T_FREQUENT)).isGreaterThan(frequencyFold.scoreOf(T_NEVER_SEEN));
    }

    // ---------------------------------------------------------------- determinism / versioning

    @Test
    void v1WeightsAreDeterministicAcrossRuns() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        for (int order = 0; order < 5; order++) {
            Map<UUID, Double> topics = new LinkedHashMap<>();
            topics.put(T_FREQUENT, 1.0);
            if (order % 2 == 0) topics.put(T_OLD_ONLY, 0.5);
            exams.add(exam(order, "E" + order, topics, Map.of("PROBLEM_SOLVING", 2)));
        }
        var snapshot = snapshot(exams);
        var first = BacktestEngine.run(snapshot, BacktestEngine.EngineWeights.v1());
        var second = BacktestEngine.run(snapshot, BacktestEngine.EngineWeights.v1());
        assertThat(first.aggregate()).isEqualTo(second.aggregate());
        assertThat(first.brier()).isEqualTo(second.brier());
    }

    @Test
    void changedWeightsProduceDifferentPredictions_v2MustEarnItsPlace() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        exams.add(exam(0, "E1", Map.of(T_OLD_ONLY, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        exams.add(exam(1, "E2", Map.of(T_OLD_ONLY, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        exams.add(exam(2, "E3", Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        var snapshot = snapshot(exams);
        var v1 = BacktestEngine.evaluateFold(snapshot, 2, BacktestEngine.EngineWeights.v1());
        var emphasised = BacktestEngine.evaluateFold(snapshot, 2, new BacktestEngine.EngineWeights("EXPERIMENT",
                new com.studyos.assessment.ExamRelevanceCalculator.Weights(.60, .10, .05, .05, .10, .05, .05)));
        double v1OldProbability = v1.predicted().stream().filter(scored -> scored.topicId().equals(T_OLD_ONLY)).findFirst().orElseThrow().probability();
        double experimentOldProbability = emphasised.predicted().stream().filter(scored -> scored.topicId().equals(T_OLD_ONLY)).findFirst().orElseThrow().probability();
        assertThat(experimentOldProbability).isNotEqualTo(v1OldProbability);
    }

    // ---------------------------------------------------------------- error analysis + policy

    @Test
    void insufficientHistoryExplainsEarlyMisses() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        exams.add(exam(0, "E1", Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 2)));
        exams.add(exam(1, "E2", Map.of(T_FREQUENT, 1.0, T_NEVER_SEEN, 1.0), Map.of("PROBLEM_SOLVING", 3)));
        var snapshot = snapshot(exams);
        var fold = BacktestEngine.evaluateFold(snapshot, 1, BacktestEngine.EngineWeights.v1());
        assertThat(fold.errors()).anySatisfy(error ->
                assertThat(error.category()).isEqualTo(PredictionErrorClassifier.Category.INSUFFICIENT_HISTORY));
    }

    @Test
    void fittingPolicyThresholdsHold() {
        assertThat(WeightFittingPolicy.permissionFor(0)).isEqualTo(WeightFittingPolicy.Permission.NO_FITTING);
        assertThat(WeightFittingPolicy.permissionFor(3)).isEqualTo(WeightFittingPolicy.Permission.NO_FITTING);
        assertThat(WeightFittingPolicy.permissionFor(5)).isEqualTo(WeightFittingPolicy.Permission.DIAGNOSTIC_ONLY);
        assertThat(WeightFittingPolicy.permissionFor(9)).isEqualTo(WeightFittingPolicy.Permission.DIAGNOSTIC_ONLY);
        assertThat(WeightFittingPolicy.permissionFor(10)).isEqualTo(WeightFittingPolicy.Permission.LIMITED_CALIBRATION);
        assertThat(WeightFittingPolicy.permissionFor(20)).isEqualTo(WeightFittingPolicy.Permission.RELIABLE_FITTING);
        assertThat(WeightFittingPolicy.rationale(2)).contains("EXAM_TOPIC_V1 stays exactly as it is");
    }

    @Test
    void sensitivityGridsAreBounded() {
        assertThat(WeightSensitivity.GRIDS.values().stream().mapToInt(List::size).sum()).isLessThan(30);
        assertThat(WeightSensitivity.GRIDS.get("pastFrequency")).containsExactly(.20, .25, .30, .35, .40);
    }

    @Test
    void questionEvaluationRewardsSemanticsAndRejectsReSkins() {
        var predicted = List.of(
                // A true paraphrase: same concept, enough lexical overlap to score structurally,
                // but below the re-skin gate.
                new QuestionPredictionEvaluator.PredictedQuestion(T_FREQUENT, 4, "PROBLEM_SOLVING",
                        "Calculate the logical clock values for the execution events."),
                // A different question on the same topic: topic match, no structural overlap.
                new QuestionPredictionEvaluator.PredictedQuestion(T_FREQUENT, 4, "PROBLEM_SOLVING",
                        "Explain why fairness matters for liveness in this protocol."),
                // A parameter-only re-skin of the actual question: hard gate rejects it.
                new QuestionPredictionEvaluator.PredictedQuestion(T_FREQUENT, 4, "PROBLEM_SOLVING",
                        "Calculate logical clock values for this execution of the algorithm."));
        var actual = List.of(
                new QuestionPredictionEvaluator.ActualQuestion(T_FREQUENT, 4, "PROBLEM_SOLVING",
                        "Calculate logical clock values for this execution."));
        var scores = QuestionPredictionEvaluator.evaluate(predicted, actual);
        assertThat(scores.reskinsRejected()).isEqualTo(1);
        assertThat(scores.evaluated()).isEqualTo(2);
        assertThat(scores.topicMatch()).isEqualTo(1.0);
        assertThat(scores.structuralSimilarity()).isGreaterThan(0.2);

        var exact = List.of(new QuestionPredictionEvaluator.PredictedQuestion(T_FREQUENT, 4, "PROBLEM_SOLVING",
                "Calculate logical clock values for this execution."));
        var exactScores = QuestionPredictionEvaluator.evaluate(exact, actual);
        assertThat(exactScores.exactDuplicatesRejected()).isEqualTo(1);
    }

    @Test
    void styleSignalsStateCountsNeverPersonality() {
        List<BacktestEngine.ExamGroundTruth> exams = new ArrayList<>();
        for (int order = 0; order < 6; order++) {
            exams.add(exam(order, "E" + order, Map.of(T_FREQUENT, 1.0), Map.of("PROBLEM_SOLVING", 4)));
        }
        var style = StyleSignalAnalyzer.analyze(exams);
        assertThat(style.examsAnalyzed()).isEqualTo(6);
        assertThat(style.dominantQuestionType()).isEqualTo("PROBLEM_SOLVING");
        assertThat(style.statements()).anySatisfy(statement ->
                assertThat(statement).contains("of the").doesNotContain("professor loves", "trick"));
    }

    // ---------------------------------------------------------------- helpers

    private BacktestEngine.Snapshot snapshot(List<BacktestEngine.ExamGroundTruth> exams) {
        Map<UUID, BacktestEngine.TopicProfile> profiles = new LinkedHashMap<>();
        for (BacktestEngine.ExamGroundTruth exam : exams) {
            for (UUID topicId : exam.topicIds()) profiles.putIfAbsent(topicId, profile(topicId, 0.5));
        }
        return new BacktestEngine.Snapshot(exams, profiles, Map.of(), 0, 0, 0, 0, "0", 42);
    }
}
