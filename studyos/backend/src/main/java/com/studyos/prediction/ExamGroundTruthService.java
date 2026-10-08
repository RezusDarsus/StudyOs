package com.studyos.prediction;

import java.sql.Timestamp;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Builds the immutable evaluation snapshot for backtesting from stored exam evidence.
 *
 * <p>Ground truth is the parsed record of what actually appeared on each historical exam — the
 * assessment items and their topic links — never a prediction output. Every topic id, in ground
 * truth and in profiles, is resolved through {@code topics.canonical_topic_id} first, so a merged
 * synonym can never manufacture a false prediction miss. The snapshot also carries the
 * reproducibility fingerprint (course revision, topic-graph revision) a persisted run stores.
 */
@Service
public class ExamGroundTruthService {

    private final JdbcTemplate jdbc;

    public ExamGroundTruthService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public BacktestEngine.Snapshot snapshot(UUID courseId) {
        List<BacktestEngine.ExamGroundTruth> exams = groundTruths(courseId);
        Map<UUID, BacktestEngine.TopicProfile> profiles = profiles(courseId);
        Map<UUID, UUID> canonicalOf = new HashMap<>();
        jdbc.query("SELECT id, canonical_topic_id FROM topics WHERE course_id=? AND canonical_topic_id IS NOT NULL",
                rs -> { while (rs.next()) canonicalOf.put(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)); return null; }, courseId);

        Map<UUID, Integer> homework = countByTopic("""
                SELECT ait.topic_id, COUNT(*) FROM assessment_item_topics ait
                JOIN assessment_items ai ON ai.id=ait.item_id
                WHERE ai.course_id=? AND ai.source_type='HOMEWORK' GROUP BY ait.topic_id
                """, courseId);
        Map<UUID, Integer> quiz = countByTopic("""
                SELECT ait.topic_id, COUNT(*) FROM assessment_item_topics ait
                JOIN assessment_items ai ON ai.id=ait.item_id
                WHERE ai.course_id=? AND ai.source_type='QUIZ' GROUP BY ait.topic_id
                """, courseId);
        Map<UUID, Integer> lectures = countByTopic("""
                SELECT ct.topic_id, COUNT(DISTINCT c.document_id) FROM chunk_topics ct
                JOIN chunks c ON c.id=ct.chunk_id JOIN documents d ON d.id=c.document_id
                WHERE d.course_id=? AND d.document_type='LECTURE' GROUP BY ct.topic_id
                """, courseId);
        Map<UUID, Integer> centrality = new HashMap<>();
        int[] maxCentrality = {0};
        jdbc.query("""
                SELECT topic_id, topic_centrality FROM exam_topic_signals WHERE course_id=?
                """, rs -> {
            while (rs.next()) {
                UUID resolved = canonicalOf.getOrDefault(rs.getObject("topic_id", UUID.class), rs.getObject("topic_id", UUID.class));
                int value = (int) Math.round(rs.getDouble("topic_centrality"));
                centrality.merge(resolved, value, Integer::sum);
                maxCentrality[0] = Math.max(maxCentrality[0], value);
            }
            return null;
        }, courseId);
        Map<UUID, Integer> syllabus = syllabusMarkers(courseId);

        Integer totalHomework = jdbc.queryForObject("SELECT COUNT(*) FROM assessment_items WHERE course_id=? AND source_type='HOMEWORK'", Integer.class, courseId);
        Integer totalQuiz = jdbc.queryForObject("SELECT COUNT(*) FROM assessment_items WHERE course_id=? AND source_type='QUIZ'", Integer.class, courseId);
        Integer totalLecture = jdbc.queryForObject("SELECT COUNT(*) FROM documents WHERE course_id=? AND document_type='LECTURE' AND status='COMPLETED'", Integer.class, courseId);

        Map<UUID, BacktestEngine.TopicProfile> profileMap = new LinkedHashMap<>();
        profiles.forEach((topicId, profile) -> profileMap.put(topicId, new BacktestEngine.TopicProfile(
                topicId, profile.name(), profile.importance(), centrality.getOrDefault(topicId, 0),
                homework.getOrDefault(topicId, 0), quiz.getOrDefault(topicId, 0),
                lectures.getOrDefault(topicId, 0), syllabus.getOrDefault(topicId, 0))));
        Map<UUID, BacktestEngine.TopicProfile> enriched = new LinkedHashMap<>(profileMap);

        String courseRevision = String.valueOf(jdbc.queryForObject(
                "SELECT COALESCE(MAX(revision),0) FROM curricula WHERE course_id=?", Integer.class, courseId));
        Integer topicGraphRevision = topicGraphRevision(courseId);

        return new BacktestEngine.Snapshot(exams, enriched, canonicalOf,
                totalHomework == null ? 0 : totalHomework, totalQuiz == null ? 0 : totalQuiz,
                totalLecture == null ? 0 : totalLecture, maxCentrality[0], courseRevision, topicGraphRevision,
                objectiveApplyShares(courseId), testedDependents(courseId, canonicalOf));
    }

    /**
     * Share of a topic's objectives that demand apply-level work or above (cognitive rank ≥ 3).
     * Absent from the map = no measured objectives — the feature layer treats that as neutral.
     */
    private Map<UUID, Double> objectiveApplyShares(UUID courseId) {
        Map<UUID, Double> shares = new HashMap<>();
        jdbc.query("""
                SELECT topic_id,
                       COUNT(*) FILTER (WHERE cognitive_level >= 3) / NULLIF(COUNT(cognitive_level), 0)::numeric AS apply_share
                FROM topic_objectives WHERE course_id=? GROUP BY topic_id
                """, rs -> {
            while (rs.next()) shares.put(rs.getObject("topic_id", UUID.class), rs.getDouble("apply_share"));
            return null;
        }, courseId);
        return shares;
    }

    /** Prerequisite edges as topic → [dependents it unlocks], canonical-resolved, batch-loaded. */
    private Map<UUID, List<UUID>> testedDependents(UUID courseId, Map<UUID, UUID> canonicalOf) {
        Map<UUID, List<UUID>> dependents = new HashMap<>();
        jdbc.query("SELECT source_topic_id, target_topic_id, relation_type FROM topic_edges WHERE course_id=?",
                rs -> {
                    while (rs.next()) {
                        String type = rs.getString("relation_type");
                        UUID source = resolveCanonical(canonicalOf, rs.getObject("source_topic_id", UUID.class));
                        UUID target = resolveCanonical(canonicalOf, rs.getObject("target_topic_id", UUID.class));
                        // PREREQUISITE_OF: source is the prerequisite, target the dependent.
                        // BUILDS_ON: the reverse reading the rest of the system already agrees on.
                        UUID prerequisite = "BUILDS_ON".equalsIgnoreCase(type) ? target : source;
                        UUID dependent = "BUILDS_ON".equalsIgnoreCase(type) ? source : target;
                        if (prerequisite.equals(dependent)) continue;
                        dependents.computeIfAbsent(prerequisite, key -> new ArrayList<>()).add(dependent);
                    }
                    return null;
                }, courseId);
        return dependents;
    }

    private UUID resolveCanonical(Map<UUID, UUID> canonicalOf, UUID topicId) {
        UUID resolved = topicId;
        for (int hop = 0; hop < 5 && resolved != null && canonicalOf.containsKey(resolved); hop++) resolved = canonicalOf.get(resolved);
        return resolved;
    }

    /**
     * Ground truth per historical exam: canonical topics with weight (share of the exam's points)
     * and question counts, plus the question-type structure. Derived only from parsed exam rows.
     */
    public List<BacktestEngine.ExamGroundTruth> groundTruths(UUID courseId) {
        Map<UUID, UUID> canonicalOf = new HashMap<>();
        jdbc.query("SELECT id, canonical_topic_id FROM topics WHERE course_id=? AND canonical_topic_id IS NOT NULL",
                rs -> { while (rs.next()) canonicalOf.put(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)); return null; }, courseId);

        record Exam(UUID id, String name, Integer year, Timestamp createdAt, LocalDate date) {}
        // Exam year lives on the parsed assessment items (V8), not on the document row.
        List<Exam> exams = jdbc.query("""
                SELECT d.id, d.name, MIN(ai.year) AS year, MAX(d.created_at) AS created_at, MAX(d.created_at)::date AS exam_date
                FROM documents d
                LEFT JOIN assessment_items ai ON ai.document_id=d.id
                WHERE d.course_id=? AND d.document_type='PAST_EXAM' AND d.status='COMPLETED'
                GROUP BY d.id, d.name
                ORDER BY COALESCE(MIN(ai.year), 9999), MAX(d.created_at), d.id
                """, (rs, row) -> new Exam(rs.getObject("id", UUID.class), rs.getString("name"),
                rs.getObject("year", Integer.class), rs.getTimestamp("created_at"),
                rs.getObject("exam_date", LocalDate.class)), courseId);

        // Aggregation happens in Java over three bounded queries — never one query per exam.
        record ItemRow(UUID documentId, UUID topicId, Double points, String type) {}
        List<ItemRow> rows = jdbc.query("""
                SELECT ai.document_id, ait.topic_id, COALESCE(ai.points,0) AS points, ai.type
                FROM assessment_items ai JOIN assessment_item_topics ait ON ait.item_id=ai.id
                WHERE ai.course_id=? AND ai.source_type='PAST_EXAM'
                """, (rs, row) -> new ItemRow(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getDouble(3), rs.getString(4)), courseId);
        List<ItemRow> typeOnlyRows = jdbc.query("""
                SELECT document_id, NULL::uuid AS topic_id, COALESCE(points,0) AS points, type
                FROM assessment_items WHERE course_id=? AND source_type='PAST_EXAM'
                """, (rs, row) -> new ItemRow(rs.getObject(1, UUID.class), null, rs.getDouble(3), rs.getString(4)), courseId);

        Map<UUID, Map<UUID, Double>> weights = new HashMap<>();
        Map<UUID, Map<UUID, Integer>> questionCounts = new HashMap<>();
        Map<UUID, Map<String, Integer>> structures = new HashMap<>();
        // Ground truth uses the same clean universe the predictor sees: a rejected candidate ("Show",
        // "(20 Pt)" packaging) that a question was lexically linked to is a false actual, not a miss.
        Map<UUID, String> topicNames = topicNames(courseId);
        for (ItemRow row : rows) {
            UUID canonical = canonicalOf.getOrDefault(row.topicId(), row.topicId());
            String name = topicNames.get(canonical);
            if (name != null && !com.studyos.knowledge.TopicCandidateQuality.evaluate(name).accepted()) continue;
            weights.computeIfAbsent(row.documentId(), key -> new HashMap<>()).merge(canonical, row.points(), Double::sum);
            questionCounts.computeIfAbsent(row.documentId(), key -> new HashMap<>()).merge(canonical, 1, Integer::sum);
        }

        List<BacktestEngine.ExamGroundTruth> result = new ArrayList<>();
        for (int order = 0; order < exams.size(); order++) {
            Exam exam = exams.get(order);
            Map<UUID, Double> examWeights = weights.getOrDefault(exam.id(), Map.of());
            double total = examWeights.values().stream().mapToDouble(Double::doubleValue).sum();
            Map<UUID, Double> normalised = new LinkedHashMap<>();
            examWeights.forEach((topicId, weight) -> normalised.put(topicId, total > 0 ? weight / total : 0));
            result.add(new BacktestEngine.ExamGroundTruth(order, exam.id(), exam.name(), exam.year(), exam.date(),
                    new java.util.LinkedHashSet<>(normalised.keySet()),
                    normalised, questionCounts.getOrDefault(exam.id(), Map.of()),
                    structures.getOrDefault(exam.id(), Map.of())));
        }
        return result;
    }

    private Map<UUID, BacktestEngine.TopicProfile> profiles(UUID courseId) {
        Map<UUID, BacktestEngine.TopicProfile> profiles = new LinkedHashMap<>();
        jdbc.query("""
                SELECT t.id, t.canonical_name, t.importance FROM topics t
                WHERE t.course_id=? AND t.canonical_topic_id IS NULL
                """, rs -> {
            while (rs.next()) {
                String name = rs.getString("canonical_name");
                // Rejected candidates stay out of the probability universe even when referenced.
                if (!com.studyos.knowledge.TopicCandidateQuality.evaluate(name).accepted()) continue;
                UUID id = rs.getObject(1, UUID.class);
                profiles.put(id, new BacktestEngine.TopicProfile(id, name, rs.getObject("importance", Double.class), 0, 0, 0, 0, 0));
            }
            return null;
        }, courseId);
        return profiles;
    }

    private Map<UUID, String> topicNames(UUID courseId) {
        Map<UUID, String> names = new HashMap<>();
        jdbc.query("SELECT id, canonical_name FROM topics WHERE course_id=?",
                rs -> { while (rs.next()) names.put(rs.getObject(1, UUID.class), rs.getString(2)); return null; }, courseId);
        return names;
    }

    private Map<UUID, Integer> syllabusMarkers(UUID courseId) {
        Map<UUID, Integer> markers = new HashMap<>();
        jdbc.query("""
                SELECT DISTINCT t.id FROM topics t
                JOIN exam_topic_signals es ON es.topic_id=t.id AND es.course_id=t.course_id
                WHERE t.course_id=? AND es.syllabus_importance > 0
                """, rs -> { while (rs.next()) markers.put(rs.getObject(1, UUID.class), 1); return null; }, courseId);
        return markers;
    }

    private Map<UUID, Integer> countByTopic(String sql, UUID courseId) {
        Map<UUID, Integer> result = new HashMap<>();
        jdbc.query(sql, rs -> {
            while (rs.next()) {
                result.merge(rs.getObject(1, UUID.class), rs.getInt(2), Integer::sum);
            }
            return null;
        }, courseId);
        return result;
    }

    /** Cheap deterministic fingerprint of the topic graph for reproducibility snapshots. */
    public Integer topicGraphRevision(UUID courseId) {
        Integer topics = jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE course_id=?", Integer.class, courseId);
        Timestamp latestModel = jdbc.queryForObject("SELECT MAX(model_updated_at) FROM topics WHERE course_id=?", Timestamp.class, courseId);
        Integer edges = jdbc.queryForObject("SELECT COUNT(*) FROM topic_edges WHERE course_id=?", Integer.class, courseId);
        return Objects.hash(topics, edges, latestModel);
    }
}
