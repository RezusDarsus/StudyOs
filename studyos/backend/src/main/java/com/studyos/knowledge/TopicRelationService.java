package com.studyos.knowledge;

import com.studyos.ingestion.Chunk;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Turns extracted relation candidates into stored edges, and records every candidate it refuses.
 *
 * <p>Validation is this class's whole reason for existing: {@link TopicRelationExtractor} proposes, and nothing it
 * proposes reaches {@code topic_edges} until both endpoints resolve to real topics in this workspace, the edge is
 * not a duplicate, and — for the directed types — it does not close a cycle in its own relation. What is refused is
 * written to {@code topic_relation_rejections} with a reason rather than dropped, so a sparse graph can be
 * explained.
 */
@Service
public class TopicRelationService {
    private static final Logger log = LoggerFactory.getLogger(TopicRelationService.class);
    private final JdbcTemplate jdbc;
    private final TopicRelationExtractor extractor;

    public TopicRelationService(JdbcTemplate jdbc, TopicRelationExtractor extractor) { this.jdbc = jdbc; this.extractor = extractor; }

    public void extract(UUID courseId, List<Chunk> chunks) {
        Map<String, Topic> topics = topics(courseId);
        if (topics.size() < 2) return;
        List<String> names = topics.values().stream().map(Topic::name).toList();
        Map<Key, TopicRelationExtractor.Candidate> candidates = new LinkedHashMap<>();
        for (Chunk chunk : chunks) for (TopicRelationExtractor.Candidate candidate : extractor.extract(chunk, names)) {
            Topic source = topics.get(normalize(candidate.sourceName()));
            Topic target = topics.get(normalize(candidate.targetName()));
            Key key = new Key(source == null ? null : source.id(), target == null ? null : target.id(), candidate.type());
            candidates.putIfAbsent(key, candidate);
        }
        candidates.values().forEach(candidate -> persist(courseId, topics, candidate));
    }

    public synchronized RebuildResult rebuild(UUID courseId) {
        jdbc.update("DELETE FROM topic_edges WHERE course_id=? AND extraction_method LIKE 'LOCAL_RULE_%'", courseId);
        jdbc.update("DELETE FROM topic_relation_rejections WHERE course_id=? AND extraction_method LIKE 'LOCAL_RULE_%'", courseId);
        List<Chunk> chunks = jdbc.query("SELECT id,ordinal,page_start,page_end,content,COALESCE(token_count,0) FROM chunks WHERE course_id=? ORDER BY document_id,ordinal", (rs, row) -> new Chunk(rs.getObject(1, UUID.class), rs.getInt(2), rs.getInt(3), rs.getInt(4), rs.getString(5), rs.getInt(6)), courseId);
        extract(courseId, chunks);
        int edges = jdbc.queryForObject("SELECT COUNT(*) FROM topic_edges WHERE course_id=?", Integer.class, courseId);
        int rejected = jdbc.queryForObject("SELECT COUNT(*) FROM topic_relation_rejections WHERE course_id=?", Integer.class, courseId);
        return new RebuildResult(edges, rejected, byType(courseId));
    }

    /** How many edges of each kind the workspace holds, so a widened vocabulary is visible rather than inferred. */
    private Map<String, Integer> byType(UUID courseId) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (TopicRelationType type : TopicRelationType.values()) counts.put(type.name(), 0);
        jdbc.query("SELECT relation_type,COUNT(*) FROM topic_edges WHERE course_id=? GROUP BY relation_type",
                rs -> { while (rs.next()) counts.put(rs.getString(1), rs.getInt(2)); return null; }, courseId);
        return Map.copyOf(counts);
    }

    public List<Edge> list(UUID courseId) {
        return jdbc.query("SELECT e.id,e.source_topic_id,s.canonical_name,e.target_topic_id,t.canonical_name,e.relation_type,e.confidence,e.source_chunk_id,e.extraction_method,e.created_at FROM topic_edges e JOIN topics s ON s.id=e.source_topic_id JOIN topics t ON t.id=e.target_topic_id WHERE e.course_id=? ORDER BY e.relation_type,s.canonical_name,t.canonical_name", (rs, row) -> new Edge(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3), rs.getObject(4, UUID.class), rs.getString(5), TopicRelationType.valueOf(rs.getString(6)), rs.getObject(7, Double.class), rs.getObject(8, UUID.class), rs.getString(9), rs.getTimestamp(10)), courseId);
    }

    private void persist(UUID courseId, Map<String, Topic> topics, TopicRelationExtractor.Candidate candidate) {
        Topic source = topics.get(normalize(candidate.sourceName()));
        Topic target = topics.get(normalize(candidate.targetName()));
        if (source == null || target == null) { reject(courseId, source, target, candidate, "UNRESOLVED_ENDPOINT"); return; }
        if (source.id().equals(target.id())) { reject(courseId, source, target, candidate, "SELF_EDGE"); return; }
        if (restoreProvenance(courseId, source.id(), target.id(), candidate)) return;
        if (exists(courseId, source.id(), target.id(), candidate.type())) { reject(courseId, source, target, candidate, "DUPLICATE_EDGE"); return; }
        if (candidate.type().acyclic() && createsCycle(courseId, source.id(), target.id(), candidate.type())) { reject(courseId, source, target, candidate, cycleReason(candidate.type())); return; }
        jdbc.update("INSERT INTO topic_edges(id,course_id,source_topic_id,target_topic_id,relation_type,confidence,source_chunk_id,extraction_method) VALUES(?,?,?,?,?,?,?,?)", UUID.randomUUID(), courseId, source.id(), target.id(), candidate.type().name(), clamp(candidate.confidence()), candidate.sourceChunkId(), candidate.extractionMethod());
    }

    /**
     * Re-attaches chunk provenance to an edge this extractor derived before, whose chunk row was
     * deleted by a document's re-ingestion and nulled out by the foreign key.
     *
     * <p>Re-ingesting a document replaces its chunk rows, so every edge derived from one loses the
     * chunk it pointed at. Without this, the edge survives but re-extraction would refuse the fresh
     * candidate as a duplicate, and the provenance would be gone permanently. The update only fires
     * for an edge this same extraction method produced and only when the pointer is actually gone, so
     * a candidate from a different extractor, or an edge that still cites its chunk, is never touched.
     *
     * @return whether this candidate was consumed by restoring an existing edge's provenance
     */
    private boolean restoreProvenance(UUID courseId, UUID sourceId, UUID targetId, TopicRelationExtractor.Candidate candidate) {
        // A symmetric edge may be stored in either orientation, so both are tried; a directed one only in its own.
        int orientations = candidate.type().symmetric() ? 2 : 1;
        for (int i = 0; i < orientations; i++) {
            UUID from = i == 0 ? sourceId : targetId;
            UUID to = i == 0 ? targetId : sourceId;
            int updated = jdbc.update("UPDATE topic_edges SET source_chunk_id=?,confidence=? WHERE course_id=? AND source_topic_id=? AND target_topic_id=? AND relation_type=? AND extraction_method=? AND source_chunk_id IS NULL",
                    candidate.sourceChunkId(), clamp(candidate.confidence()), courseId, from, to, candidate.type().name(), candidate.extractionMethod());
            if (updated > 0) return true;
        }
        return false;
    }

    /**
     * Whether this edge is already stored, counting the mirror image of a symmetric one as the same edge.
     *
     * <p>The extractor already emits symmetric relations in one fixed endpoint order, so the mirror only arises
     * from rows another writer left behind — legacy relations migrated in by V9, or an earlier build of the
     * extractor. Storing both directions would count one comparison twice everywhere edges are counted.
     */
    private boolean exists(UUID courseId, UUID source, UUID target, TopicRelationType type) {
        if (type.symmetric()) return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM topic_edges WHERE course_id=? AND relation_type=? AND ((source_topic_id=? AND target_topic_id=?) OR (source_topic_id=? AND target_topic_id=?)))", Boolean.class, courseId, type.name(), source, target, target, source));
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM topic_edges WHERE course_id=? AND source_topic_id=? AND target_topic_id=? AND relation_type=?)", Boolean.class, courseId, source, target, type.name()));
    }

    /**
     * Whether adding this edge would let a chain of the same relation reach back to where it started.
     *
     * <p>Per relation type, not across types: a topic can be a part of something that builds on it without either
     * hierarchy contradicting itself, and mixing the walks would reject honest edges. Only the directed types are
     * asked at all — a symmetric pair is trivially a two-cycle and the question means nothing there.
     */
    private boolean createsCycle(UUID courseId, UUID source, UUID target, TopicRelationType type) {
        return Boolean.TRUE.equals(jdbc.queryForObject("WITH RECURSIVE reachable(topic_id) AS (SELECT target_topic_id FROM topic_edges WHERE course_id=? AND relation_type=? AND source_topic_id=? UNION SELECT e.target_topic_id FROM topic_edges e JOIN reachable r ON e.source_topic_id=r.topic_id WHERE e.course_id=? AND e.relation_type=?) SELECT EXISTS(SELECT 1 FROM reachable WHERE topic_id=?)", Boolean.class, courseId, type.name(), target, courseId, type.name(), source));
    }

    /** The reason PREREQUISITE_OF cycles have been recorded under since V9, kept, and one per new directed type. */
    private String cycleReason(TopicRelationType type) { return type == TopicRelationType.PREREQUISITE_OF ? "PREREQUISITE_CYCLE" : type.name() + "_CYCLE"; }
    private void reject(UUID courseId, Topic source, Topic target, TopicRelationExtractor.Candidate candidate, String reason) {
        // ON CONFLICT DO NOTHING against the identity index: the same refused candidate re-derived on a
        // later ingestion of the same document updates nothing instead of appending an identical row.
        jdbc.update("INSERT INTO topic_relation_rejections(id,course_id,source_topic_id,target_topic_id,source_name,target_name,relation_type,confidence,source_chunk_id,extraction_method,rejection_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (course_id, md5(source_name || '|' || target_name || '|' || relation_type || '|' || rejection_reason)) DO NOTHING", UUID.randomUUID(), courseId, source == null ? null : source.id(), target == null ? null : target.id(), candidate.sourceName(), candidate.targetName(), candidate.type().name(), clamp(candidate.confidence()), candidate.sourceChunkId(), candidate.extractionMethod(), reason);
        log.debug("Rejected topic relation {} -> {} ({}) for course {}: {}", candidate.sourceName(), candidate.targetName(), candidate.type(), courseId, reason);
    }
    private Map<String, Topic> topics(UUID courseId) { return jdbc.query("SELECT id,canonical_name FROM topics WHERE course_id=?", (rs, row) -> new Topic(rs.getObject(1, UUID.class), rs.getString(2)), courseId).stream().collect(java.util.stream.Collectors.toMap(topic -> normalize(topic.name()), topic -> topic, (left,right) -> left, LinkedHashMap::new)); }
    private double clamp(double value) { return Math.max(0, Math.min(1, value)); }
    private String normalize(String value) { return value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", " ").trim().replaceAll("\\s+", " "); }
    private record Topic(UUID id, String name) {}
    private record Key(UUID source, UUID target, TopicRelationType type) {}
    public record Edge(UUID id, UUID sourceTopicId, String sourceTopic, UUID targetTopicId, String targetTopic, TopicRelationType type, Double confidence, UUID sourceChunkId, String extractionMethod, java.sql.Timestamp createdAt) {}
    /**
     * @param edges every edge the workspace holds afterwards, of every kind
     * @param rejectedCandidates candidates refused, each with its reason kept in {@code topic_relation_rejections}
     * @param edgesByRelationType one entry per relation type the vocabulary allows, zero included, so a caller can
     *     tell a type that found nothing from a type this build does not know about
     */
    public record RebuildResult(int edges, int rejectedCandidates, Map<String, Integer> edgesByRelationType) {}
}
