package com.studyos.knowledge;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.adaptive.CognitiveLevel;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Collects what a course says a learner should be able to <em>do</em> with each topic, and attaches each statement
 * to the topic and the passage it came from.
 *
 * <p>StudyOS already held objectives in two places where nothing could use them. A syllabus unit holds a JSONB
 * array of objectives per week with no topic behind any entry, and a generated lesson holds one sentence with no
 * provenance. Neither answers the question assessment has to generate against and mastery has to be measured
 * against: what does knowing <em>this topic</em> mean. This writes that answer down once per source that states it.
 *
 * <p>Three sources, kept apart because they are not equally authoritative. SYLLABUS is the instructor's own words.
 * MATERIAL is an objective sentence found in the course material, with the chunk, section and pages it was found
 * in. CURRICULUM is a lesson StudyOS generated, which is the weakest of the three and labelled so a reader and a
 * grader can prefer the other two. They are derived in that order, so when the same statement appears twice the
 * stronger provenance is the one stored.
 *
 * <p>No topic is ever created here. An objective naming something this workspace has never extracted as a topic is
 * dropped rather than conjuring a topic out of a syllabus line — {@link TopicRegistry#find} only resolves, and
 * that is deliberate: topics come from the material, and an objectives list is not the material.
 */
@Service
public class TopicObjectiveService {
    private static final Logger log = LoggerFactory.getLogger(TopicObjectiveService.class);
    /**
     * Most objectives one document may contribute. A 600-page reader with a "Goals" heading on every chapter is
     * within reason; one that produces more than this is being parsed wrongly, and the cap is logged rather than
     * applied quietly so the truncation is never mistaken for the document having said less.
     */
    private static final int MAX_PER_DOCUMENT = 200;
    /** Topics one statement may be attached to when nothing in it names a topic outright. */
    private static final int MAX_TOPICS_PER_STATEMENT = 2;

    private final JdbcTemplate jdbc;
    private final TopicRegistry registry;
    private final ObjectMapper mapper;

    public TopicObjectiveService(JdbcTemplate jdbc, TopicRegistry registry, ObjectMapper mapper) { this.jdbc = jdbc; this.registry = registry; this.mapper = mapper; }

    /** One stored objective with where it came from. */
    public record Objective(UUID id, UUID topicId, String topic, String statement, Integer cognitiveLevel, String levelLabel,
                            String sourceKind, String documentName, String sectionPath, Integer pageStart, Integer pageEnd) {}

    /** What one derivation stored, per source, so a caller can see which sources the course actually has. */
    public record ObjectiveRebuild(int syllabus, int material, int curriculum, int unresolvedTopics) {}

    /**
     * Derives the objectives one document contributes: its syllabus units if it is a syllabus, and any objective
     * sentences written in its text.
     *
     * <p>Runs during ingestion after topics exist, because an objective with no topic to attach to is dropped.
     * Re-processing a document replaces only its own rows, so the rest of the workspace is untouched.
     */
    public ObjectiveRebuild extractDocument(UUID courseId, UUID documentId) {
        jdbc.update("DELETE FROM topic_objectives WHERE course_id=? AND document_id=? AND source_kind IN ('SYLLABUS','MATERIAL')", courseId, documentId);
        Tally tally = new Tally();
        syllabus(courseId, documentId, tally);
        material(courseId, documentId, tally);
        return tally.result();
    }

    /**
     * Re-derives every objective in the workspace from all three sources.
     *
     * <p>Deletes first and rebuilds whole, because a statement's source can move: a lesson can be regenerated, a
     * syllabus re-uploaded, a topic merged into another. Deriving over the top would leave rows attached to
     * evidence that no longer says what they claim.
     */
    public synchronized ObjectiveRebuild rebuild(UUID courseId) {
        jdbc.update("DELETE FROM topic_objectives WHERE course_id=?", courseId);
        Tally tally = new Tally();
        for (UUID documentId : jdbc.queryForList("SELECT DISTINCT document_id FROM syllabus_units WHERE course_id=?", UUID.class, courseId)) syllabus(courseId, documentId, tally);
        for (UUID documentId : jdbc.queryForList("SELECT id FROM documents WHERE course_id=? AND status='COMPLETED' ORDER BY created_at", UUID.class, courseId)) material(courseId, documentId, tally);
        curriculum(courseId, tally);
        return tally.result();
    }

    /** Every objective in the workspace, strongest provenance first within each topic. */
    public List<Objective> list(UUID courseId) {
        return jdbc.query("SELECT o.id,o.topic_id,t.canonical_name,o.statement,o.cognitive_level,o.source_kind,d.name AS document_name,o.section_path,o.page_start,o.page_end FROM topic_objectives o JOIN topics t ON t.id=o.topic_id LEFT JOIN documents d ON d.id=o.document_id WHERE o.course_id=? ORDER BY t.canonical_name,CASE o.source_kind WHEN 'SYLLABUS' THEN 0 WHEN 'MATERIAL' THEN 1 ELSE 2 END,o.cognitive_level NULLS LAST,o.statement",
                (rs, row) -> read(rs), courseId);
    }

    /** One topic's objectives, which is what a lesson, an exercise generator or a grader asks for. */
    public List<Objective> forTopic(UUID courseId, UUID topicId) {
        return jdbc.query("SELECT o.id,o.topic_id,t.canonical_name,o.statement,o.cognitive_level,o.source_kind,d.name AS document_name,o.section_path,o.page_start,o.page_end FROM topic_objectives o JOIN topics t ON t.id=o.topic_id LEFT JOIN documents d ON d.id=o.document_id WHERE o.course_id=? AND o.topic_id=? ORDER BY CASE o.source_kind WHEN 'SYLLABUS' THEN 0 WHEN 'MATERIAL' THEN 1 ELSE 2 END,o.cognitive_level NULLS LAST,o.statement",
                (rs, row) -> read(rs), courseId, topicId);
    }

    private Objective read(java.sql.ResultSet rs) throws java.sql.SQLException {
        Integer level = rs.getObject("cognitive_level", Integer.class);
        return new Objective(rs.getObject("id", UUID.class), rs.getObject("topic_id", UUID.class), rs.getString("canonical_name"), rs.getString("statement"),
                level, level == null ? null : CognitiveLevel.ofRank(level).label(), rs.getString("source_kind"), rs.getString("document_name"),
                rs.getString("section_path"), rs.getObject("page_start", Integer.class), rs.getObject("page_end", Integer.class));
    }

    /**
     * The syllabus's own objectives, attached to the topics the same unit names.
     *
     * <p>A unit lists both its topics and its objectives without saying which belongs to which, so a statement that
     * names one of the unit's topics goes to that topic alone and one that names none goes to all of them. That is
     * the instructor's own grouping — the week's objectives are about the week's topics — and inventing a finer
     * attribution than the document states would be a guess dressed as provenance.
     */
    private void syllabus(UUID courseId, UUID documentId, Tally tally) {
        if (documentId == null) return;
        List<Unit> units = jdbc.query("SELECT id,topics::text AS topics,learning_objectives::text AS learning_objectives,page_start FROM syllabus_units WHERE course_id=? AND document_id=? ORDER BY week_number NULLS LAST,created_at",
                (rs, row) -> new Unit(strings(rs.getString("topics")), strings(rs.getString("learning_objectives")), rs.getObject("page_start", Integer.class)), courseId, documentId);
        for (Unit unit : units) {
            List<Named> resolved = new ArrayList<>();
            for (String name : unit.topics()) {
                UUID topicId = registry.find(courseId, name);
                if (topicId == null) { tally.unresolved++; continue; }
                resolved.add(new Named(topicId, TopicRegistry.normalize(name)));
            }
            if (resolved.isEmpty()) continue;
            for (String raw : unit.objectives()) {
                String statement = ObjectiveExtractor.declared(raw);
                if (statement == null) continue;
                for (UUID topicId : target(statement, resolved)) if (insert(courseId, topicId, statement, ObjectiveExtractor.level(statement), "SYLLABUS", documentId, null, null, unit.pageStart(), unit.pageStart())) tally.syllabus++;
            }
        }
    }

    /**
     * Objective sentences written in the document's own text, attached to the topics the passage they were found in
     * is bound to.
     *
     * <p>The binding is the attribution: a chunk's topics are what StudyOS already measured that passage to be
     * about, so an objective stated in it is about those. A statement naming one of them outright goes to that one;
     * otherwise the passage's strongest bindings are used, capped, because a chunk bound to nine topics does not
     * make its objective an objective of all nine.
     */
    private void material(UUID courseId, UUID documentId, Tally tally) {
        if (documentId == null) return;
        Map<UUID, List<Named>> bindings = bindings(documentId);
        if (bindings.isEmpty()) return;
        List<Passage> passages = jdbc.query("SELECT c.id,c.content,c.page_start,c.page_end,ds.path FROM chunks c LEFT JOIN document_sections ds ON ds.id=c.section_id WHERE c.document_id=? ORDER BY c.ordinal",
                (rs, row) -> new Passage(rs.getObject("id", UUID.class), rs.getString("content"), rs.getObject("page_start", Integer.class), rs.getObject("page_end", Integer.class), rs.getString("path")), documentId);
        int stored = 0;
        boolean capped = false;
        for (Passage passage : passages) {
            List<Named> bound = bindings.getOrDefault(passage.id(), List.of());
            if (bound.isEmpty()) continue;
            for (ObjectiveExtractor.Objective objective : ObjectiveExtractor.extract(passage.content())) {
                if (stored >= MAX_PER_DOCUMENT) { capped = true; break; }
                for (UUID topicId : target(objective.statement(), bound))
                    if (insert(courseId, topicId, objective.statement(), objective.cognitiveLevel(), "MATERIAL", documentId, passage.id(), passage.path(), passage.pageStart(), passage.pageEnd())) { tally.material++; stored++; }
            }
            if (capped) break;
        }
        if (capped) log.warn("Document {} produced more than {} objective statements; the rest were not stored", documentId, MAX_PER_DOCUMENT);
    }

    /**
     * The objectives of generated lessons, which already carry a topic.
     *
     * <p>The lesson's declared {@code target_level} is the fallback level, not the first choice. The verb the
     * objective is written with is what a grader will actually be asked to judge against, and where the two
     * disagree the sentence is the more specific of the two.
     */
    private void curriculum(UUID courseId, Tally tally) {
        jdbc.query("SELECT topic_id,objective,target_level FROM curriculum_lessons WHERE course_id=? AND topic_id IS NOT NULL AND objective IS NOT NULL ORDER BY ordinal", rs -> {
            while (rs.next()) {
                String statement = ObjectiveExtractor.declared(rs.getString("objective"));
                if (statement == null) continue;
                Integer level = ObjectiveExtractor.level(statement);
                Integer declared = rs.getObject("target_level", Integer.class);
                if (insert(courseId, rs.getObject("topic_id", UUID.class), statement, level != null ? level : declared, "CURRICULUM", null, null, null, null, null)) tally.curriculum++;
            }
            return null;
        }, courseId);
    }

    /** Which of a passage's or unit's topics a statement belongs to: the one it names, or the strongest few. */
    private List<UUID> target(String statement, List<Named> candidates) {
        String normalized = TopicRegistry.normalize(statement);
        Set<UUID> named = new LinkedHashSet<>();
        for (Named candidate : candidates) if (!candidate.normalized().isBlank() && normalized.contains(candidate.normalized())) named.add(candidate.id());
        if (!named.isEmpty()) return List.copyOf(named);
        Set<UUID> fallback = new LinkedHashSet<>();
        for (Named candidate : candidates) { if (fallback.size() >= MAX_TOPICS_PER_STATEMENT) break; fallback.add(candidate.id()); }
        return List.copyOf(fallback);
    }

    /** A chunk's topics, strongest binding first, so the fallback attribution takes the best of them. */
    private Map<UUID, List<Named>> bindings(UUID documentId) {
        return jdbc.query("SELECT ct.chunk_id,ct.topic_id,t.normalized_name FROM chunk_topics ct JOIN chunks c ON c.id=ct.chunk_id JOIN topics t ON t.id=ct.topic_id WHERE c.document_id=? ORDER BY ct.relevance DESC,t.canonical_name", rs -> {
            Map<UUID, List<Named>> result = new LinkedHashMap<>();
            while (rs.next()) result.computeIfAbsent(rs.getObject("chunk_id", UUID.class), key -> new ArrayList<>()).add(new Named(rs.getObject("topic_id", UUID.class), rs.getString("normalized_name")));
            return result;
        }, documentId);
    }

    /**
     * Stores one objective, or does nothing when the workspace already holds that statement for that topic.
     *
     * @return whether a row was written, so the count reported is rows stored and not statements considered
     */
    private boolean insert(UUID courseId, UUID topicId, String statement, Integer level, String sourceKind, UUID documentId, UUID chunkId, String sectionPath, Integer pageStart, Integer pageEnd) {
        if (topicId == null || statement == null || statement.isBlank()) return false;
        String normalized = TopicRegistry.normalize(statement);
        if (normalized.isBlank()) return false;
        return jdbc.update("INSERT INTO topic_objectives(id,course_id,topic_id,statement,normalized_statement,cognitive_level,source_kind,document_id,source_chunk_id,section_path,page_start,page_end) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(course_id,topic_id,normalized_statement) DO NOTHING",
                UUID.randomUUID(), courseId, topicId, statement, normalized, level == null ? null : Math.max(1, Math.min(6, level)), sourceKind, documentId, chunkId, sectionPath, pageStart, pageEnd) > 0;
    }

    private List<String> strings(String json) {
        if (json == null || json.isBlank()) return List.of();
        try { return mapper.readValue(json, new TypeReference<List<String>>() {}).stream().filter(value -> value != null && !value.isBlank()).toList(); }
        catch (Exception error) { return List.of(); }
    }

    private record Unit(List<String> topics, List<String> objectives, Integer pageStart) {}
    private record Passage(UUID id, String content, Integer pageStart, Integer pageEnd, String path) {}
    private record Named(UUID id, String normalized) {}
    private static final class Tally {
        private int syllabus;
        private int material;
        private int curriculum;
        private int unresolved;
        private ObjectiveRebuild result() { return new ObjectiveRebuild(syllabus, material, curriculum, unresolved); }
    }
}
