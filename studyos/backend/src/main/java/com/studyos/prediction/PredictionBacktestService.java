package com.studyos.prediction;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.assessment.ExamRelevanceCalculator;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Persists and orchestrates walk-forward backtests over a course's historical exams.
 *
 * <p>Every run is a new row — nothing is overwritten — and every run is observational: this service
 * only reads exam history, topics and signals, and writes its own tables. Learner mastery and live
 * prediction state are never touched. The report carries the full engineering picture: per-fold
 * and aggregate metrics for the live model and the three baselines, calibration buckets, drift,
 * style signals, error classification, sensitivity grids, and the fitting policy verdict.
 */
@Service
public class PredictionBacktestService {
    /** The live model version this service evaluates. Any successor must win its held-out backtest. */
    public static final String MODEL_VERSION = "EXAM_TOPIC_V1";

    private static final Logger log = LoggerFactory.getLogger(PredictionBacktestService.class);

    private final JdbcTemplate jdbc;
    private final ExamGroundTruthService groundTruth;
    private final ObjectMapper mapper;

    public PredictionBacktestService(JdbcTemplate jdbc, ExamGroundTruthService groundTruth, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.groundTruth = groundTruth;
        this.mapper = mapper;
    }

    public record BacktestReport(UUID runId, String modelVersion, String status, String confidenceLabel,
                                 int historicalExams, int foldsEvaluated,
                                 PredictionMetrics.RankingStats ranking, double brier,
                                 List<PredictionMetrics.CalibrationBucket> calibration,
                                 double structureBrier, double structureCountError, double structureTvDistance,
                                 Map<String, PredictionMetrics.RankingStats> baselineRanking,
                                 Map<String, Double> baselineBrier,
                                 DriftAnalyzer.DriftReport drift,
                                 StyleSignalAnalyzer.StyleReport styleSignals,
                                 List<BacktestEngine.FoldResult> folds,
                                 String fittingPolicy, List<String> notes,
                                 double durationMs, String fixtureHash) {}

    /** Runs, persists and returns a backtest. Each call appends a new run row. */
    public BacktestReport backtest(UUID workspaceId, String fixtureHash) {
        BacktestEngine.Snapshot snapshot = groundTruth.snapshot(workspaceId);
        if (snapshot.exams().size() < 2) {
            return new BacktestReport(null, MODEL_VERSION, "INSUFFICIENT_EVIDENCE", "LOW",
                    snapshot.exams().size(), 0, PredictionMetrics.RankingStats.EMPTY, 0, List.of(), 0, 0, 0,
                    Map.of(), Map.of(), DriftAnalyzer.analyze(snapshot.exams()), StyleSignalAnalyzer.analyze(snapshot.exams()),
                    List.of(), WeightFittingPolicy.rationale(snapshot.exams().size()),
                    List.of("At least two historical exams are needed for a walk-forward backtest."), 0, fixtureHash);
        }
        BacktestEngine.BacktestResult result = BacktestEngine.run(snapshot, BacktestEngine.EngineWeights.v1());
        String fittingPolicy = WeightFittingPolicy.rationale(snapshot.exams().size());
        List<String> notes = new ArrayList<>();
        if (snapshot.exams().size() < 3) notes.add("Only " + snapshot.exams().size() + " historical exams: every figure here is low-confidence.");
        if (snapshot.exams().size() >= 10) notes.add("Ten or more historical exams: calibration figures are meaningful.");

        UUID runId = persist(workspaceId, snapshot, result, fittingPolicy, notes, fixtureHash);

        // The V1 verdict on the baselines, stated plainly: did the weighted model earn its complexity?
        notes.add(baselineVerdict(result));
        // The V2 candidate verdict: measured on the same folds, adopted only if it wins AND the
        // fitting policy allows adoption at this history size.
        notes.add(v2Verdict(workspaceId, snapshot, result, runId));

        return new BacktestReport(runId, MODEL_VERSION, "BACKTESTED",
                PredictionConfidence.label(snapshot.exams().size(), result.aggregate() == null ? 0 : 1),
                snapshot.exams().size(), result.foldCount(), result.aggregate(), result.brier(),
                result.calibration(), result.structureBrier(), result.structureCountError(), result.structureTvDistance(),
                result.baselineRanking(), result.baselineBrier(), result.drift(), result.styleSignals(),
                result.folds(), fittingPolicy, notes, result.durationMs(), fixtureHash);
    }

    /** Plain language: EXAM_TOPIC_V2 is a candidate until it wins held-out folds AND the fitting policy allows. */
    private String v2Verdict(UUID workspaceId, BacktestEngine.Snapshot snapshot, BacktestEngine.BacktestResult result, UUID runId) {
        BacktestEngine.V2Result v2 = result.v2();
        if (v2 == null || v2.chosenDecayShape() == null) return "EXAM_TOPIC_V2 candidate: not evaluable on this corpus (no folds).";
        boolean winsNdcg = v2.aggregate().ndcgAt5() > result.aggregate().ndcgAt5();
        boolean brierNotWorse = v2.brier() <= result.brier() + 0.005;
        String outcome = winsNdcg && brierNotWorse ? "beats" : winsNdcg ? "beats on NDCG@5 but not on Brier" : "does NOT beat";
        String message = String.format(
                "EXAM_TOPIC_V2 candidate (decay %s: NDCG@5 %.3f, Brier %.4f) %s EXAM_TOPIC_V1 (%.3f, %.4f) on held-out folds.",
                v2.chosenDecayShape(), v2.aggregate().ndcgAt5(), v2.brier(), outcome,
                result.aggregate().ndcgAt5(), result.brier());
        if (winsNdcg && brierNotWorse) {
            registerModelVersion(workspaceId, "EXAM_TOPIC_V2",
                    com.studyos.assessment.ExamRelevanceCalculator.Weights.V1_DEFAULTS,
                    "CANDIDATE — won its held-out backtest (run " + runId + "); adoption waits for the fitting policy on real exams",
                    v2, json(Map.of("decayShape", v2.chosenDecayShape(),
                            "byDecayShape", v2.byDecayShape(),
                            "historicalExams", snapshot.exams().size())));
            message += " Registered as a candidate model version; the live model changes only when the fitting policy allows adoption.";
        }
        return message;
    }

    /** Plain language: EXAM_TOPIC_V1 must beat FREQUENCY on held-out NDCG to justify its weights. */
    private String baselineVerdict(BacktestEngine.BacktestResult result) {
        Double frequencyNdcg = result.baselineRanking().get("FREQUENCY") == null ? null : result.baselineRanking().get("FREQUENCY").ndcgAt5();
        Double recencyNdcg = result.baselineRanking().get("RECENCY") == null ? null : result.baselineRanking().get("RECENCY").ndcgAt5();
        double v1Ndcg = result.aggregate().ndcgAt5();
        if (frequencyNdcg == null) return "Baselines were not evaluated.";
        if (v1Ndcg > frequencyNdcg && v1Ndcg > recencyNdcg) {
            return String.format("EXAM_TOPIC_V1 (NDCG@5 %.3f) beats the frequency (%.3f) and recency (%.3f) baselines on held-out folds; its extra factors earn their place.", v1Ndcg, frequencyNdcg, recencyNdcg);
        }
        if (v1Ndcg <= frequencyNdcg) {
            return String.format("EXAM_TOPIC_V1 (NDCG@5 %.3f) does NOT beat the frequency baseline (%.3f) on held-out folds. The weighted model has not yet earned its complexity for this corpus.", v1Ndcg, frequencyNdcg);
        }
        return String.format("EXAM_TOPIC_V1 (NDCG@5 %.3f) beats frequency (%.3f) but not recency weighting (%.3f); recency deserves a calibration experiment.", v1Ndcg, frequencyNdcg, recencyNdcg);
    }

    private UUID persist(UUID courseId, BacktestEngine.Snapshot snapshot, BacktestEngine.BacktestResult result,
                         String fittingPolicy, List<String> notes, String fixtureHash) {
        try {
            UUID runId = UUID.randomUUID();
            Map<String, Object> baselineComparison = new LinkedHashMap<>();
            result.baselineRanking().forEach((model, stats) -> baselineComparison.put(model, stats));
            if (result.v2() != null && result.v2().chosenDecayShape() != null) {
                Map<String, Object> v2 = new LinkedHashMap<>();
                v2.put("ranking", result.v2().aggregate());
                v2.put("brier", result.v2().brier());
                v2.put("chosenDecayShape", result.v2().chosenDecayShape());
                v2.put("byDecayShape", result.v2().byDecayShape());
                v2.put("brierByDecayShape", result.v2().brierByDecayShape());
                baselineComparison.put("EXAM_TOPIC_V2", v2);
            }
            String config = mapper.writeValueAsString(Map.of(
                    "modelVersion", MODEL_VERSION,
                    "weights", ExamRelevanceCalculator.Weights.V1_DEFAULTS.asMap(),
                    "extractionVersion", com.studyos.knowledge.TopicCandidateQuality.VERSION,
                    "examIds", snapshot.exams().stream().map(exam -> exam.examId().toString()).toList(),
                    "courseRevision", snapshot.courseRevision(),
                    "topicGraphRevision", snapshot.topicGraphRevision(),
                    "fittingPolicy", fittingPolicy,
                    "notes", notes));
            jdbc.update("""
                    INSERT INTO prediction_backtest_runs(id,course_id,model_version,exam_count,fold_count,status,
                        precision_at_3,precision_at_5,recall_at_3,recall_at_5,mrr,ndcg_at_5,ndcg_at_10,spearman,brier,
                        structure_brier,calibration_error,calibration_json,baseline_comparison,drift,error_analysis,
                        config_snapshot,fixture_hash,duration_ms)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CAST(? AS jsonb),CAST(? AS jsonb),CAST(? AS jsonb),CAST(? AS jsonb),CAST(? AS jsonb),?,?)
                    """,
                    runId, courseId, MODEL_VERSION, result.examCount(), result.foldCount(), "COMPLETED",
                    result.aggregate().precisionAt3(), result.aggregate().precisionAt5(),
                    result.aggregate().recallAt3(), result.aggregate().recallAt5(),
                    result.aggregate().mrr(), result.aggregate().ndcgAt5(), result.aggregate().ndcgAt10(),
                    result.aggregate().spearman(), result.brier(),
                    result.structureBrier(), calibrationError(result.calibration()),
                    json(result.calibration()), json(baselineComparison), json(result.drift()), json(errorSummary(result)),
                    config, fixtureHash, Math.round(result.durationMs()));
            for (BacktestEngine.FoldResult fold : result.folds()) {
                jdbc.update("""
                        INSERT INTO prediction_backtest_folds(id,run_id,exam_index,exam_id,exam_name,training_exams,
                            predicted,actual,metrics,structure_metrics,confidence,errors)
                        VALUES(?,?,?,?,?,?,CAST(? AS jsonb),CAST(? AS jsonb),CAST(? AS jsonb),CAST(? AS jsonb),?,CAST(? AS jsonb))
                        """,
                        UUID.randomUUID(), runId, fold.examIndex(), fold.examId(), fold.examName(), fold.trainingExams(),
                        json(fold.predicted()), json(fold.actual()),
                        json(Map.of("v1", fold.ranking(), "v2", fold.rankingV2())),
                        json(fold.structure()), fold.confidenceLabel(), json(fold.errors()));
            }
            return runId;
        } catch (Exception error) {
            log.warn("Backtest run could not be persisted for course {}: {}", courseId, error.getMessage());
            return null;
        }
    }

    private Map<String, Integer> errorSummary(BacktestEngine.BacktestResult result) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (BacktestEngine.FoldResult fold : result.folds()) {
            for (PredictionErrorClassifier.ClassifiedMiss miss : fold.errors()) {
                counts.merge(miss.category().name(), 1, Integer::sum);
            }
        }
        return counts;
    }

    private double calibrationError(List<PredictionMetrics.CalibrationBucket> buckets) {
        return PredictionMetrics.calibrationError(buckets);
    }

    private String json(Object value) {
        try { return mapper.writeValueAsString(value); } catch (Exception error) { return "{}"; }
    }

    /** Persisted runs, newest first. History is never rewritten. */
    public List<Map<String, Object>> runs(UUID courseId) {
        return jdbc.queryForList("""
                SELECT id, model_version, exam_count, fold_count, precision_at_5, recall_at_5, ndcg_at_5,
                       ndcg_at_10, mrr, spearman, brier, structure_brier, calibration_error,
                       fixture_hash, duration_ms, created_at
                FROM prediction_backtest_runs WHERE course_id=? ORDER BY created_at DESC LIMIT 20
                """, courseId);
    }

    /** Weight sensitivity over the same snapshot: measurement, not tuning. */
    public WeightSensitivity.SensitivityReport sensitivity(UUID workspaceId) {
        return WeightSensitivity.analyze(groundTruth.snapshot(workspaceId));
    }

    /** V2 candidate sensitivity: one new coefficient at a time over the same held-out folds. */
    public WeightSensitivity.V2SensitivityReport v2Sensitivity(UUID workspaceId) {
        return WeightSensitivity.analyzeV2(groundTruth.snapshot(workspaceId));
    }

    /** The data-requirement verdict for this course's history size. */
    public String fittingPolicyVerdict(UUID workspaceId) {
        int exams = groundTruth.groundTruths(workspaceId).size();
        return WeightFittingPolicy.rationale(exams);
    }

    /** Registers a model version; deliberately explicit, never implicit. */
    public UUID registerModelVersion(UUID courseId, String modelVersion, ExamRelevanceCalculator.Weights weights,
                                     String basis, Object metrics, String corpusSummary) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO prediction_model_versions(id,model_version,course_id,weights,basis,evaluation_metrics,corpus_summary)
                VALUES(?,?,?,CAST(? AS jsonb),?,CAST(? AS jsonb),CAST(? AS jsonb)) ON CONFLICT (model_version, course_id) DO NOTHING
                """, id, modelVersion, courseId, json(weights.asMap()), basis, json(metrics), json(corpusSummary));
        return id;
    }

    public List<Map<String, Object>> modelVersions(UUID courseId) {
        return jdbc.queryForList("""
                SELECT model_version, weights::text AS weights, basis, evaluation_metrics::text AS evaluation_metrics,
                       corpus_summary::text AS corpus_summary, superseded_by, created_at
                FROM prediction_model_versions WHERE course_id=? OR course_id IS NULL ORDER BY created_at DESC
                """, courseId);
    }
}
