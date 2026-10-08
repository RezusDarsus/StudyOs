package com.studyos.knowledge;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Safe cleanup of topics that already polluted a workspace — the inverse door to the extraction
 * funnel. Nothing here is a bulk DELETE: every existing topic is re-evaluated against the same
 * {@link TopicCandidateQuality} rules the extractor uses, and each invalid one is then either
 * <ul>
 *   <li><b>renamed</b> to its salvaged concept ("Fairness (20 Pt)" → "Fairness") when no topic of
 *       that name exists yet — every reference survives untouched;</li>
 *   <li><b>merged</b> into the surviving topic of the salvaged name through the reconciliation
 *       service's transactional move, so learner evidence, curriculum links and exam signals are
 *       re-pointed, never dropped;</li>
 *   <li><b>deleted</b> only when it is unreferenced — no learner state, no assessment links, no
 *       curriculum bindings — so the operation can never destroy evidence;</li>
 *   <li><b>kept</b> with an audit record when it is invalid but referenced: the learner worked with
 *       it, so removal is not ours to decide.</li>
 * </ul>
 * Running the cleanup twice is a no-op: valid topics skip, renamed topics re-evaluate VALID,
 * merged rows are redirect records the query never revisits.
 */
@Service
public class TopicQualityCleanupService {
    private static final Logger log = LoggerFactory.getLogger(TopicQualityCleanupService.class);

    private final JdbcTemplate jdbc;
    private final TopicRegistry registry;
    private final TopicReconciliationService reconciliation;

    public TopicQualityCleanupService(JdbcTemplate jdbc, TopicRegistry registry, TopicReconciliationService reconciliation) {
        this.jdbc = jdbc;
        this.registry = registry;
        this.reconciliation = reconciliation;
    }

    public record CleanupReport(int examined, int valid, int renamed, int merged, int deleted, int keptInvalid,
                                Map<String, Long> rejectionsByReason) {}

    public CleanupReport cleanup(UUID courseId) {
        record Row(UUID id, String name, int support) {}
        // Richest topics first: the best-supported row keeps the plain name, its packaging variants merge in.
        List<Row> rows = jdbc.query("""
                SELECT t.id, t.canonical_name,
                       (SELECT COUNT(*) FROM chunk_topics ct WHERE ct.topic_id=t.id) AS support
                FROM topics t WHERE t.course_id=? AND t.canonical_topic_id IS NULL
                ORDER BY support DESC, t.canonical_name
                """, (rs, row) -> new Row(rs.getObject("id", UUID.class), rs.getString("canonical_name"), rs.getInt("support")), courseId);

        int valid = 0, renamed = 0, merged = 0, deleted = 0, keptInvalid = 0;
        Map<String, Long> rejections = new LinkedHashMap<>();
        for (Row row : rows) {
            TopicCandidateQuality.Decision decision = TopicCandidateQuality.evaluate(row.name());
            String salvaged = decision.salvaged();
            // Salvage applies even to an accepted name: "Fairness (20 Pt)" is structurally valid but
            // is packaging of "Fairness", and the two must become one canonical topic.
            boolean salvageApplies = salvaged != null && !salvaged.equals(row.name().trim())
                    && TopicCandidateQuality.evaluate(salvaged).accepted();
            if (decision.accepted() && !salvageApplies) { valid++; continue; }
            if (!decision.accepted()) rejections.merge(decision.reason().name(), 1L, Long::sum);

            if (salvageApplies) {
                UUID target = registry.find(courseId, salvaged);
                if (target != null && !target.equals(row.id())) {
                    if (mergeInto(courseId, target, row.id(), salvaged)) merged++; else keptInvalid++;
                    continue;
                }
                if (rename(row.id(), salvaged, courseId)) { renamed++; audit(courseId, row.name(), decision, "CLEANUP"); continue; }
                // A colliding row appeared between the find and the update: fold into it.
                UUID winner = registry.find(courseId, salvaged);
                if (winner != null && !winner.equals(row.id()) && mergeInto(courseId, winner, row.id(), salvaged)) { merged++; continue; }
                keptInvalid++;
                audit(courseId, row.name(), decision, "CLEANUP");
                continue;
            }

            if (!referenced(row.id())) {
                jdbc.update("DELETE FROM topics WHERE id=? AND course_id=?", row.id(), courseId);
                deleted++;
                audit(courseId, row.name(), decision, "CLEANUP");
            } else {
                // Evidence exists: the learner or the curriculum uses this row. Keep it, record it,
                // and let the derived universes (exam analysis, prediction) exclude it by rule.
                keptInvalid++;
                audit(courseId, row.name(), decision, "CLEANUP");
            }
        }
        CleanupReport report = new CleanupReport(rows.size(), valid, renamed, merged, deleted, keptInvalid, rejections);
        log.info("Topic quality cleanup for course {}: {}", courseId, report);
        return report;
    }

    private boolean mergeInto(UUID courseId, UUID keptId, UUID droppedId, String salvagedName) {
        TopicReconciliationService.TopicRow kept = row(keptId);
        TopicReconciliationService.TopicRow dropped = row(droppedId);
        if (kept == null || dropped == null) return false;
        // Deterministic verdict: the salvaged spelling proves the two names are packaging variants.
        TopicReconciliationCore.Verdict verdict = TopicReconciliationCore.mergeByCleanup(
                salvagedName, dropped.name(), kept.name());
        boolean done = reconciliation.mergeTopics(courseId, kept, dropped, verdict);
        if (done) audit(courseId, dropped.name(), TopicCandidateQuality.evaluate(dropped.name()), "CLEANUP");
        return done;
    }

    private TopicReconciliationService.TopicRow row(UUID topicId) {
        return jdbc.query("SELECT id,canonical_name,normalized_name,description,embedding::text AS embedding FROM topics WHERE id=?",
                rs -> rs.next() ? new TopicReconciliationService.TopicRow(rs.getObject("id", UUID.class), rs.getString("canonical_name"),
                        rs.getString("normalized_name"), rs.getString("description"), rs.getString("embedding")) : null, topicId);
    }

    /** Rename keeps every reference in place — only the label and its normalisation change. */
    private boolean rename(UUID topicId, String salvaged, UUID courseId) {
        String normalized = TopicRegistry.normalize(salvaged);
        int updated = jdbc.update("""
                UPDATE topics SET canonical_name=?, normalized_name=? WHERE id=? AND course_id=?
                  AND NOT EXISTS (SELECT 1 FROM topics WHERE course_id=? AND normalized_name=? AND id<>?)
                """, salvaged, normalized, topicId, courseId, courseId, normalized, topicId);
        return updated == 1;
    }

    /**
     * References that BLOCK deletion are learner and curriculum state. Chunk links, topic edges,
     * objectives and exam signals are derived extraction artifacts — they cascade away with the
     * topic and are regenerated by the rebuild under the current extraction policy, so they must
     * never keep a junk topic alive.
     */
    private boolean referenced(UUID topicId) {
        Boolean referenced = jdbc.query("""
                SELECT EXISTS(SELECT 1 FROM assessment_item_topics WHERE topic_id=?)
                    OR EXISTS(SELECT 1 FROM assessment_items WHERE topic_id=?)
                    OR EXISTS(SELECT 1 FROM assessment_attempts WHERE topic_id=?)
                    OR EXISTS(SELECT 1 FROM student_topic_state WHERE topic_id=?)
                    OR EXISTS(SELECT 1 FROM learning_events WHERE topic_id=?)
                    OR EXISTS(SELECT 1 FROM learning_sessions WHERE topic_id=?)
                    OR EXISTS(SELECT 1 FROM misconceptions WHERE topic_id=?)
                    OR EXISTS(SELECT 1 FROM curriculum_lessons WHERE topic_id=?)
                    OR EXISTS(SELECT 1 FROM topic_ladder_state WHERE topic_id=?)
                """, rs -> rs.next() && rs.getBoolean(1), topicId, topicId, topicId, topicId,
                topicId, topicId, topicId, topicId, topicId);
        return Boolean.TRUE.equals(referenced);
    }

    private void audit(UUID courseId, String candidate, TopicCandidateQuality.Decision decision, String source) {
        try {
            String normalized = TopicRegistry.normalize(candidate);
            if (normalized.isBlank()) return;
            jdbc.update("""
                INSERT INTO topic_extraction_audit(id,course_id,normalized_candidate,sample,source,decision,reason,quality_score,extraction_version)
                VALUES(?,?,?,?,?,?,?,?,?)
                ON CONFLICT(course_id,normalized_candidate,source) DO UPDATE SET
                    occurrences=topic_extraction_audit.occurrences+1, last_seen_at=NOW()
                """, UUID.randomUUID(), courseId, normalized, candidate.length() > 500 ? candidate.substring(0, 500) : candidate,
                    source, decision.accepted() ? "ACCEPTED" : "REJECTED", decision.reason().name(), decision.qualityScore(), TopicCandidateQuality.VERSION);
        } catch (RuntimeException error) {
            log.warn("Topic cleanup audit write failed for course {}: {}", courseId, error.getMessage());
        }
    }
}
