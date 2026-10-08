package com.studyos.prediction;

import com.studyos.assessment.ExamRelevanceCalculator;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Bounded weight-sensitivity analysis for the exam-topic model. This is measurement, not tuning:
 * one coefficient is varied inside a small, documented grid at a time, and the effect on held-out
 * NDCG/Brier/Precision@K is recorded. The verdict vocabulary is stable / sensitive / overfit, and
 * no weight change happens here — only evidence is produced.
 */
public final class WeightSensitivity {

    private WeightSensitivity() {}

    /** Bounded grids: a handful of values per coefficient, not a brute-force search. */
    public static final Map<String, List<Double>> GRIDS = Map.of(
            "pastFrequency", List.of(.20, .25, .30, .35, .40),
            "pastPoints", List.of(.10, .15, .20, .25),
            "homeworkFrequency", List.of(.05, .10, .15, .20),
            "lectureCoverage", List.of(.10, .15, .20),
            "professorEmphasis", List.of(.05, .10, .15),
            "syllabusImportance", List.of(.05, .10, .15),
            "centrality", List.of(.0, .05, .10));

    public record SensitivityRow(String coefficient, double value, PredictionMetrics.RankingStats ranking,
                                 double brier, double deltaNdcg5, double deltaBrier) {}

    public record SensitivityReport(String baselineModel, double baselineNdcg5, double baselineBrier,
                                    List<SensitivityRow> rows, String verdict, String summary) {}

    /** Stable: the metric moves less than this across the grid; sensitive: it moves more. */
    public static final double STABLE_NDCG_BAND = 0.01;
    public static final double SENSITIVE_NDCG_BAND = 0.03;

    public static SensitivityReport analyze(BacktestEngine.Snapshot snapshot) {
        BacktestEngine.EngineWeights baseline = BacktestEngine.EngineWeights.v1();
        BacktestEngine.BacktestResult base = BacktestEngine.run(snapshot, baseline);
        double baselineNdcg5 = base.aggregate().ndcgAt5();
        double baselineBrier = base.brier();

        List<SensitivityRow> rows = new ArrayList<>();
        double maxAbsNdcgDelta = 0;
        double maxAbsBrierDelta = 0;
        for (Map.Entry<String, List<Double>> grid : GRIDS.entrySet()) {
            for (Double value : grid.getValue()) {
                ExamRelevanceCalculator.Weights varied = varied(baseline.weights(), grid.getKey(), value);
                if (varied == null) continue;
                BacktestEngine.BacktestResult result = BacktestEngine.run(snapshot, new BacktestEngine.EngineWeights("SENSITIVITY_" + grid.getKey() + "=" + value, varied));
                double deltaNdcg = result.aggregate().ndcgAt5() - baselineNdcg5;
                double deltaBrier = result.brier() - baselineBrier;
                maxAbsNdcgDelta = Math.max(maxAbsNdcgDelta, Math.abs(deltaNdcg));
                maxAbsBrierDelta = Math.max(maxAbsBrierDelta, Math.abs(deltaBrier));
                rows.add(new SensitivityRow(grid.getKey(), value, result.aggregate(), result.brier(), deltaNdcg, deltaBrier));
            }
        }

        String verdict;
        String summary;
        if (base.foldCount() < 5) {
            verdict = "INSUFFICIENT_DATA";
            summary = "Only " + base.foldCount() + " fold(s): sensitivity numbers are indicative at best and must not drive weight changes.";
        } else if (maxAbsNdcgDelta <= STABLE_NDCG_BAND && maxAbsBrierDelta <= 0.005) {
            verdict = "STABLE";
            summary = "Metrics move within a " + STABLE_NDCG_BAND + " NDCG band across the grids; the model is not sensitive to single-coefficient changes.";
        } else if (maxAbsNdcgDelta >= SENSITIVE_NDCG_BAND) {
            verdict = "SENSITIVE";
            summary = String.format("Metrics move up to %.3f NDCG across the grids; individual coefficients meaningfully change behaviour.", maxAbsNdcgDelta);
        } else {
            verdict = "MILDLY_SENSITIVE";
            summary = String.format("Metrics move up to %.3f NDCG; the model is moderately sensitive to single-coefficient changes.", maxAbsNdcgDelta);
        }
        return new SensitivityReport(baseline.label(), baselineNdcg5, baselineBrier, rows, verdict, summary);
    }

    private static ExamRelevanceCalculator.Weights varied(ExamRelevanceCalculator.Weights base, String coefficient, double value) {
        return switch (coefficient) {
            case "pastFrequency" -> new ExamRelevanceCalculator.Weights(value, base.pastPoints(), base.homeworkFrequency(), base.lectureCoverage(), base.professorEmphasisShare(), base.syllabusImportance(), base.centrality());
            case "pastPoints" -> new ExamRelevanceCalculator.Weights(base.pastFrequency(), value, base.homeworkFrequency(), base.lectureCoverage(), base.professorEmphasisShare(), base.syllabusImportance(), base.centrality());
            case "homeworkFrequency" -> new ExamRelevanceCalculator.Weights(base.pastFrequency(), base.pastPoints(), value, base.lectureCoverage(), base.professorEmphasisShare(), base.syllabusImportance(), base.centrality());
            case "lectureCoverage" -> new ExamRelevanceCalculator.Weights(base.pastFrequency(), base.pastPoints(), base.homeworkFrequency(), value, base.professorEmphasisShare(), base.syllabusImportance(), base.centrality());
            case "professorEmphasis" -> new ExamRelevanceCalculator.Weights(base.pastFrequency(), base.pastPoints(), base.homeworkFrequency(), base.lectureCoverage(), value, base.syllabusImportance(), base.centrality());
            case "syllabusImportance" -> new ExamRelevanceCalculator.Weights(base.pastFrequency(), base.pastPoints(), base.homeworkFrequency(), base.lectureCoverage(), base.professorEmphasisShare(), value, base.centrality());
            case "centrality" -> new ExamRelevanceCalculator.Weights(base.pastFrequency(), base.pastPoints(), base.homeworkFrequency(), base.lectureCoverage(), base.professorEmphasisShare(), base.syllabusImportance(), value);
            default -> null;
        };
    }

    // ---------------------------------------------------------------- V2 candidate grids

    /** Bounded grids for the V2 candidate's new coefficients; recency stays grid-tested via decay shapes. */
    public static final Map<String, List<Double>> V2_GRIDS = Map.of(
            "momentum", List.of(.04, .10, .16),
            "spacing", List.of(.0, .05, .10),
            "points", List.of(.04, .10, .16),
            "style", List.of(.0, .05, .10),
            "unlock", List.of(.0, .05, .10),
            "omission", List.of(.0, .04, .08));

    public record V2SensitivityRow(String coefficient, double value, PredictionMetrics.RankingStats ranking, double brier,
                                   double deltaNdcg5, double deltaBrier) {}

    public record V2SensitivityReport(double baselineNdcg5, double baselineBrier, List<V2SensitivityRow> rows,
                                      String chosenDecayShape, Map<String, PredictionMetrics.RankingStats> byDecayShape,
                                      String verdict, String summary) {}

    /** Measurement, not tuning: one V2 coefficient at a time over the same held-out folds. */
    public static V2SensitivityReport analyzeV2(BacktestEngine.Snapshot snapshot) {
        BacktestEngine.V2Result base = BacktestEngine.v2Result(snapshot, List.of());
        double baselineNdcg5 = base.aggregate().ndcgAt5();
        double baselineBrier = base.brier();
        TopicHistoryFeatures.DecayShape shape = shapeOf(base.chosenDecayShape());

        List<V2SensitivityRow> rows = new ArrayList<>();
        double maxAbsNdcgDelta = 0;
        for (Map.Entry<String, List<Double>> grid : V2_GRIDS.entrySet()) {
            for (Double value : grid.getValue()) {
                TopicHistoryFeatures.Weights varied = varyV2(TopicHistoryFeatures.Weights.V2_CANDIDATE, grid.getKey(), value);
                if (varied == null) continue;
                List<PredictionMetrics.RankingStats> stats = new ArrayList<>();
                List<Double> briers = new ArrayList<>();
                for (int index = 1; index < snapshot.exams().size(); index++) {
                    BacktestEngine.ModelFold fold = BacktestEngine.evaluateV2Fold(snapshot, index, varied, shape);
                    stats.add(fold.ranking());
                    briers.add(fold.brier());
                }
                PredictionMetrics.RankingStats aggregate = BacktestEngine.averageRanking(stats);
                double shapeBrier = briers.stream().mapToDouble(Double::doubleValue).average().orElse(0);
                double deltaNdcg = aggregate.ndcgAt5() - baselineNdcg5;
                maxAbsNdcgDelta = Math.max(maxAbsNdcgDelta, Math.abs(deltaNdcg));
                rows.add(new V2SensitivityRow(grid.getKey(), value, aggregate, shapeBrier, deltaNdcg, shapeBrier - baselineBrier));
            }
        }

        String verdict = base.aggregate() == null || snapshot.exams().size() < 3 ? "INSUFFICIENT_DATA"
                : maxAbsNdcgDelta <= STABLE_NDCG_BAND ? "STABLE"
                : maxAbsNdcgDelta >= SENSITIVE_NDCG_BAND ? "SENSITIVE" : "MILDLY_SENSITIVE";
        String summary = String.format(
                "V2 candidate over %d fold(s): max |ΔNDCG@5| %.3f across the grids; decay shapes tested: %s (chosen %s).",
                Math.max(0, snapshot.exams().size() - 1), maxAbsNdcgDelta,
                base.byDecayShape().keySet(), base.chosenDecayShape());
        return new V2SensitivityReport(baselineNdcg5, baselineBrier, rows, base.chosenDecayShape(), base.byDecayShape(), verdict, summary);
    }

    private static TopicHistoryFeatures.DecayShape shapeOf(String name) {
        try { return TopicHistoryFeatures.DecayShape.valueOf(name == null ? "HALF_LIFE_2" : name); }
        catch (IllegalArgumentException error) { return TopicHistoryFeatures.DecayShape.HALF_LIFE_2; }
    }

    private static TopicHistoryFeatures.Weights varyV2(TopicHistoryFeatures.Weights base, String coefficient, double value) {
        return switch (coefficient) {
            case "momentum" -> new TopicHistoryFeatures.Weights(base.frequencyRate(), base.recencyRate(), value, base.spacing(), base.points(), base.style(), base.homework(), base.lecture(), base.syllabus(), base.unlock(), base.omission());
            case "spacing" -> new TopicHistoryFeatures.Weights(base.frequencyRate(), base.recencyRate(), base.momentum(), value, base.points(), base.style(), base.homework(), base.lecture(), base.syllabus(), base.unlock(), base.omission());
            case "points" -> new TopicHistoryFeatures.Weights(base.frequencyRate(), base.recencyRate(), base.momentum(), base.spacing(), value, base.style(), base.homework(), base.lecture(), base.syllabus(), base.unlock(), base.omission());
            case "style" -> new TopicHistoryFeatures.Weights(base.frequencyRate(), base.recencyRate(), base.momentum(), base.spacing(), base.points(), value, base.homework(), base.lecture(), base.syllabus(), base.unlock(), base.omission());
            case "unlock" -> new TopicHistoryFeatures.Weights(base.frequencyRate(), base.recencyRate(), base.momentum(), base.spacing(), base.points(), base.style(), base.homework(), base.lecture(), base.syllabus(), value, base.omission());
            case "omission" -> new TopicHistoryFeatures.Weights(base.frequencyRate(), base.recencyRate(), base.momentum(), base.spacing(), base.points(), base.style(), base.homework(), base.lecture(), base.syllabus(), base.unlock(), value);
            default -> null;
        };
    }
}
