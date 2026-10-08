package com.studyos.knowledge;

import java.sql.Timestamp;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping({"/api/courses/{courseId}/topics", "/api/workspaces/{courseId}/topics"})
public class KnowledgeController {
    private final JdbcTemplate jdbc;
    private final TopicExtractionService topics;
    private final TopicRelationService relations;
    private final TopicModelService model;
    private final TopicObjectiveService objectives;
    private final TopicReconciliationService reconciliation;
    private final TopicQualityCleanupService cleanup;
    public KnowledgeController(JdbcTemplate jdbc, TopicExtractionService topics, TopicRelationService relations, TopicModelService model, TopicObjectiveService objectives, TopicReconciliationService reconciliation, TopicQualityCleanupService cleanup) { this.jdbc = jdbc; this.topics = topics; this.relations = relations; this.model = model; this.objectives = objectives; this.reconciliation = reconciliation; this.cleanup = cleanup; }

    /**
     * Every topic with what the workspace has measured about it.
     *
     * <p>Mastery, importance and difficulty are all nullable and all mean the same thing when null: not measured.
     * A topic never assessed used to be reported at mastery 0, which reads as "measured, and the learner knows
     * none of it" — the same failure {@link com.studyos.chat.ContextBuilder} was corrected for. The ordering keeps
     * the weakest topics first and now sorts unmeasured ones ahead of measured ones, because a topic with no
     * evidence at all is the one most worth looking at.
     */
    @GetMapping
    public List<TopicSummary> list(@PathVariable UUID courseId) {
        List<TopicSummary> topics = jdbc.query("SELECT t.id,t.canonical_name,t.description,COALESCE(s.measured_mastery,s.mastery) AS mastery,s.confidence,s.review_due_at,COALESCE(s.evidence_count,0) AS evidence_count,t.importance,t.difficulty,COALESCE(t.difficulty_attempts,0) AS difficulty_attempts,t.model_updated_at,COUNT(DISTINCT ct.chunk_id) AS source_count,COUNT(DISTINCT o.id) AS objective_count FROM topics t LEFT JOIN student_topic_state s ON s.topic_id=t.id AND s.course_id=t.course_id LEFT JOIN chunk_topics ct ON ct.topic_id=t.id LEFT JOIN topic_objectives o ON o.topic_id=t.id AND o.course_id=t.course_id WHERE t.course_id=? AND t.canonical_topic_id IS NULL GROUP BY t.id,t.canonical_name,t.description,s.mastery,s.measured_mastery,s.confidence,s.review_due_at,s.evidence_count,t.importance,t.difficulty,t.difficulty_attempts,t.model_updated_at ORDER BY mastery ASC NULLS FIRST,t.importance DESC NULLS LAST,t.canonical_name",
                (rs, row) -> new TopicSummary(rs.getObject("id", UUID.class), rs.getString("canonical_name"), rs.getString("description"),
                        rs.getObject("mastery", Double.class), rs.getObject("confidence", Double.class), rs.getTimestamp("review_due_at"), rs.getInt("evidence_count"),
                        rs.getObject("importance", Double.class), rs.getObject("difficulty", Double.class), rs.getInt("difficulty_attempts"), rs.getTimestamp("model_updated_at"),
                        rs.getLong("source_count"), rs.getLong("objective_count")), courseId);
        // The learner knowledge map shows canonical, quality-valid concepts only: merged redirect
        // rows and structurally invalid candidates stay out of the face of the UI.
        return topics.stream()
                .filter(topic -> TopicCandidateQuality.evaluate(topic.name()).accepted())
                .toList();
    }

    @PostMapping("/rebuild")
    public ResponseEntity<TopicExtractionService.RebuildStatus> rebuild(@PathVariable UUID courseId) {
        topics.rebuild(courseId);
        return ResponseEntity.accepted().body(topics.rebuildStatus(courseId));
    }

    @GetMapping("/rebuild/status")
    public TopicExtractionService.RebuildStatus rebuildStatus(@PathVariable UUID courseId) { return topics.rebuildStatus(courseId); }

    /**
     * Recomputes importance and difficulty for every topic from evidence already stored.
     *
     * <p>This is the way across for a workspace built before the topic model existed: nothing was backfilled by
     * migration, because computing the figures in SQL would mean a second implementation of arithmetic that lives
     * in {@link TopicModel}. Document processing recomputes them from then on.
     */
    @PostMapping("/model/rebuild")
    public TopicModelService.ModelRebuild rebuildModel(@PathVariable UUID courseId) { return model.rebuild(courseId); }

    /** What the course says a learner should be able to do, per topic, with the source of each statement. */
    @GetMapping("/objectives")
    public List<TopicObjectiveService.Objective> objectives(@PathVariable UUID courseId) { return objectives.list(courseId); }

    @GetMapping("/{topicId}/objectives")
    public List<TopicObjectiveService.Objective> topicObjectives(@PathVariable UUID courseId, @PathVariable UUID topicId) { return objectives.forTopic(courseId, topicId); }

    @PostMapping("/objectives/rebuild")
    public TopicObjectiveService.ObjectiveRebuild rebuildObjectives(@PathVariable UUID courseId) { return objectives.rebuild(courseId); }

    @GetMapping("/relations")
    public List<TopicRelationService.Edge> relations(@PathVariable UUID courseId) { return relations.list(courseId); }

    @PostMapping("/relations/rebuild")
    public ResponseEntity<TopicRelationService.RebuildResult> rebuildRelations(@PathVariable UUID courseId) { return ResponseEntity.ok(relations.rebuild(courseId)); }

    /** Finds duplicate/near-equivalent topics across the workspace and folds them into canonical ones. */
    @PostMapping("/reconcile")
    public TopicReconciliationService.Report reconcile(@PathVariable UUID courseId) { return reconciliation.reconcile(courseId); }

    /**
     * Re-evaluates every existing topic against the extraction quality rules: salvage/rename/merge
     * packaging variants, delete unreferenced junk, keep referenced invalid rows with an audit.
     * Idempotent; destructive only where no evidence exists to destroy.
     */
    @PostMapping("/quality-cleanup")
    public TopicQualityCleanupService.CleanupReport qualityCleanup(@PathVariable UUID courseId) { return cleanup.cleanup(courseId); }

    /** Why a candidate was rejected or renamed: durable audit rows from the extraction funnel and cleanup. */
    @GetMapping("/quality-audit")
    public Map<String, Object> qualityAudit(@PathVariable UUID courseId) {
        List<Map<String, Object>> byReason = jdbc.queryForList("""
                SELECT source, decision, reason, COUNT(*) AS candidates, COALESCE(SUM(occurrences),0) AS occurrences
                FROM topic_extraction_audit WHERE course_id=? GROUP BY source, decision, reason ORDER BY candidates DESC
                """, courseId);
        List<Map<String, Object>> recent = jdbc.queryForList("""
                SELECT sample, source, decision, reason, quality_score AS qualityScore, occurrences, last_seen_at
                FROM topic_extraction_audit WHERE course_id=? ORDER BY last_seen_at DESC LIMIT 40
                """, courseId);
        Integer topics = jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE course_id=?", Integer.class, courseId);
        Integer canonical = jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE course_id=? AND canonical_topic_id IS NULL", Integer.class, courseId);
        Integer merged = jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE course_id=? AND canonical_topic_id IS NOT NULL", Integer.class, courseId);
        Integer aliases = jdbc.queryForObject("SELECT COUNT(*) FROM topic_aliases WHERE course_id=?", Integer.class, courseId);
        return Map.of("extractionVersion", TopicCandidateQuality.VERSION,
                "topicCount", topics == null ? 0 : topics, "canonicalTopicCount", canonical == null ? 0 : canonical,
                "mergedCount", merged == null ? 0 : merged, "aliasCount", aliases == null ? 0 : aliases,
                "byReason", byReason, "recent", recent);
    }

    /**
     * @param mastery null when this topic has never been assessed, which is not the same as a measured zero
     * @param importance how central the topic is to this course, null until the model has been computed
     * @param difficulty how much the topic demands, null when none of its components could be measured
     * @param difficultyAttempts graded attempts behind the difficulty figure, which can be non-zero while
     *     {@code difficulty} is still null: a topic needs more than two attempts before they say anything
     */
    public record TopicSummary(UUID id, String name, String description, Double mastery, Double confidence, Timestamp reviewDueAt, int evidenceCount,
                               Double importance, Double difficulty, int difficultyAttempts, Timestamp modelUpdatedAt, long sourceCount, long objectiveCount) {}
}
