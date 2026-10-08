package com.studyos.diagnostics;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Structured development diagnostics: the full evidence behind a learning decision, a research run
 * or a prediction, reconstructable after the fact. This is an engineering/debug surface — the
 * learner-facing UI keeps its plain language and hides the coefficients.
 */
@RestController
@RequestMapping({"/api/courses/{courseId}/diagnostics", "/api/workspaces/{courseId}/diagnostics"})
public class DiagnosticsController {
    private final JdbcTemplate jdbc;

    public DiagnosticsController(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /**
     * Why does a topic look the way it does to the planner? Every input to every learning decision
     * about this topic, from stored evidence: mastery components, retention, misconception, exam
     * relevance, prerequisite gaps, source coverage and curriculum position.
     */
    @GetMapping("/learning")
    public Map<String, Object> learning(@PathVariable UUID courseId, @RequestParam(required = false) UUID topicId) {
        String sql = """
                SELECT t.id, t.canonical_name, t.importance, t.difficulty, t.difficulty_attempts,
                       COALESCE(s.mastery,0) AS mastery, COALESCE(s.measured_mastery,s.mastery,0) AS measured_mastery,
                       COALESCE(s.confidence,0) AS confidence, COALESCE(s.retention_estimate,1) AS retention_estimate,
                       COALESCE(s.alpha,2) AS alpha, COALESCE(s.beta,2) AS beta, COALESCE(s.evidence_count,0) AS evidence_count,
                       s.review_due_at, s.last_assessed_at, s.last_studied_at, s.stability_days, s.learned_probability,
                       es.relevance AS exam_relevance, es.evidence_confidence, es.evidence::text AS exam_evidence,
                       (SELECT COUNT(DISTINCT ct.chunk_id) FROM chunk_topics ct WHERE ct.topic_id=t.id) AS chunk_count,
                       (SELECT COUNT(DISTINCT c.document_id) FROM chunk_topics ct JOIN chunks c ON c.id=ct.chunk_id WHERE ct.topic_id=t.id) AS source_count,
                       (SELECT MAX(m.severity) FROM misconceptions m WHERE m.course_id=t.course_id AND m.topic_id=t.id AND m.status<>'RESOLVED') AS misconception_severity,
                       (SELECT COUNT(*) FROM assessment_attempts a WHERE a.course_id=t.course_id AND a.topic_id=t.id) AS attempt_count
                FROM topics t
                LEFT JOIN student_topic_state s ON s.topic_id=t.id AND s.course_id=t.course_id
                LEFT JOIN exam_topic_signals es ON es.topic_id=t.id AND es.course_id=t.course_id
                WHERE t.course_id=? AND t.canonical_topic_id IS NULL""" + (topicId == null ? "" : " AND t.id=?") + " ORDER BY t.canonical_name";
        List<Map<String, Object>> topics = topicId == null
                ? jdbc.queryForList(sql, courseId)
                : jdbc.queryForList(sql, courseId, topicId);
        Map<String, Object> result = new java.util.HashMap<>();
        result.put("topics", topics);
        if (topicId != null) {
            // One learner attempt, end to end: what was asked, what support was used, how it was
            // graded, what it moved, and what the loop decided to do next.
            result.put("lastAttempt", jdbc.queryForList("""
                    SELECT a.created_at, i.prompt, a.answer, a.score, a.correctness, a.error_type,
                           a.difficulty, a.cognitive_level, a.activity_kind, a.support_level_used,
                           a.evidence_weight, a.mastery_before, a.mastery_after, a.review_grade,
                           i.observed_difficulty, i.calibration_attempts, i.source_basis::text AS source_basis,
                           (SELECT COUNT(*) FROM exercise_support_events e WHERE e.item_id=a.item_id) AS hints_revealed
                    FROM assessment_attempts a LEFT JOIN assessment_items i ON i.id=a.item_id
                    WHERE a.course_id=? AND a.topic_id=? ORDER BY a.created_at DESC LIMIT 5
                    """, courseId, topicId));
            Map<String, Object> next = jdbc.queryForList("""
                    SELECT s.review_due_at, l.level AS ladder_level, l.last_reason AS ladder_reason, l.diagnostic_pending
                    FROM topics t
                    LEFT JOIN student_topic_state s ON s.course_id=t.course_id AND s.topic_id=t.id
                    LEFT JOIN topic_ladder_state l ON l.course_id=t.course_id AND l.topic_id=t.id
                    WHERE t.id=?
                    """, topicId).stream().findFirst().orElse(Map.of());
            result.put("next", next);
        }
        // Quiz-generation reliability metrics from the recorded outcomes: separate rates, never one
        // blended "AI quality" number.
        List<Map<String, Object>> outcomes = jdbc.queryForList("""
                SELECT payload->>'outcome' AS outcome, COUNT(*) AS runs
                FROM learning_events
                WHERE course_id=? AND event_type='QUIZ_GENERATION_OUTCOME'
                GROUP BY payload->>'outcome'
                """, courseId);
        long totalRuns = outcomes.stream().mapToLong(run -> ((Number) run.get("runs")).longValue()).sum();
        long successes = outcomes.stream()
                .filter(run -> "RETURNED".equals(run.get("outcome")) || "POOL_REUSE".equals(run.get("outcome")))
                .mapToLong(run -> ((Number) run.get("runs")).longValue()).sum();
        Map<String, Object> metrics = new java.util.LinkedHashMap<>();
        metrics.put("generationRuns", totalRuns);
        metrics.put("successRate", totalRuns == 0 ? null : (double) successes / totalRuns);
        outcomes.forEach(run -> metrics.put(String.valueOf(run.get("outcome")).toLowerCase(java.util.Locale.ROOT) + "Rate",
                totalRuns == 0 ? null : ((Number) run.get("runs")).doubleValue() / totalRuns));
        result.put("quizMetrics", metrics);
        return result;
    }

    /**
     * Research observability: per-query outcomes (what was found, ingested, duplicated, rejected)
     * and per-source provenance for the most recent runs.
     */
    @GetMapping("/research")
    public Map<String, Object> research(@PathVariable UUID courseId) {
        List<Map<String, Object>> runs = jdbc.queryForList("""
                SELECT id, goal, mode, status, planned_queries, queries_run, candidates_found,
                       sources_ingested, sources_skipped, sources_failed, bytes_fetched, error, created_at, completed_at
                FROM research_runs WHERE course_id=? ORDER BY created_at DESC LIMIT 5
                """, courseId);
        List<Map<String, Object>> queryOutcomes = jdbc.queryForList("""
                SELECT qo.run_id, qo.query, qo.candidates, qo.ingested, qo.skipped, qo.cached, qo.duplicates, qo.failed, qo.yield
                FROM research_query_outcomes qo
                JOIN research_runs r ON r.id=qo.run_id
                WHERE r.course_id=? ORDER BY qo.created_at DESC LIMIT 40
                """, courseId);
        List<Map<String, Object>> sources = jdbc.queryForList("""
                SELECT id, run_id, document_id, url, domain, title, provider, query, quality_score,
                       quality_signals::text AS quality_signals, byte_size, content_type, retrieved_at
                FROM research_sources WHERE course_id=? ORDER BY retrieved_at DESC LIMIT 40
                """, courseId);
        return Map.of("runs", runs, "queryOutcomes", queryOutcomes, "sources", sources);
    }

    /**
     * Prediction observability: what the current model predicts, what evidence it saw, and — once
     * backtests have run — the metrics that say whether to trust it.
     */
    @GetMapping("/prediction")
    public Map<String, Object> prediction(@PathVariable UUID courseId) {
        Map<String, Object> signals = new HashMap<>();
        jdbc.query("""
                SELECT t.canonical_name, es.relevance, es.evidence_confidence, es.evidence::text AS evidence
                FROM exam_topic_signals es JOIN topics t ON t.id=es.topic_id
                WHERE es.course_id=? ORDER BY es.relevance DESC LIMIT 12
                """, rs -> {
            while (rs.next()) {
                Map<String, Object> signal = new HashMap<>();
                signal.put("topic", rs.getString(1));
                signal.put("relevance", rs.getDouble(2));
                signal.put("evidenceConfidence", rs.getDouble(3));
                signal.put("evidence", rs.getString(4));
                signals.put(rs.getString(1), signal);
            }
            return null;
        }, courseId);
        Timestamp generatedAt = jdbc.query("SELECT generated_at FROM curricula WHERE course_id=? AND status='ACTIVE' ORDER BY generated_at DESC LIMIT 1",
                rs -> rs.next() ? rs.getTimestamp(1) : null, courseId);
        Integer pastExamDocs = jdbc.queryForObject("SELECT COUNT(*) FROM documents WHERE course_id=? AND document_type='PAST_EXAM' AND status='COMPLETED'", Integer.class, courseId);
        return Map.of(
                "modelVersions", Map.of("readiness", com.studyos.prediction.PredictionService.MODEL_VERSION,
                        "examTopic", com.studyos.assessment.ExamPredictionService.MODEL_VERSION,
                        "backtest", com.studyos.prediction.PredictionBacktestService.MODEL_VERSION),
                "topicSignals", signals.values(),
                "pastExamDocuments", pastExamDocs == null ? 0 : pastExamDocs,
                "curriculumGeneratedAt", generatedAt == null ? null : generatedAt.toInstant().toString(),
                "backtestEndpoint", "/api/workspaces/" + courseId + "/exam-predictions/backtest");
    }

    /** Lesson ordering context for a topic's curriculum position, included in learning traces. */
    @GetMapping("/curriculum-position")
    public List<Map<String, Object>> curriculumPosition(@PathVariable UUID courseId, @RequestParam UUID topicId) {
        List<Map<String, Object>> rows = new ArrayList<>();
        rows.addAll(jdbc.queryForList("""
                SELECT m.ordinal AS module_ordinal, l.ordinal AS lesson_ordinal, l.title, l.content_status, l.estimated_minutes, cu.id AS curriculum_id, cu.revision
                FROM curriculum_lessons l
                JOIN curriculum_modules m ON m.id=l.module_id
                JOIN curricula cu ON cu.id=m.curriculum_id
                WHERE l.course_id=? AND l.topic_id=? AND cu.status='ACTIVE'
                ORDER BY m.ordinal, l.ordinal
                """, courseId, topicId));
        return rows;
    }
}
