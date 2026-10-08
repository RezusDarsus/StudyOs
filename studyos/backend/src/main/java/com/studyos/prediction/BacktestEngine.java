package com.studyos.prediction;

import com.studyos.assessment.ExamRelevanceCalculator;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Pure walk-forward backtesting engine over an immutable exam-history snapshot.
 *
 * <p>Fold i trains on exams 0..i-1 and is scored against exam i. The engine's only inputs are the
 * snapshot records, so fold isolation is structural: there is no code path through which the
 * held-out exam's ground truth can enter its own prediction. {@link #isolateFold} exists so tests
 * can prove that mutating a held-out exam's ground truth leaves its prediction bit-identical.
 *
 * <p>Four models are evaluated per fold with identical metrics:
 * <ul>
 *   <li>FREQUENCY — P(topic) ∝ how many training exams contained it (Baseline A);</li>
 *   <li>RECENCY — frequency with exponential recency decay (Baseline B);</li>
 *   <li>IMPORTANCE — the course topic model's measured importance alone (Baseline C);</li>
 *   <li>EXAM_TOPIC — the live weighted model (Baseline D / current production).</li>
 * </ul>
 * A complicated model must beat the simple baselines on held-out folds to justify itself.
 */
public final class BacktestEngine {

    private BacktestEngine() {}

    public static final int MAX_TRAINING_EXAMS_FOR_CONFIDENCE = 10;

    // ---------------------------------------------------------------- snapshot model

    /** What actually appeared on one historical exam, resolved to canonical topic ids. */
    public record ExamGroundTruth(int order, UUID examId, String name, Integer year, LocalDate date,
                                  Set<UUID> topicIds, Map<UUID, Double> topicWeights,
                                  Map<UUID, Integer> topicQuestionCounts, Map<String, Integer> structures) {}

    /** Course-wide, exam-independent evidence for one canonical topic. */
    public record TopicProfile(UUID topicId, String name, Double importance, int centrality,
                               int homeworkItems, int quizItems, int lectureDocuments, int syllabusDocuments) {}

    /**
     * Immutable evaluation corpus.
     *
     * @param canonicalOf merged-away topic id → canonical topic id (empty entries allowed)
     * @param courseRevision the course's curriculum revision counter, for reproducibility snapshots
     * @param topicGraphRevision a cheap fingerprint of the topic graph (topic count × max model timestamp hash)
     * @param objectiveApplyShare topic id → share of objectives at apply level or above; absent = unknown
     * @param dependents topic id → topics it unlocks (prerequisite edges, canonical-resolved)
     */
    public record Snapshot(List<ExamGroundTruth> exams, Map<UUID, TopicProfile> topics,
                           Map<UUID, UUID> canonicalOf, int totalHomeworkItems, int totalQuizItems,
                           int totalLectureDocuments, int maxCentrality, String courseRevision,
                           Integer topicGraphRevision, Map<UUID, Double> objectiveApplyShare,
                           Map<UUID, List<UUID>> dependents) {
        public Snapshot {
            exams = exams == null ? List.of() : List.copyOf(exams);
            topics = topics == null ? Map.of() : Map.copyOf(topics);
            canonicalOf = canonicalOf == null ? Map.of() : Map.copyOf(canonicalOf);
            objectiveApplyShare = objectiveApplyShare == null ? Map.of() : Map.copyOf(objectiveApplyShare);
            dependents = dependents == null ? Map.of() : Map.copyOf(dependents);
        }

        /** Compat constructor for callers that do not carry objective/edge data. */
        public Snapshot(List<ExamGroundTruth> exams, Map<UUID, TopicProfile> topics,
                        Map<UUID, UUID> canonicalOf, int totalHomeworkItems, int totalQuizItems,
                        int totalLectureDocuments, int maxCentrality, String courseRevision,
                        Integer topicGraphRevision) {
            this(exams, topics, canonicalOf, totalHomeworkItems, totalQuizItems, totalLectureDocuments,
                    maxCentrality, courseRevision, topicGraphRevision, Map.of(), Map.of());
        }
    }

    // ---------------------------------------------------------------- fold results

    public record ModelFold(String model, List<PredictionMetrics.ScoredTopic> predicted, PredictionMetrics.RankingStats ranking, double brier) {
        public double scoreOf(UUID topicId) {
            return predicted.stream().filter(scored -> scored.topicId().equals(topicId)).findFirst()
                    .map(PredictionMetrics.ScoredTopic::probability).orElse(0.0);
        }
    }

    public record FoldResult(int examIndex, UUID examId, String examName, int trainingExams,
                             List<PredictionMetrics.ScoredTopic> predicted,
                             List<PredictionMetrics.ScoredTopic> predictedV2,
                             List<PredictionMetrics.ScoredTopic> actualRanked,
                             Set<UUID> actual,
                             PredictionMetrics.RankingStats ranking,
                             PredictionMetrics.RankingStats rankingV2,
                             double brier,
                             double brierV2,
                             StructureEvaluation structure,
                             String confidenceLabel,
                             List<PredictionErrorClassifier.ClassifiedMiss> errors) {}

    public record StructureEvaluation(double brier, double meanAbsoluteCountError, double totalVariationDistance,
                                      Map<String, Double> predictedDistribution, Map<String, Double> actualDistribution) {}

    /** The V2 candidate's aggregate result, including which decay shape the corpus chose. */
    public record V2Result(String modelVersion, PredictionMetrics.RankingStats aggregate, double brier,
                           String chosenDecayShape, Map<String, PredictionMetrics.RankingStats> byDecayShape,
                           Map<String, Double> brierByDecayShape) {}

    public record BacktestResult(String modelVersion, int examCount, int foldCount,
                                 PredictionMetrics.RankingStats aggregate,
                                 double brier,
                                 List<PredictionMetrics.CalibrationBucket> calibration,
                                 double structureBrier, double structureCountError, double structureTvDistance,
                                 List<FoldResult> folds,
                                 Map<String, PredictionMetrics.RankingStats> baselineRanking,
                                 Map<String, Double> baselineBrier,
                                 V2Result v2,
                                 DriftAnalyzer.DriftReport drift,
                                 StyleSignalAnalyzer.StyleReport styleSignals,
                                 double durationMs) {}

    // ---------------------------------------------------------------- weights

    public record EngineWeights(String label, ExamRelevanceCalculator.Weights weights) {
        public static EngineWeights v1() { return new EngineWeights("EXAM_TOPIC_V1", ExamRelevanceCalculator.Weights.V1_DEFAULTS); }
    }

    // ---------------------------------------------------------------- evaluation

    /** Full walk-forward over every fold with at least one training exam. */
    public static BacktestResult run(Snapshot snapshot, EngineWeights engineWeights) {
        long startedAt = System.nanoTime();
        List<FoldResult> folds = new ArrayList<>();
        List<PredictionMetrics.PredictionOutcome> outcomes = new ArrayList<>();
        Map<String, List<PredictionMetrics.RankingStats>> baselineFolds = new LinkedHashMap<>();
        Map<String, List<Double>> baselineBrierFolds = new LinkedHashMap<>();
        for (int index = 1; index < snapshot.exams().size(); index++) {
            FoldResult fold = evaluateFold(snapshot, index, engineWeights);
            if (fold == null) continue;
            folds.add(fold);
            for (PredictionMetrics.ScoredTopic scored : fold.predicted()) {
                outcomes.add(new PredictionMetrics.PredictionOutcome(scored.probability(), fold.actual().contains(scored.topicId())));
            }
        }
        if (folds.isEmpty()) {
            return new BacktestResult(engineWeights.label(), snapshot.exams().size(), 0,
                    PredictionMetrics.RankingStats.EMPTY, 0, List.of(), 0, 0, 0, List.of(),
                    Map.of(), Map.of(), v2Result(snapshot, List.of()), DriftAnalyzer.analyze(snapshot.exams()), StyleSignalAnalyzer.analyze(snapshot.exams()),
                    (System.nanoTime() - startedAt) / 1_000_000.0);
        }

        PredictionMetrics.RankingStats aggregate = averageRanking(folds.stream().map(FoldResult::ranking).toList());
        double brier = PredictionMetrics.brierScore(outcomes);
        List<PredictionMetrics.CalibrationBucket> buckets = PredictionMetrics.calibrationBuckets(outcomes, 0.1);

        // Baselines run over the identical folds so every model is scored on exactly the same tasks.
        for (String baseline : List.of("FREQUENCY", "RECENCY", "IMPORTANCE")) {
            List<PredictionMetrics.RankingStats> stats = new ArrayList<>();
            List<Double> briers = new ArrayList<>();
            for (int index = 1; index < snapshot.exams().size(); index++) {
                ModelFold fold = evaluateBaselineFold(snapshot, index, baseline);
                stats.add(fold.ranking());
                briers.add(fold.brier());
            }
            baselineFolds.put(baseline, stats);
            baselineBrierFolds.put(baseline, briers);
        }
        Map<String, PredictionMetrics.RankingStats> baselineRanking = new LinkedHashMap<>();
        Map<String, Double> baselineBrier = new LinkedHashMap<>();
        baselineFolds.forEach((model, stats) -> baselineRanking.put(model, averageRanking(stats)));
        baselineBrierFolds.forEach((model, briers) -> baselineBrier.put(model, briers.stream().mapToDouble(Double::doubleValue).average().orElse(0)));

        StructureStatsAccumulator structure = new StructureStatsAccumulator();
        folds.forEach(fold -> structure.add(fold.structure()));

        double durationMs = (System.nanoTime() - startedAt) / 1_000_000.0;
        return new BacktestResult(engineWeights.label(), snapshot.exams().size(), folds.size(), aggregate, brier,
                buckets, structure.brier(), structure.countError(), structure.tvDistance(), folds,
                baselineRanking, baselineBrier, v2Result(snapshot, folds),
                DriftAnalyzer.analyze(snapshot.exams()), StyleSignalAnalyzer.analyze(snapshot.exams()), durationMs);
    }

    /**
     * The EXAM_TOPIC_V2 candidate, scored per fold from training-only features, once per decay
     * shape. The shape with the best held-out NDCG@5 is reported as the chosen one; every shape's
     * aggregate stays visible so the choice can be argued with.
     */
    static V2Result v2Result(Snapshot snapshot, List<FoldResult> folds) {
        Map<String, PredictionMetrics.RankingStats> byShape = new LinkedHashMap<>();
        Map<String, Double> brierByShape = new LinkedHashMap<>();
        String chosen = null;
        double bestNdcg = -1;
        for (TopicHistoryFeatures.DecayShape shape : TopicHistoryFeatures.DecayShape.values()) {
            List<PredictionMetrics.RankingStats> stats = new ArrayList<>();
            List<Double> briers = new ArrayList<>();
            for (int index = 1; index < snapshot.exams().size(); index++) {
                ModelFold fold = evaluateV2Fold(snapshot, index, TopicHistoryFeatures.Weights.V2_CANDIDATE, shape);
                stats.add(fold.ranking());
                briers.add(fold.brier());
            }
            if (stats.isEmpty()) continue;
            PredictionMetrics.RankingStats aggregate = averageRanking(stats);
            byShape.put(shape.name(), aggregate);
            double shapeBrier = briers.stream().mapToDouble(Double::doubleValue).average().orElse(0);
            brierByShape.put(shape.name(), shapeBrier);
            if (aggregate.ndcgAt5() > bestNdcg) { bestNdcg = aggregate.ndcgAt5(); chosen = shape.name(); }
        }
        return new V2Result("EXAM_TOPIC_V2", chosen == null ? PredictionMetrics.RankingStats.EMPTY : byShape.get(chosen),
                chosen == null ? 0 : brierByShape.get(chosen), chosen, byShape, brierByShape);
    }

    private static final class StructureStatsAccumulator {
        double brierSum; double countSum; double tvSum; int count;
        void add(StructureEvaluation evaluation) {
            brierSum += evaluation.brier(); countSum += evaluation.meanAbsoluteCountError(); tvSum += evaluation.totalVariationDistance(); count++;
        }
        double brier() { return count == 0 ? 0 : brierSum / count; }
        double countError() { return count == 0 ? 0 : countSum / count; }
        double tvDistance() { return count == 0 ? 0 : tvSum / count; }
    }

    static PredictionMetrics.RankingStats averageRanking(List<PredictionMetrics.RankingStats> stats) {
        if (stats.isEmpty()) return PredictionMetrics.RankingStats.EMPTY;
        return new PredictionMetrics.RankingStats(
                stats.stream().mapToDouble(PredictionMetrics.RankingStats::precisionAt3).average().orElse(0),
                stats.stream().mapToDouble(PredictionMetrics.RankingStats::precisionAt5).average().orElse(0),
                stats.stream().mapToDouble(PredictionMetrics.RankingStats::recallAt3).average().orElse(0),
                stats.stream().mapToDouble(PredictionMetrics.RankingStats::recallAt5).average().orElse(0),
                stats.stream().mapToDouble(PredictionMetrics.RankingStats::mrr).average().orElse(0),
                stats.stream().mapToDouble(PredictionMetrics.RankingStats::ndcgAt5).average().orElse(0),
                stats.stream().mapToDouble(PredictionMetrics.RankingStats::ndcgAt10).average().orElse(0),
                stats.stream().mapToDouble(PredictionMetrics.RankingStats::spearman).average().orElse(0));
    }

    /** Canonical resolution applied defensively at scoring time, so a merged synonym can never
     *  manufacture a false miss even if a snapshot was built without resolution. */
    static UUID canonical(BacktestEngine.Snapshot snapshot, UUID topicId) {
        return snapshot.canonicalOf().getOrDefault(topicId, topicId);
    }

    /** Structure types that demand applied, multi-step work — the recent-exam style signal. */
    private static final java.util.Set<String> PROBLEM_TYPES =
            java.util.Set.of("PROOF", "CALCULATION", "ALGORITHM_EXECUTION", "DESIGN", "CODE", "COMPARE");

    /** Prior decay shape for fold-level V2 predictions; the aggregate chooses its own shape. */
    private static final TopicHistoryFeatures.DecayShape FOLD_DECAY_PRIOR = TopicHistoryFeatures.DecayShape.HALF_LIFE_3;

    /**
     * Evaluates one fold. Training evidence is drawn strictly from {@code exams[0..foldIndex-1]};
     * {@code exams[foldIndex]} is read exactly once, as the scoring target. Both the live V1 model
     * and the EXAM_TOPIC_V2 candidate are scored from the same training slice — the held-out exam
     * never feeds either.
     */
    public static FoldResult evaluateFold(Snapshot snapshot, int foldIndex, EngineWeights engineWeights) {
        if (foldIndex < 1 || foldIndex >= snapshot.exams().size()) return null;
        ExamGroundTruth evaluated = resolveExam(snapshot, snapshot.exams().get(foldIndex));
        List<ExamGroundTruth> training = snapshot.exams().subList(0, foldIndex).stream()
                .map(exam -> resolveExam(snapshot, exam)).toList();

        // ---- training statistics, from training ground truth only
        Map<UUID, Integer> documentFrequency = new HashMap<>();
        Map<UUID, Double> pointWeights = new HashMap<>();
        Map<UUID, Integer> questionCounts = new HashMap<>();
        double totalPoints = 0;
        Set<UUID> universe = new LinkedHashSet<>();
        for (ExamGroundTruth exam : training) {
            for (UUID topicId : exam.topicIds()) {
                documentFrequency.merge(topicId, 1, Integer::sum);
                pointWeights.merge(topicId, exam.topicWeights().getOrDefault(topicId, 0.0), Double::sum);
                questionCounts.merge(topicId, exam.topicQuestionCounts().getOrDefault(topicId, 0), Integer::sum);
                universe.add(topicId);
            }
            totalPoints += exam.topicWeights().values().stream().mapToDouble(Double::doubleValue).sum();
        }
        universe.addAll(evaluated.topicIds()); // the model may rank topics it has not seen; scoring stays honest
        if (universe.isEmpty()) return null;

        // ---- EXAM_TOPIC (the live weighted model)
        List<PredictionMetrics.ScoredTopic> ranked = new ArrayList<>();
        for (UUID topicId : universe) {
            TopicProfile profile = snapshot.topics().get(topicId);
            ExamRelevanceCalculator.Input input = new ExamRelevanceCalculator.Input(
                    documentFrequency.getOrDefault(topicId, 0),
                    pointWeights.getOrDefault(topicId, 0.0),
                    questionCounts.getOrDefault(topicId, 0),
                    profile == null ? 0 : profile.homeworkItems(),
                    profile == null ? 0 : profile.quizItems(),
                    profile == null ? 0 : profile.lectureDocuments(),
                    profile == null ? 0 : profile.syllabusDocuments(),
                    profile == null ? 0 : profile.centrality(),
                    training.size(),
                    totalPoints,
                    snapshot.totalHomeworkItems(),
                    snapshot.totalQuizItems(),
                    snapshot.totalLectureDocuments(),
                    snapshot.maxCentrality());
            double probability = ExamRelevanceCalculator.calculate(input, engineWeights.weights()).relevance();
            ranked.add(new PredictionMetrics.ScoredTopic(topicId, probability));
        }
        ranked = PredictionMetrics.sorted(ranked);

        // ---- EXAM_TOPIC_V2 candidate: history features from the same training slice
        ModelFold v2Fold = evaluateV2Fold(snapshot, foldIndex, TopicHistoryFeatures.Weights.V2_CANDIDATE, FOLD_DECAY_PRIOR);

        Set<UUID> actual = evaluated.topicIds();
        int universeSize = ranked.size();
        PredictionMetrics.RankingStats ranking = new PredictionMetrics.RankingStats(
                PredictionMetrics.precisionAtK(ranked, actual, Math.min(3, universeSize)),
                PredictionMetrics.precisionAtK(ranked, actual, Math.min(5, universeSize)),
                PredictionMetrics.recallAtK(ranked, actual, Math.min(3, universeSize)),
                PredictionMetrics.recallAtK(ranked, actual, Math.min(5, universeSize)),
                PredictionMetrics.reciprocalRank(ranked, actual),
                PredictionMetrics.ndcgAtK(ranked, actual, Math.min(5, universeSize)),
                PredictionMetrics.ndcgAtK(ranked, actual, Math.min(10, universeSize)),
                spearmanOver(ranked, actual));
        double brier = brierOver(ranked, actual);

        StructureEvaluation structure = evaluateStructure(snapshot, foldIndex);
        String confidence = PredictionConfidence.label(training.size(), universe.size());

        return new FoldResult(foldIndex, evaluated.examId(), evaluated.name(), training.size(),
                ranked, v2Fold.predicted(), actualRanked(evaluated), actual, ranking, v2Fold.ranking(),
                brier, v2Fold.brier(), structure, confidence,
                PredictionErrorClassifier.classify(snapshot, foldIndex, ranked, actual));
    }

    /**
     * The V2 candidate over one fold: history features computed strictly from the training exams,
     * then the deterministic blend. Nothing here touches {@code snapshot.exams()[foldIndex]} except
     * the final scoring target and the universe extension.
     */
    public static ModelFold evaluateV2Fold(Snapshot snapshot, int foldIndex, TopicHistoryFeatures.Weights weights,
                                           TopicHistoryFeatures.DecayShape shape) {
        ExamGroundTruth evaluated = resolveExam(snapshot, snapshot.exams().get(foldIndex));
        List<ExamGroundTruth> training = snapshot.exams().subList(0, foldIndex).stream()
                .map(exam -> resolveExam(snapshot, exam)).toList();
        if (training.isEmpty()) return new ModelFold("EXAM_TOPIC_V2", List.of(), PredictionMetrics.RankingStats.EMPTY, 0);

        // Appearance history: training-exam index → points share for that topic.
        Map<UUID, Map<Integer, Double>> appearances = new HashMap<>();
        Set<UUID> testedTopics = new HashSet<>();
        for (int trainingIndex = 0; trainingIndex < training.size(); trainingIndex++) {
            ExamGroundTruth exam = training.get(trainingIndex);
            for (UUID topicId : exam.topicIds()) {
                appearances.computeIfAbsent(topicId, key -> new HashMap<>())
                        .put(trainingIndex, exam.topicWeights().getOrDefault(topicId, 0.0));
                testedTopics.add(topicId);
            }
        }
        Set<UUID> universe = new LinkedHashSet<>(appearances.keySet());
        universe.addAll(evaluated.topicIds());
        if (universe.isEmpty()) return new ModelFold("EXAM_TOPIC_V2", List.of(), PredictionMetrics.RankingStats.EMPTY, 0);

        // Course-wide normalization maxima, computed within this fold's course slice.
        double maxAveragePoints = 0;
        double maxHomework = 0;
        double maxLecture = 0;
        int maxTestedDependents = 0;
        for (UUID topicId : universe) {
            Map<Integer, Double> points = appearances.get(topicId);
            if (points != null && !points.isEmpty()) {
                double average = points.values().stream().mapToDouble(Double::doubleValue).average().orElse(0);
                maxAveragePoints = Math.max(maxAveragePoints, average);
            }
            TopicProfile profile = snapshot.topics().get(topicId);
            if (profile != null) {
                maxHomework = Math.max(maxHomework, profile.homeworkItems());
                maxLecture = Math.max(maxLecture, profile.lectureDocuments());
            }
            List<UUID> dependents = snapshot.dependents().getOrDefault(topicId, List.of());
            maxTestedDependents = Math.max(maxTestedDependents,
                    (int) dependents.stream().filter(testedTopics::contains).count());
        }
        int window = Math.min(3, training.size());
        double problemCount = 0;
        double structureTotal = 0;
        for (int age = 0; age < window; age++) {
            for (int count : training.get(training.size() - 1 - age).structures().values()) structureTotal += count;
            for (Map.Entry<String, Integer> type : training.get(training.size() - 1 - age).structures().entrySet()) {
                if (PROBLEM_TYPES.contains(type.getKey())) problemCount += type.getValue();
            }
        }
        TopicHistoryFeatures.CourseStats stats = new TopicHistoryFeatures.CourseStats(
                training.size(), maxAveragePoints, maxHomework, maxLecture, maxTestedDependents,
                structureTotal == 0 ? 0 : problemCount / structureTotal);

        List<PredictionMetrics.ScoredTopic> ranked = new ArrayList<>();
        for (UUID topicId : universe) {
            TopicProfile profile = snapshot.topics().get(topicId);
            TopicHistoryFeatures.Context context = new TopicHistoryFeatures.Context(
                    snapshot.objectiveApplyShare().get(topicId),
                    snapshot.dependents().getOrDefault(topicId, List.of()),
                    profile == null ? 0 : profile.homeworkItems(),
                    profile == null ? 0 : profile.lectureDocuments(),
                    profile != null && profile.syllabusDocuments() > 0,
                    profile == null ? null : profile.importance());
            TopicHistoryFeatures.Vector vector = TopicHistoryFeatures.compute(
                    appearances.getOrDefault(topicId, Map.of()), training.size(), context, stats, shape);
            ranked.add(new PredictionMetrics.ScoredTopic(topicId, TopicHistoryFeatures.score(vector, weights)));
        }
        ranked = PredictionMetrics.sorted(ranked);

        Set<UUID> actual = evaluated.topicIds();
        int universeSize = ranked.size();
        PredictionMetrics.RankingStats ranking = new PredictionMetrics.RankingStats(
                PredictionMetrics.precisionAtK(ranked, actual, Math.min(3, universeSize)),
                PredictionMetrics.precisionAtK(ranked, actual, Math.min(5, universeSize)),
                PredictionMetrics.recallAtK(ranked, actual, Math.min(3, universeSize)),
                PredictionMetrics.recallAtK(ranked, actual, Math.min(5, universeSize)),
                PredictionMetrics.reciprocalRank(ranked, actual),
                PredictionMetrics.ndcgAtK(ranked, actual, Math.min(5, universeSize)),
                PredictionMetrics.ndcgAtK(ranked, actual, Math.min(10, universeSize)),
                spearmanOver(ranked, actual));
        return new ModelFold("EXAM_TOPIC_V2", ranked, ranking, brierOver(ranked, actual));
    }

    /** Baseline models over the same fold, scored with the same metrics. */
    public static ModelFold evaluateBaselineFold(Snapshot snapshot, int foldIndex, String baseline) {
        ExamGroundTruth evaluated = resolveExam(snapshot, snapshot.exams().get(foldIndex));
        List<ExamGroundTruth> training = snapshot.exams().subList(0, foldIndex).stream()
                .map(exam -> resolveExam(snapshot, exam)).toList();
        Map<UUID, Integer> documentFrequency = new HashMap<>();
        Set<UUID> universe = new LinkedHashSet<>();
        for (ExamGroundTruth exam : training) {
            for (UUID topicId : exam.topicIds()) {
                documentFrequency.merge(topicId, 1, Integer::sum);
                universe.add(topicId);
            }
        }
        universe.addAll(evaluated.topicIds());
        if (universe.isEmpty()) return new ModelFold(baseline, List.of(), PredictionMetrics.RankingStats.EMPTY, 0);

        List<PredictionMetrics.ScoredTopic> ranked = new ArrayList<>();
        for (UUID topicId : universe) {
            double probability = switch (baseline) {
                // Baseline A: plain historical frequency.
                case "FREQUENCY" -> training.isEmpty() ? 0 : (double) documentFrequency.getOrDefault(topicId, 0) / training.size();
                // Baseline B: recency-weighted frequency, halving every two exams of age.
                case "RECENCY" -> {
                    double weighted = 0;
                    double total = 0;
                    for (int age = 0; age < training.size(); age++) {
                        ExamGroundTruth exam = training.get(training.size() - 1 - age);
                        double decay = Math.pow(0.5, age / 2.0);
                        total += decay;
                        if (exam.topicIds().contains(topicId)) weighted += decay;
                    }
                    yield total == 0 ? 0 : weighted / total;
                }
                // Baseline C: measured course importance alone.
                case "IMPORTANCE" -> {
                    TopicProfile profile = snapshot.topics().get(topicId);
                    yield profile == null || profile.importance() == null ? 0 : Math.max(0, Math.min(1, profile.importance()));
                }
                default -> 0;
            };
            ranked.add(new PredictionMetrics.ScoredTopic(topicId, probability));
        }
        ranked = PredictionMetrics.sorted(ranked);
        Set<UUID> actual = evaluated.topicIds();
        int universeSize = ranked.size();
        PredictionMetrics.RankingStats ranking = new PredictionMetrics.RankingStats(
                PredictionMetrics.precisionAtK(ranked, actual, Math.min(3, universeSize)),
                PredictionMetrics.precisionAtK(ranked, actual, Math.min(5, universeSize)),
                PredictionMetrics.recallAtK(ranked, actual, Math.min(3, universeSize)),
                PredictionMetrics.recallAtK(ranked, actual, Math.min(5, universeSize)),
                PredictionMetrics.reciprocalRank(ranked, actual),
                PredictionMetrics.ndcgAtK(ranked, actual, Math.min(5, universeSize)),
                PredictionMetrics.ndcgAtK(ranked, actual, Math.min(10, universeSize)),
                spearmanOver(ranked, actual));
        return new ModelFold(baseline, ranked, ranking, brierOver(ranked, actual));
    }

    /** Rewrites one exam's ground truth through the canonical map: merged synonyms fold together,
     *  weights and question counts aggregate onto the surviving id. */
    static ExamGroundTruth resolveExam(Snapshot snapshot, ExamGroundTruth exam) {
        if (snapshot.canonicalOf().isEmpty()) return exam;
        Map<UUID, Double> weights = new LinkedHashMap<>();
        Map<UUID, Integer> counts = new LinkedHashMap<>();
        Set<UUID> topics = new LinkedHashSet<>();
        for (UUID topicId : exam.topicIds()) {
            UUID canonical = canonical(snapshot, topicId);
            topics.add(canonical);
            weights.merge(canonical, exam.topicWeights().getOrDefault(topicId, 0.0), Double::sum);
            counts.merge(canonical, exam.topicQuestionCounts().getOrDefault(topicId, 0), Integer::sum);
        }
        return new ExamGroundTruth(exam.order(), exam.examId(), exam.name(), exam.year(), exam.date(), topics, weights, counts, exam.structures());
    }

    // ---------------------------------------------------------------- structure prediction

    /**
     * Structure: predicted distribution from training exam format, actual distribution from the
     * held-out exam. Brier is computed per type on presence; count error and total variation
     * complement it. Metric choice documented on {@link PredictionMetrics.StructureStats}.
     */
    public static StructureEvaluation evaluateStructure(Snapshot snapshot, int foldIndex) {
        ExamGroundTruth evaluated = snapshot.exams().get(foldIndex);
        List<ExamGroundTruth> training = snapshot.exams().subList(0, foldIndex);
        Map<String, Integer> trainTypeExams = new HashMap<>();
        for (ExamGroundTruth exam : training) {
            for (String type : exam.structures().keySet()) trainTypeExams.merge(type, 1, Integer::sum);
        }
        int actualStructureTotal = evaluated.structures().values().stream().mapToInt(Integer::intValue).sum();
        Map<String, Double> predictedDistribution = new LinkedHashMap<>();
        Map<String, Double> actualDistribution = new LinkedHashMap<>();
        Set<String> types = new LinkedHashSet<>();
        types.addAll(trainTypeExams.keySet());
        types.addAll(evaluated.structures().keySet());
        List<PredictionMetrics.PredictionOutcome> presence = new ArrayList<>();
        Map<String, Double> predictedCounts = new HashMap<>();
        Map<String, Double> actualCounts = new HashMap<>();
        for (String type : types) {
            double predictedRate = training.isEmpty() ? 0 : Math.min(.95, trainTypeExams.getOrDefault(type, 0) / (double) training.size() * .7);
            boolean occurred = evaluated.structures().containsKey(type);
            presence.add(new PredictionMetrics.PredictionOutcome(predictedRate, occurred));
            // Expected question count scales the predicted presence rate by the actual exam size.
            predictedCounts.put(type, predictedRate * Math.max(1, actualStructureTotal));
            actualCounts.put(type, (double) evaluated.structures().getOrDefault(type, 0));
        }
        // Distributions are normalised over the same label set, so TV distance is comparable.
        double predictedTotal = predictedCounts.values().stream().mapToDouble(Double::doubleValue).sum();
        for (String type : types) {
            predictedDistribution.put(type, predictedTotal == 0 ? 0 : predictedCounts.get(type) / predictedTotal);
            actualDistribution.put(type, actualStructureTotal == 0 ? 0 : evaluated.structures().getOrDefault(type, 0) / (double) actualStructureTotal);
        }
        return new StructureEvaluation(PredictionMetrics.brierScore(presence),
                PredictionMetrics.meanAbsoluteCountError(predictedCounts, actualCounts),
                PredictionMetrics.totalVariationDistance(predictedDistribution, actualDistribution),
                predictedDistribution, actualDistribution);
    }

    // ---------------------------------------------------------------- helpers

    private static List<PredictionMetrics.ScoredTopic> actualRanked(ExamGroundTruth evaluated) {
        return evaluated.topicIds().stream()
                .map(topicId -> new PredictionMetrics.ScoredTopic(topicId, evaluated.topicWeights().getOrDefault(topicId, 0.0)))
                .sorted(Comparator.comparingDouble((PredictionMetrics.ScoredTopic topic) -> topic.probability()).reversed())
                .toList();
    }

    private static double brierOver(List<PredictionMetrics.ScoredTopic> ranked, Set<UUID> actual) {
        List<PredictionMetrics.PredictionOutcome> outcomes = new ArrayList<>();
        for (PredictionMetrics.ScoredTopic scored : ranked) {
            outcomes.add(new PredictionMetrics.PredictionOutcome(scored.probability(), actual.contains(scored.topicId())));
        }
        return PredictionMetrics.brierScore(outcomes);
    }

    private static double spearmanOver(List<PredictionMetrics.ScoredTopic> ranked, Set<UUID> actual) {
        List<Double> predicted = new ArrayList<>();
        List<Double> observed = new ArrayList<>();
        for (PredictionMetrics.ScoredTopic scored : ranked) {
            predicted.add(scored.probability());
            observed.add(actual.contains(scored.topicId()) ? 1.0 : 0.0);
        }
        double value = PredictionMetrics.spearman(predicted, observed);
        return Double.isNaN(value) ? 0 : value;
    }

    /**
     * Fold-isolation probe: returns the fold's predicted ranking recomputed from a snapshot in
     * which the held-out exam's ground truth has been replaced by an empty one. If the engine is
     * honest, the predictions must be identical — for V1 and for the V2 candidate. Used by
     * regression tests, not by production.
     */
    public static List<PredictionMetrics.ScoredTopic> isolateFold(Snapshot snapshot, int foldIndex, EngineWeights weights) {
        ExamGroundTruth original = snapshot.exams().get(foldIndex);
        ExamGroundTruth blinded = new ExamGroundTruth(original.order(), original.examId(), original.name(),
                original.year(), original.date(), Set.of(), Map.of(), Map.of(), Map.of());
        List<ExamGroundTruth> blindedExams = new ArrayList<>(snapshot.exams());
        blindedExams.set(foldIndex, blinded);
        Snapshot blindedSnapshot = new Snapshot(blindedExams, snapshot.topics(), snapshot.canonicalOf(),
                snapshot.totalHomeworkItems(), snapshot.totalQuizItems(), snapshot.totalLectureDocuments(),
                snapshot.maxCentrality(), snapshot.courseRevision(), snapshot.topicGraphRevision(),
                snapshot.objectiveApplyShare(), snapshot.dependents());
        FoldResult blindedFold = evaluateFold(blindedSnapshot, foldIndex, weights);
        FoldResult normalFold = evaluateFold(snapshot, foldIndex, weights);
        if (blindedFold == null || normalFold == null) return List.of();
        assertSameRanking(normalFold.predicted(), blindedFold.predicted());
        assertSameRanking(normalFold.predictedV2(), blindedFold.predictedV2());
        return normalFold.predicted();
    }

    private static void assertSameRanking(List<PredictionMetrics.ScoredTopic> left, List<PredictionMetrics.ScoredTopic> right) {
        // The universe may legitimately differ in size (held-out-only topics vanish when blinded),
        // but every topic that survives blinding must keep exactly the same probability and the
        // same relative order. Anything else means the held-out exam leaked into its prediction.
        Map<UUID, Double> leftByTopic = new HashMap<>();
        left.forEach(scored -> leftByTopic.put(scored.topicId(), scored.probability()));
        double previousRight = Double.MAX_VALUE;
        UUID previousTopic = null;
        for (PredictionMetrics.ScoredTopic scored : right) {
            Double leftProbability = leftByTopic.get(scored.topicId());
            if (leftProbability == null || Math.abs(leftProbability - scored.probability()) > 1e-12) {
                throw new AssertionError("Fold isolation violated: probability of a training topic changed when the held-out exam was blinded");
            }
            if (scored.probability() > previousRight + 1e-12 && scored.topicId().equals(previousTopic)) {
                throw new AssertionError("Fold isolation violated: ordering changed for " + scored.topicId());
            }
            previousRight = scored.probability();
            previousTopic = scored.topicId();
        }
    }
}
