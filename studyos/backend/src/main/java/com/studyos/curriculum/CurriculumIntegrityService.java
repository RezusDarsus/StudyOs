package com.studyos.curriculum;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Runs the deterministic integrity validator over the active curriculum, stores the report beside
 * the curriculum, and applies only the safe repairs: removing exact duplicate lessons and
 * redirecting lessons that point at merged topics. Structural problems (cycles, ordering breaks,
 * missing topics) are never silently "fixed" — they are reported, and a re-plan decides.
 */
@Service
public class CurriculumIntegrityService {
    private static final Logger log = LoggerFactory.getLogger(CurriculumIntegrityService.class);

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final TransactionTemplate transaction;

    public CurriculumIntegrityService(JdbcTemplate jdbc, ObjectMapper mapper, PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.transaction = new TransactionTemplate(transactionManager);
    }

    /** Validates the given curriculum (id + workspace) and persists the report on its row. */
    public CurriculumIntegrityValidator.Report validate(UUID workspaceId, UUID curriculumId) {
        CurriculumIntegrityValidator.Input input = load(workspaceId, curriculumId);
        CurriculumIntegrityValidator.Report report = CurriculumIntegrityValidator.validate(input);
        try {
            jdbc.update("UPDATE curricula SET integrity_report=CAST(? AS jsonb),validated_at=NOW() WHERE id=?", mapper.writeValueAsString(Map.of(
                    "findings", report.findings(), "errors", report.errors(), "warnings", report.warnings(),
                    "infos", report.infos(), "needsRegeneration", report.needsRegeneration(),
                    "items", report.items().stream().map(item -> Map.of(
                            "code", item.code(), "severity", item.severity().name(), "message", item.message(),
                            "lessonId", item.lessonId() == null ? "" : item.lessonId().toString(),
                            "topicId", item.topicId() == null ? "" : item.topicId().toString())).toList())), curriculumId);
        } catch (Exception error) {
            log.warn("Integrity report could not be stored for curriculum {}: {}", curriculumId, error.getMessage());
        }
        return report;
    }

    /** Validates the workspace's active curriculum, or returns null when it has none. */
    public CurriculumIntegrityValidator.Report validateActive(UUID workspaceId) {
        UUID curriculumId = jdbc.query("SELECT id FROM curricula WHERE course_id=? AND status='ACTIVE' ORDER BY generated_at DESC LIMIT 1",
                rs -> rs.next() ? rs.getObject(1, UUID.class) : null, workspaceId);
        return curriculumId == null ? null : validate(workspaceId, curriculumId);
    }

    /**
     * Applies the safe deterministic repairs, then re-validates. Returns the fresh report and what
     * was repaired; anything structural that remains is left for an explicit re-plan.
     */
    public RepairResult repair(UUID workspaceId) {
        var curriculum = jdbc.query("SELECT id FROM curricula WHERE course_id=? AND status='ACTIVE' ORDER BY generated_at DESC LIMIT 1",
                rs -> rs.next() ? rs.getObject(1, UUID.class) : null, workspaceId);
        if (curriculum == null) return new RepairResult(0, 0, null);
        CurriculumIntegrityValidator.Report before = validate(workspaceId, curriculum);
        int removed = removeDuplicates(workspaceId, curriculum);
        int redirected = redirectMergedTopics(workspaceId, curriculum);
        CurriculumIntegrityValidator.Report after = validate(workspaceId, curriculum);
        return new RepairResult(removed, redirected, after);
    }

    /** Exact duplicate lessons (same normalized title in the same curriculum) — later copies go. */
    private int removeDuplicates(UUID workspaceId, UUID curriculumId) {
        return transaction.execute(status -> {
            List<UUID> removable = jdbc.query("""
                    SELECT l.id FROM curriculum_lessons l
                    JOIN curriculum_modules m ON m.id=l.module_id
                    WHERE m.curriculum_id=?
                      AND EXISTS (SELECT 1 FROM curriculum_lessons earlier
                                  JOIN curriculum_modules em ON em.id=earlier.module_id
                                  WHERE em.curriculum_id=m.curriculum_id
                                    AND earlier.id <> l.id
                                    AND LOWER(REGEXP_REPLACE(earlier.title,'[^a-zA-Z0-9]+',' ','g'))=LOWER(REGEXP_REPLACE(l.title,'[^a-zA-Z0-9]+',' ','g'))
                                    AND (em.ordinal < m.ordinal OR (em.ordinal=m.ordinal AND earlier.ordinal < l.ordinal)))
                    """, (rs, row) -> rs.getObject(1, UUID.class), curriculumId);
            for (UUID lessonId : removable) jdbc.update("DELETE FROM curriculum_lessons WHERE id=?", lessonId);
            return removable.size();
        });
    }

    /** Lessons still pointing at a merged-away topic move to the canonical topic. */
    private int redirectMergedTopics(UUID workspaceId, UUID curriculumId) {
        return transaction.execute(status -> {
            int moved = jdbc.update("""
                    UPDATE curriculum_lessons l SET topic_id=t.canonical_topic_id
                    FROM topics t
                    WHERE l.topic_id=t.id AND t.canonical_topic_id IS NOT NULL
                      AND l.course_id=?
                    """, workspaceId);
            // A redirect can leave a lesson pointing at the same topic twice over; that is fine.
            return moved;
        });
    }

    private CurriculumIntegrityValidator.Input load(UUID workspaceId, UUID curriculumId) {
        record LessonRow(UUID id, UUID topicId, String title, int moduleOrdinal, int ordinal, int targetLevel, int minutes, String objective) {}
        List<LessonRow> rows = jdbc.query("""
                SELECT l.id,l.topic_id,l.title,m.ordinal AS module_ordinal,l.ordinal,l.target_level,l.estimated_minutes,l.objective
                FROM curriculum_lessons l JOIN curriculum_modules m ON m.id=l.module_id
                WHERE m.curriculum_id=? ORDER BY m.ordinal,l.ordinal
                """, (rs, row) -> new LessonRow(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3),
                rs.getInt(4), rs.getInt(5), rs.getInt(6), rs.getInt(7), rs.getString(8)), curriculumId);
        List<CurriculumIntegrityValidator.LessonInput> lessons = rows.stream()
                .map(row -> new CurriculumIntegrityValidator.LessonInput(row.id(), row.topicId(), row.title(), row.moduleOrdinal(), row.ordinal(), row.targetLevel(), row.minutes(), row.objective()))
                .toList();
        List<CurriculumIntegrityValidator.EdgeInput> edges = jdbc.query("""
                SELECT p.lesson_id,p.prerequisite_lesson_id FROM curriculum_lesson_prerequisites p
                JOIN curriculum_lessons l ON l.id=p.lesson_id JOIN curriculum_modules m ON m.id=l.module_id
                WHERE m.curriculum_id=?
                """, (rs, rowNum) -> new CurriculumIntegrityValidator.EdgeInput(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)), curriculumId);
        Set<UUID> knownTopics = new HashSet<>(jdbc.queryForList("SELECT id FROM topics WHERE course_id=?", UUID.class, workspaceId));
        Map<UUID, Long> evidence = new HashMap<>();
        jdbc.query("SELECT t.id, COUNT(DISTINCT ct.chunk_id) FROM topics t LEFT JOIN chunk_topics ct ON ct.topic_id=t.id WHERE t.course_id=? GROUP BY t.id",
                rs -> { while (rs.next()) evidence.put(rs.getObject(1, UUID.class), rs.getLong(2)); return null; }, workspaceId);
        Map<UUID, Double> importance = new HashMap<>();
        jdbc.query("SELECT id,importance FROM topics t WHERE t.course_id=? AND importance IS NOT NULL",
                rs -> { while (rs.next()) importance.put(rs.getObject(1, UUID.class), rs.getDouble(2)); return null; }, workspaceId);
        Map<UUID, Double> difficulty = new HashMap<>();
        jdbc.query("SELECT id,difficulty FROM topics t WHERE t.course_id=? AND difficulty IS NOT NULL",
                rs -> { while (rs.next()) difficulty.put(rs.getObject(1, UUID.class), rs.getDouble(2)); return null; }, workspaceId);
        Map<UUID, Set<UUID>> topicPrerequisites = new LinkedHashMap<>();
        jdbc.query("""
                SELECT dependent_topic_id, prerequisite_topic_id FROM topic_prerequisites WHERE course_id=?
                """, rs -> {
            while (rs.next()) {
                topicPrerequisites.computeIfAbsent(rs.getObject(1, UUID.class), key -> new HashSet<>())
                        .add(rs.getObject(2, UUID.class));
            }
            return null;
        }, workspaceId);
        return new CurriculumIntegrityValidator.Input(lessons, edges, knownTopics, evidence, importance, difficulty, topicPrerequisites);
    }

    public record RepairResult(int duplicatesRemoved, int topicsRedirected, CurriculumIntegrityValidator.Report report) {}
}
