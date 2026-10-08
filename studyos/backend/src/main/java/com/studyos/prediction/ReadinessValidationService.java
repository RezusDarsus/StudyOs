package com.studyos.prediction;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Stores and evaluates readiness-forecast validation pairs: a readiness forecast recorded before an
 * assessed result exists, and the actual score recorded later. Exam-topic prediction is only one
 * forecasting subsystem; this keeps READINESS_V1 honest the same way — forecast, later actual,
 * then evaluation. The exam score is not assumed to equal mastery; the report says exactly what is
 * being compared.
 */
@Service
public class ReadinessValidationService {

    private final JdbcTemplate jdbc;
    private final PredictionService predictions;

    public ReadinessValidationService(JdbcTemplate jdbc, PredictionService predictions) {
        this.jdbc = jdbc;
        this.predictions = predictions;
    }

    /** Captures the current readiness forecast as the "before" half of a validation pair. */
    public UUID recordForecast(UUID courseId, String source, LocalDate examDate) {
        PredictionService.Forecast forecast = predictions.forecast(courseId);
        if ("INSUFFICIENT_EVIDENCE".equals(forecast.status())) return null;
        UUID id = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO readiness_validation_pairs(id,course_id,forecast_readiness,model_version,exam_date,source)
                VALUES(?,?,?,?,?,?)
                """, id, courseId, forecast.readiness(), PredictionService.MODEL_VERSION, examDate, source == null ? "MANUAL" : source);
        return id;
    }

    /** Records the actual assessed result on the most recent still-open pair for the course. */
    public boolean recordActual(UUID courseId, double actualScore) {
        List<UUID> open = jdbc.query("""
                SELECT id FROM readiness_validation_pairs
                WHERE course_id=? AND actual_score IS NULL ORDER BY forecast_at DESC LIMIT 1
                """, (rs, row) -> rs.getObject(1, UUID.class), courseId);
        if (open.isEmpty()) return false;
        jdbc.update("UPDATE readiness_validation_pairs SET actual_score=?, actual_recorded_at=NOW() WHERE id=?",
                Math.max(0, Math.min(1, actualScore)), open.get(0));
        return true;
    }

    public record CalibrationBand(String band, int count, Double meanForecast, Double meanActual) {}

    public record ValidationReport(int pairs, int evaluated, Double correlation, Double mae,
                                   List<CalibrationBand> bands, String caveat, List<Map<String, Object>> history) {}

    /**
     * Correlation, MAE and calibration bands over completed pairs. Until a real exam corpus exists,
     * the actual side comes from assessed results (mock exams) — the caveat says so on every report.
     */
    public ValidationReport report(UUID courseId) {
        List<Map<String, Object>> pairs = jdbc.queryForList("""
                SELECT forecast_readiness, actual_score, model_version, forecast_at, actual_recorded_at, source
                FROM readiness_validation_pairs WHERE course_id=? ORDER BY forecast_at DESC LIMIT 50
                """, courseId);
        List<double[]> completed = new ArrayList<>();
        for (Map<String, Object> pair : pairs) {
            Object actual = pair.get("actual_score");
            Object forecast = pair.get("forecast_readiness");
            if (actual == null || forecast == null) continue;
            completed.add(new double[]{((Number) forecast).doubleValue(), ((Number) actual).doubleValue()});
        }
        Double correlation = null;
        Double mae = null;
        if (completed.size() >= 3) {
            correlation = correlation(completed);
            double total = 0;
            for (double[] pair : completed) total += Math.abs(pair[0] - pair[1]);
            mae = total / completed.size();
        }
        List<CalibrationBand> bands = new ArrayList<>();
        for (int band = 0; band < 10; band++) {
            final double from = band / 10.0;
            final double to = (band + 1) / 10.0;
            final int index = band;
            List<double[]> inBand = completed.stream()
                    .filter(pair -> pair[0] >= from && (index == 9 ? pair[0] <= to : pair[0] < to)).toList();
            if (inBand.isEmpty()) continue;
            double meanForecast = inBand.stream().mapToDouble(pair -> pair[0]).average().orElse(0);
            double meanActual = inBand.stream().mapToDouble(pair -> pair[1]).average().orElse(0);
            bands.add(new CalibrationBand(String.format("%.1f-%.1f", from, to), inBand.size(), meanForecast, meanActual));
        }
        return new ValidationReport(pairs.size(), completed.size(), correlation, mae, bands,
                "Actual values so far come from assessed results (mock exams), not real exam papers. Treat every figure as provisional.",
                pairs);
    }

    private static Double correlation(List<double[]> pairs) {
        final int n = pairs.size();
        double meanX = pairs.stream().mapToDouble(pair -> pair[0]).average().orElse(0);
        double meanY = pairs.stream().mapToDouble(pair -> pair[1]).average().orElse(0);
        double[] sums = new double[3];
        for (double[] pair : pairs) {
            sums[0] += (pair[0] - meanX) * (pair[1] - meanY);
            sums[1] += Math.pow(pair[0] - meanX, 2);
            sums[2] += Math.pow(pair[1] - meanY, 2);
        }
        if (sums[1] == 0 || sums[2] == 0 || n == 0) return null;
        return sums[0] / Math.sqrt(sums[1] * sums[2]);
    }
}
