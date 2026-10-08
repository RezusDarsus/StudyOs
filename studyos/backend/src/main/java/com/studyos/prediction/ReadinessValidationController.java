package com.studyos.prediction;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

/** Learner-agnostic validation endpoints for the readiness forecast and session projections. */
@RestController
@RequestMapping({"/api/courses/{courseId}/readiness-validation", "/api/workspaces/{courseId}/readiness-validation"})
public class ReadinessValidationController {
    private final ReadinessValidationService validation;
    private final JdbcTemplate jdbc;

    public ReadinessValidationController(ReadinessValidationService validation, JdbcTemplate jdbc) {
        this.validation = validation;
        this.jdbc = jdbc;
    }

    /** Snapshot the current forecast as the "before" half of a future validation pair. */
    @PostMapping("/forecast")
    public Map<String, Object> recordForecast(@PathVariable UUID courseId,
                                              @RequestParam(required = false) String source) {
        UUID id = validation.recordForecast(courseId, source, null);
        return Map.of("recorded", id != null, "id", id == null ? null : id.toString());
    }

    /** Record the actual assessed result for the most recent open pair. */
    public record ActualRequest(double score) {}

    @PostMapping("/actual")
    public Map<String, Object> recordActual(@PathVariable UUID courseId, @RequestBody ActualRequest request) {
        return Map.of("recorded", validation.recordActual(courseId, request.score()));
    }

    @GetMapping
    public ReadinessValidationService.ValidationReport report(@PathVariable UUID courseId) {
        return validation.report(courseId);
    }

    /**
     * Session-projection validation: the tutor plans readinessBefore → readinessProjected; once the
     * session completes we know the measured readinessAfter. This report compares projected deltas
     * against measured deltas and is explicitly labelled heuristic until enough sessions exist.
     */
    @GetMapping("/session-projections")
    public Map<String, Object> sessionProjections(@PathVariable UUID courseId) {
        List<Map<String, Object>> sessions = jdbc.queryForList("""
                SELECT id, readiness_before, readiness_projected, readiness_after, created_at
                FROM tutor_sessions WHERE course_id=? AND readiness_after IS NOT NULL
                ORDER BY created_at DESC LIMIT 50
                """, courseId);
        double projectedDeltaSum = 0;
        double measuredDeltaSum = 0;
        double absoluteErrorSum = 0;
        int count = 0;
        for (Map<String, Object> session : sessions) {
            Object before = session.get("readiness_before");
            Object projected = session.get("readiness_projected");
            Object after = session.get("readiness_after");
            if (before == null || projected == null || after == null) continue;
            double projectedDelta = ((Number) projected).doubleValue() - ((Number) before).doubleValue();
            double measuredDelta = ((Number) after).doubleValue() - ((Number) before).doubleValue();
            projectedDeltaSum += projectedDelta;
            measuredDeltaSum += measuredDelta;
            absoluteErrorSum += Math.abs(projectedDelta - measuredDelta);
            count++;
        }
        String verdict = count == 0 ? "NO_COMPLETED_SESSIONS_YET"
                : count < 10 ? "HEURISTIC — " + count + " completed sessions is not enough to validate the projection"
                : "MEASURED — mean absolute projection error " + String.format("%.4f", absoluteErrorSum / count);
        return Map.of(
                "sessionsEvaluated", count,
                "meanProjectedDelta", count == 0 ? 0 : projectedDeltaSum / count,
                "meanMeasuredDelta", count == 0 ? 0 : measuredDeltaSum / count,
                "meanAbsoluteProjectionError", count == 0 ? 0 : absoluteErrorSum / count,
                "verdict", verdict);
    }
}
