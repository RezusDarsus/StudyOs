package com.studyos.tutor;

import com.studyos.assessment.ExamPredictionService;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Assembles the exam-mode plan for today from live workspace evidence and hands it to the pure
 * {@link ExamModePlanner}. Every input the planner weighs comes from a system that already exists:
 * exam-topic relevance from the deterministic exam analysis, mastery and retention from the
 * persistent learner state, misconceptions from assessment evidence, question structures from the
 * historical-exam predictor.
 */
@Service
public class ExamModeService {
    private final JdbcTemplate jdbc;
    private final ExamPredictionService examPredictions;

    public ExamModeService(JdbcTemplate jdbc, ExamPredictionService examPredictions) {
        this.jdbc = jdbc;
        this.examPredictions = examPredictions;
    }

    public ExamModePlanner.Plan today(UUID workspaceId, Integer minutes) {
        int budget = minutes == null || minutes <= 0 ? 74 : minutes;
        List<ExamModePlanner.Candidate> candidates = candidates(workspaceId);
        List<ExamModePlanner.Structure> structures = structures(workspaceId);
        Long daysToExam = daysToExam(workspaceId);
        return ExamModePlanner.plan(candidates, structures, budget, daysToExam);
    }

    private Long daysToExam(UUID workspaceId) {
        java.sql.Date examDate = jdbc.query("SELECT exam_date FROM courses WHERE id=?",
                rs -> rs.next() ? rs.getDate(1) : null, workspaceId);
        if (examDate == null) return null;
        long days = (examDate.toLocalDate().toEpochDay() - java.time.LocalDate.now().toEpochDay());
        return Math.max(0, days);
    }

    private List<ExamModePlanner.Structure> structures(UUID workspaceId) {
        try {
            ExamPredictionService.PredictionReport report = examPredictions.predict(workspaceId);
            if (!"EVIDENCE_AVAILABLE".equals(report.status())) return List.of();
            return report.likelyStructures().stream()
                    .map(structure -> new ExamModePlanner.Structure(structure.questionType(), structure.probability()))
                    .toList();
        } catch (RuntimeException error) {
            return List.of();
        }
    }

    private List<ExamModePlanner.Candidate> candidates(UUID workspaceId) {
        record Row(UUID topicId, String name, double effective, double relevance, double severity,
                   java.sql.Timestamp reviewDue, boolean recentFailure, UUID prerequisiteId, String prerequisiteName, double prerequisiteMastery) {}
        List<Row> rows = jdbc.query("""
                SELECT t.id, t.canonical_name,
                       COALESCE(s.measured_mastery, s.mastery, 0) * COALESCE(s.retention_estimate, 1) AS effective,
                       COALESCE(es.relevance, 0) AS relevance,
                       COALESCE((SELECT MAX(m.severity) FROM misconceptions m WHERE m.course_id=t.course_id AND m.topic_id=t.id AND m.status<>'RESOLVED'), 0) AS severity,
                       s.review_due_at,
                       EXISTS (SELECT 1 FROM learning_events e WHERE e.course_id=t.course_id AND e.topic_id=t.id
                               AND e.event_type='QUIZ_ATTEMPT' AND e.occurred_at >= NOW() - INTERVAL '14 days'
                               AND COALESCE((e.payload->>'score')::double precision, 1) < 0.5) AS recent_failure
                FROM topics t
                LEFT JOIN student_topic_state s ON s.topic_id=t.id AND s.course_id=t.course_id
                LEFT JOIN exam_topic_signals es ON es.topic_id=t.id AND es.course_id=t.course_id
                WHERE t.course_id=? AND t.canonical_topic_id IS NULL
                  AND EXISTS (SELECT 1 FROM chunk_topics ct WHERE ct.topic_id=t.id)
                """, (rs, rowNum) -> new Row(rs.getObject(1, UUID.class), rs.getString(2), rs.getDouble(3), rs.getDouble(4),
                rs.getDouble(5), rs.getTimestamp(6), rs.getBoolean(7), null, null, 0), workspaceId);
        Map<UUID, Prerequisite> prerequisites = weakestPrerequisites(workspaceId);
        List<ExamModePlanner.Candidate> candidates = new ArrayList<>();
        for (Row row : rows) {
            Prerequisite prerequisite = prerequisites.get(row.topicId());
            candidates.add(new ExamModePlanner.Candidate(row.topicId(), row.name(), row.effective(), row.relevance(),
                    row.severity(), row.reviewDue() != null && !row.reviewDue().toInstant().isAfter(java.time.Instant.now()),
                    row.recentFailure(),
                    prerequisite == null ? null : prerequisite.name(),
                    prerequisite == null ? 1 : prerequisite.mastery()));
        }
        return candidates;
    }

    private record Prerequisite(UUID topicId, String name, double mastery) {}

    /** The weakest prerequisite per topic, so remediation has a concrete target. */
    private Map<UUID, Prerequisite> weakestPrerequisites(UUID workspaceId) {
        Map<UUID, Prerequisite> result = new HashMap<>();
        jdbc.query("""
                SELECT e.dependent_topic_id, p.id AS prerequisite_id, p.canonical_name,
                       COALESCE(s.measured_mastery, s.mastery, 0) AS mastery
                FROM topic_prerequisites e
                JOIN topics p ON p.id=e.prerequisite_topic_id
                LEFT JOIN student_topic_state s ON s.topic_id=p.id AND s.course_id=e.course_id
                WHERE e.course_id=?
                """, rs -> {
            while (rs.next()) {
                UUID dependent = rs.getObject(1, UUID.class);
                double mastery = rs.getDouble(4);
                Prerequisite current = result.get(dependent);
                if (current == null || mastery < current.mastery()) {
                    result.put(dependent, new Prerequisite(rs.getObject(2, UUID.class), rs.getString(3), mastery));
                }
            }
            return null;
        }, workspaceId);
        return result;
    }
}
