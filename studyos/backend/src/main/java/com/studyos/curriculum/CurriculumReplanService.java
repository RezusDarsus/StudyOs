package com.studyos.curriculum;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Keeps the persistent course plan honest without ever mutating it silently.
 *
 * <p>Meaningful evidence changes — a new syllabus, a discovered prerequisite, a repeatedly failed
 * concept, a changed exam date — should reshape the plan. This service detects those signals,
 * records a new revision with its reason, applies the safe repairs, and only ever rebuilds the
 * affected parts. A re-plan that cannot be explained is a bug.
 */
@Service
public class CurriculumReplanService {
    private static final Logger log = LoggerFactory.getLogger(CurriculumReplanService.class);

    private final JdbcTemplate jdbc;
    private final CurriculumIntegrityService integrity;
    private final TransactionTemplate transaction;

    public CurriculumReplanService(JdbcTemplate jdbc, CurriculumIntegrityService integrity, PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.integrity = integrity;
        this.transaction = new TransactionTemplate(transactionManager);
    }

    public record Signal(String code, String detail) {}

    public record Suggestion(UUID curriculumId, int revision, boolean replanRecommended, List<Signal> signals) {}

    public record RevisionResult(UUID curriculumId, int revision, String reason, int duplicatesRemoved,
                                 int topicsRedirected, CurriculumIntegrityValidator.Report report) {}

    /**
     * Why the current plan may be stale, read from evidence that already exists in the database.
     */
    public Suggestion suggest(UUID workspaceId) {
        List<Signal> signals = new ArrayList<>();
        var curriculum = jdbc.query("SELECT id,revision,generated_at FROM curricula WHERE course_id=? AND status='ACTIVE' ORDER BY generated_at DESC LIMIT 1",
                rs -> rs.next() ? new Object[]{rs.getObject(1, UUID.class), rs.getInt(2), rs.getTimestamp(3)} : null, workspaceId);
        if (curriculum == null) return new Suggestion(null, 0, false, signals);
        UUID curriculumId = (UUID) curriculum[0];
        int revision = (Integer) curriculum[1];
        java.sql.Timestamp generatedAt = (java.sql.Timestamp) curriculum[2];

        Integer newerSyllabus = jdbc.queryForObject("""
                SELECT COUNT(*) FROM syllabus_units WHERE course_id=? AND (? IS NULL OR created_at > ?)
                """, Integer.class, workspaceId, generatedAt, generatedAt);
        if (newerSyllabus != null && newerSyllabus > 0) signals.add(new Signal("NEW_SYLLABUS_CONTENT", newerSyllabus + " syllabus unit(s) arrived after this plan was generated"));

        Integer newEdges = jdbc.queryForObject("""
                SELECT COUNT(*) FROM topic_edges WHERE course_id=? AND (? IS NULL OR created_at > ?)
                """, Integer.class, workspaceId, generatedAt, generatedAt);
        if (newEdges != null && newEdges > 0) signals.add(new Signal("NEW_PREREQUISITE_EDGES", newEdges + " topic relation(s) discovered after this plan was generated"));

        Integer uncoveredImportant = jdbc.queryForObject("""
                SELECT COUNT(*) FROM topics t
                WHERE t.course_id=? AND t.canonical_topic_id IS NULL AND COALESCE(t.importance,0) >= 0.7
                  AND NOT EXISTS (SELECT 1 FROM curriculum_lessons l JOIN curriculum_modules m ON m.id=l.module_id
                                  WHERE m.curriculum_id=? AND l.topic_id=t.id)
                """, Integer.class, workspaceId, curriculumId);
        if (uncoveredImportant != null && uncoveredImportant > 0) signals.add(new Signal("IMPORTANT_TOPIC_UNCOVERED", uncoveredImportant + " high-importance topic(s) not covered by any lesson"));

        Integer repeatedFailure = jdbc.queryForObject("""
                SELECT COUNT(*) FROM (
                    SELECT l.topic_id FROM learning_events e
                    JOIN curriculum_lessons l ON l.topic_id=e.topic_id
                    JOIN curriculum_modules m ON m.id=l.module_id
                    WHERE m.curriculum_id=? AND e.event_type='QUIZ_ATTEMPT'
                      AND e.occurred_at > NOW() - INTERVAL '14 days'
                      AND COALESCE((e.payload->>'score')::double precision,1) < 0.5
                    GROUP BY l.topic_id HAVING COUNT(*) >= 3
                ) failures
                """, Integer.class, curriculumId);
        if (repeatedFailure != null && repeatedFailure > 0) signals.add(new Signal("REPEATED_FAILURE", repeatedFailure + " topic(s) failed three or more recent attempts"));

        Integer examChange = jdbc.queryForObject("""
                SELECT COUNT(*) FROM courses WHERE id=? AND exam_date IS NOT NULL AND updated_at > COALESCE(?,NOW() - INTERVAL '1 second')
                """, Integer.class, workspaceId, generatedAt);
        if (examChange != null && examChange > 0) signals.add(new Signal("EXAM_DATE_CHANGED", "The exam date changed after this plan was generated"));

        return new Suggestion(curriculumId, revision, !signals.isEmpty(), signals);
    }

    /**
     * Applies a re-plan: bumps the revision with its reason, runs the safe repairs, re-validates.
     * The scope is the whole plan's metadata plus deterministic fixes — never an unexplained
     * regeneration of every module.
     */
    public RevisionResult replan(UUID workspaceId, String reason) {
        Suggestion suggestion = suggest(workspaceId);
        if (suggestion.curriculumId() == null) throw new com.studyos.WorkspaceNotReadyException("Build a curriculum before re-planning");
        String safeReason = reason == null || reason.isBlank()
                ? (suggestion.signals().isEmpty() ? "Manual re-plan" : suggestion.signals().get(0).code())
                : reason.trim();
        transaction.executeWithoutResult(status ->
                jdbc.update("UPDATE curricula SET revision=revision+1, revision_reason=?, updated_at=NOW() WHERE id=?", safeReason, suggestion.curriculumId()));
        var repaired = integrity.repair(workspaceId);
        log.info("Curriculum re-planned for course {}: revision {}, reason '{}', {} duplicates removed, {} topics redirected",
                workspaceId, suggestion.revision() + 1, safeReason, repaired.duplicatesRemoved(), repaired.topicsRedirected());
        return new RevisionResult(suggestion.curriculumId(), suggestion.revision() + 1, safeReason,
                repaired.duplicatesRemoved(), repaired.topicsRedirected(), repaired.report());
    }
}
