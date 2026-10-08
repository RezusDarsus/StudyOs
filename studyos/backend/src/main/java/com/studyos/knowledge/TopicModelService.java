package com.studyos.knowledge;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.assessment.HintLadder;
import com.studyos.retrieval.EmbeddingService;
import java.util.ArrayList;
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

/**
 * Measures every topic in a workspace and stores the result on the topic: how central it is, how much it demands,
 * and a vector for its identity.
 *
 * <p>All the arithmetic is {@link TopicModel}'s, which has no database. This class is the half that does the I/O:
 * it counts the workspace in a fixed number of grouped queries rather than one query per topic, hands the counts
 * over, and writes back what comes out — including {@code model_basis}, so a stored figure can be read back
 * against the evidence that produced it instead of being taken on faith.
 *
 * <p>What is not measured is stored as NULL. A course with no structured documents, no prerequisite edges, no past
 * exams and no attempts leaves both figures NULL for every topic, and that is the honest answer: nothing about
 * this workspace has been observed yet. Every consumer already treats a NULL importance as "unranked", which is
 * why {@code idx_topics_course_importance} sorts NULLs last.
 */
@Service
public class TopicModelService {
    private static final Logger log = LoggerFactory.getLogger(TopicModelService.class);
    /** Question sources whose difficulty is the course's own demand rather than StudyOS's. */
    private static final String AUTHORED_SOURCES = "('PAST_EXAM','HOMEWORK','QUIZ','ASSIGNMENT')";

    private final JdbcTemplate jdbc;
    private final EmbeddingService embeddings;
    private final ObjectMapper mapper;

    public TopicModelService(JdbcTemplate jdbc, EmbeddingService embeddings, ObjectMapper mapper) { this.jdbc = jdbc; this.embeddings = embeddings; this.mapper = mapper; }

    /**
     * What one rebuild measured, so a caller can tell "measured and low" from "not measured".
     *
     * @param examRelevanceMeasured whether the course has any assessment or lecture evidence for exam relevance to
     *     mean anything. With none, every topic's stored relevance is 0 by construction and is left out of
     *     importance rather than dragging every topic's figure down by a quarter
     * @param structureMeasured whether any document in the course has a derived outline
     * @param graphMeasured whether the course has any prerequisite edges
     */
    public record ModelRebuild(int topics, int importanceMeasured, int difficultyMeasured, int embedded,
                              boolean examRelevanceMeasured, boolean structureMeasured, boolean graphMeasured) {}

    /** Recomputes the model for every topic in the workspace. Idempotent: the same evidence gives the same figures. */
    public synchronized ModelRebuild rebuild(UUID courseId) {
        List<Topic> topics = jdbc.query("SELECT id,canonical_name,description,normalized_name FROM topics WHERE course_id=? ORDER BY canonical_name",
                (rs, row) -> new Topic(rs.getObject("id", UUID.class), rs.getString("canonical_name"), rs.getString("description"), rs.getString("normalized_name")), courseId);
        if (topics.isEmpty()) return new ModelRebuild(0, 0, 0, 0, false, false, false);

        Map<UUID, Counts> coverage = coverage(courseId);
        Map<UUID, Integer> headings = headings(courseId, topics);
        int structuredSections = count("SELECT COUNT(*) FROM document_sections ds JOIN documents d ON d.id=ds.document_id WHERE d.course_id=? AND ds.path IS NOT NULL", courseId);
        int documents = count("SELECT COUNT(*) FROM documents WHERE course_id=? AND status='COMPLETED'", courseId);
        double busiest = coverage.values().stream().mapToDouble(Counts::weight).max().orElse(0);
        TopicModel.Corpus corpus = new TopicModel.Corpus(documents, busiest, structuredSections);

        boolean examMeasured = count("SELECT COUNT(*) FROM documents WHERE course_id=? AND status='COMPLETED' AND document_type IN ('PAST_EXAM','LECTURE','SYLLABUS','HOMEWORK')", courseId) > 0
                || count("SELECT COUNT(*) FROM assessment_items WHERE course_id=? AND source_type IN " + AUTHORED_SOURCES, courseId) > 0;
        Map<UUID, Double> examRelevance = examMeasured ? relevance(courseId) : Map.of();
        Map<UUID, Counts> authored = authored(courseId);
        Map<UUID, Integer> depths = PrerequisiteDepth.of(topics.stream().map(Topic::id).toList(), edges(courseId));
        Map<UUID, List<TopicModel.Observation>> observations = observations(courseId);

        int importanceMeasured = 0;
        int difficultyMeasured = 0;
        for (Topic topic : topics) {
            Counts counted = coverage.getOrDefault(topic.id(), Counts.EMPTY);
            TopicModel.Coverage topicCoverage = new TopicModel.Coverage(counted.items(), counted.weight(), counted.documents(), headings.getOrDefault(topic.id(), 0));
            Counts items = authored.getOrDefault(topic.id(), Counts.EMPTY);
            TopicModel.Demand demand = new TopicModel.Demand(items.items() > 0 ? items.weight() / items.items() : null, items.items(), depths.get(topic.id()));
            List<TopicModel.Observation> attempts = observations.getOrDefault(topic.id(), List.of());
            TopicModel.Assessment assessment = TopicModel.assess(topicCoverage, corpus, examRelevance.get(topic.id()), demand, attempts);
            if (assessment.importance() != TopicModel.UNMEASURED) importanceMeasured++;
            if (assessment.difficulty() != TopicModel.UNMEASURED) difficultyMeasured++;
            jdbc.update("UPDATE topics SET importance=?,difficulty=?,difficulty_attempts=?,model_basis=CAST(? AS jsonb),model_updated_at=NOW() WHERE id=?",
                    figure(assessment.importance()), figure(assessment.difficulty()), assessment.observations(), basis(assessment), topic.id());
        }
        return new ModelRebuild(topics.size(), importanceMeasured, difficultyMeasured, embed(courseId, topics), examMeasured, structuredSections > 0, !depths.isEmpty());
    }

    /**
     * Gives every topic still without one a vector for its own identity — its name and what the course says it is.
     *
     * <p>Deliberately not the text of its passages. A topic's vector is what the topic <em>is</em>, and folding in
     * whichever passages happen to be bound to it today would make the same topic embed differently after an
     * unrelated upload. Passages already have their own vectors; this one exists so a topic can be compared with
     * another topic and with a learner's question.
     *
     * <p>Only missing vectors are computed, so a rebuild after the first costs no provider calls. A chat-only
     * provider leaves them NULL and the rest of the model is unaffected, exactly as chunk embedding already
     * degrades in ingestion.
     */
    private int embed(UUID courseId, List<Topic> topics) {
        Set<UUID> pending = new HashSet<>(jdbc.queryForList("SELECT id FROM topics WHERE course_id=? AND embedding IS NULL", UUID.class, courseId));
        List<Topic> missing = topics.stream().filter(topic -> pending.contains(topic.id())).toList();
        if (missing.isEmpty()) return 0;
        try {
            List<float[]> vectors = embeddings.embedBatch(courseId, null, missing.stream().map(Topic::text).toList());
            int written = 0;
            for (int index = 0; index < Math.min(missing.size(), vectors.size()); index++) {
                jdbc.update("UPDATE topics SET embedding=CAST(? AS vector),embedded_at=NOW() WHERE id=?", vectorLiteral(vectors.get(index)), missing.get(index).id());
                written++;
            }
            return written;
        } catch (RuntimeException error) {
            log.warn("Topic embedding unavailable for course {}; topic vectors remain unset: {}", courseId, error.getMessage());
            return 0;
        }
    }

    /** Passages bound to each topic, weighted by binding confidence, and how many documents they span. */
    private Map<UUID, Counts> coverage(UUID courseId) {
        return jdbc.query("SELECT ct.topic_id,COUNT(*) AS items,COALESCE(SUM(GREATEST(0,LEAST(1,ct.relevance))),0) AS weight,COUNT(DISTINCT c.document_id) AS documents FROM chunk_topics ct JOIN chunks c ON c.id=ct.chunk_id WHERE c.course_id=? GROUP BY ct.topic_id",
                rs -> { Map<UUID, Counts> result = new HashMap<>(); while (rs.next()) result.put(rs.getObject("topic_id", UUID.class), new Counts(rs.getInt("items"), rs.getDouble("weight"), rs.getInt("documents"))); return result; }, courseId);
    }

    /**
     * How many section titles name each topic, counted only over sections that have a derived outline.
     *
     * <p>Matched in Java on the same normalisation the topic registry stores names under, rather than with a SQL
     * {@code LIKE}: a title reading "2.3 Cyclic Codes" has to match the topic "cyclic codes", and the aliases the
     * registry keeps have to match too, or a topic stored under one spelling would score zero on a course that
     * writes it another way.
     */
    private Map<UUID, Integer> headings(UUID courseId, List<Topic> topics) {
        List<String> titles = jdbc.query("SELECT ds.title FROM document_sections ds JOIN documents d ON d.id=ds.document_id WHERE d.course_id=? AND ds.path IS NOT NULL AND ds.title IS NOT NULL",
                (rs, row) -> TopicRegistry.normalize(rs.getString(1)), courseId);
        if (titles.isEmpty()) return Map.of();
        Map<UUID, List<String>> names = new HashMap<>();
        for (Topic topic : topics) names.computeIfAbsent(topic.id(), key -> new ArrayList<>()).add(topic.normalized());
        jdbc.query("SELECT topic_id,normalized_alias FROM topic_aliases WHERE course_id=?",
                rs -> { while (rs.next()) { List<String> aliases = names.get(rs.getObject("topic_id", UUID.class)); if (aliases != null) aliases.add(rs.getString("normalized_alias")); } return null; }, courseId);
        Map<UUID, Integer> result = new HashMap<>();
        for (Map.Entry<UUID, List<String>> entry : names.entrySet()) {
            int matched = 0;
            for (String title : titles) if (title.length() > 1 && entry.getValue().stream().anyMatch(name -> !name.isBlank() && contains(title, name))) matched++;
            if (matched > 0) result.put(entry.getKey(), matched);
        }
        return result;
    }

    /** Whole-word containment, so "code" does not match a section titled "codeword decomposition". */
    private static boolean contains(String haystack, String needle) {
        int from = 0;
        while (true) {
            int at = haystack.indexOf(needle, from);
            if (at < 0) return false;
            boolean startsClean = at == 0 || haystack.charAt(at - 1) == ' ';
            int end = at + needle.length();
            boolean endsClean = end == haystack.length() || haystack.charAt(end) == ' ';
            if (startsClean && endsClean) return true;
            from = at + 1;
        }
    }

    /** Mean difficulty and count of the questions the course's own documents set on each topic. */
    private Map<UUID, Counts> authored(UUID courseId) {
        return jdbc.query("SELECT ait.topic_id,COUNT(*) AS items,COALESCE(SUM(GREATEST(0,LEAST(1,ai.difficulty))),0) AS weight FROM assessment_item_topics ait JOIN assessment_items ai ON ai.id=ait.item_id WHERE ai.course_id=? AND ai.document_id IS NOT NULL AND ai.difficulty IS NOT NULL AND ai.source_type IN " + AUTHORED_SOURCES + " GROUP BY ait.topic_id",
                rs -> { Map<UUID, Counts> result = new HashMap<>(); while (rs.next()) result.put(rs.getObject("topic_id", UUID.class), new Counts(rs.getInt("items"), rs.getDouble("weight"), 0)); return result; }, courseId);
    }

    /**
     * The course's learning order, read from {@code topic_prerequisites} so BUILDS_ON counts too.
     *
     * <p>The view is where the direction rule lives: it presents PREREQUISITE_OF as stored and BUILDS_ON with its
     * endpoints swapped, because "A builds on B" puts B first. Reading {@code topic_edges} directly here would
     * measure depth over a subset of the graph that orders learning, and understate every topic that rests on an
     * extension chain.
     */
    private List<PrerequisiteDepth.Edge> edges(UUID courseId) {
        return jdbc.query("SELECT prerequisite_topic_id,dependent_topic_id FROM topic_prerequisites WHERE course_id=?",
                (rs, row) -> new PrerequisiteDepth.Edge(rs.getObject("prerequisite_topic_id", UUID.class), rs.getObject("dependent_topic_id", UUID.class)), courseId);
    }

    private Map<UUID, Double> relevance(UUID courseId) {
        return jdbc.query("SELECT topic_id,relevance FROM exam_topic_signals WHERE course_id=?",
                rs -> { Map<UUID, Double> result = new HashMap<>(); while (rs.next()) result.put(rs.getObject("topic_id", UUID.class), rs.getDouble("relevance")); return result; }, courseId);
    }

    /**
     * Graded attempts per topic. {@link HintLadder#RUNGS} is the denominator for how much support was leaned on,
     * because it is the same ladder every exercise releases hints from — reading it off the item would let an item
     * with fewer authored hints report more assistance per hint used.
     */
    private Map<UUID, List<TopicModel.Observation>> observations(UUID courseId) {
        return jdbc.query("SELECT topic_id,score,COALESCE(support_level_used,0) AS support FROM assessment_attempts WHERE course_id=? AND topic_id IS NOT NULL ORDER BY created_at",
                rs -> { Map<UUID, List<TopicModel.Observation>> result = new HashMap<>(); while (rs.next()) result.computeIfAbsent(rs.getObject("topic_id", UUID.class), key -> new ArrayList<>()).add(new TopicModel.Observation(rs.getDouble("score"), rs.getInt("support"), HintLadder.RUNGS)); return result; }, courseId);
    }

    /** The counted inputs behind the two figures, stored beside them so a number can be argued with. */
    private String basis(TopicModel.Assessment assessment) {
        Map<String, Object> value = new LinkedHashMap<>();
        Map<String, Object> importance = new LinkedHashMap<>();
        importance.put("boundChunks", assessment.coverage().chunks());
        importance.put("bindingWeight", round(assessment.coverage().bindingWeight()));
        importance.put("busiestBindingWeight", round(assessment.corpus().busiestBindingWeight()));
        importance.put("documents", assessment.coverage().documents() + "/" + assessment.corpus().documents());
        importance.put("namedBySections", assessment.corpus().structuredSections() > 0 ? assessment.coverage().headingSections() : null);
        importance.put("examRelevance", assessment.examRelevance() == null ? null : round(assessment.examRelevance()));
        Map<String, Object> difficulty = new LinkedHashMap<>();
        difficulty.put("authoredDifficulty", assessment.demand() == null || assessment.demand().authoredDifficulty() == null ? null : round(assessment.demand().authoredDifficulty()));
        difficulty.put("authoredItems", assessment.demand() == null ? 0 : assessment.demand().authoredItems());
        difficulty.put("prerequisiteDepth", assessment.demand() == null ? null : assessment.demand().prerequisiteDepth());
        difficulty.put("observed", assessment.observed() == TopicModel.UNMEASURED ? null : round(assessment.observed()));
        difficulty.put("attempts", assessment.observations());
        difficulty.put("meanScore", assessment.meanScore() == TopicModel.UNMEASURED ? null : round(assessment.meanScore()));
        difficulty.put("assistanceShare", assessment.assistanceShare() == TopicModel.UNMEASURED ? null : round(assessment.assistanceShare()));
        value.put("importance", importance);
        value.put("difficulty", difficulty);
        try { return mapper.writeValueAsString(value); } catch (JsonProcessingException error) { return "{}"; }
    }

    private static Double figure(double value) { return value == TopicModel.UNMEASURED ? null : value; }
    private static double round(double value) { return Math.round(value * 1000) / 1000.0; }
    private int count(String sql, UUID courseId) { Integer value = jdbc.queryForObject(sql, Integer.class, courseId); return value == null ? 0 : value; }
    private String vectorLiteral(float[] vector) { StringBuilder result = new StringBuilder("["); for (int index = 0; index < vector.length; index++) { if (index > 0) result.append(','); result.append(vector[index]); } return result.append(']').toString(); }

    private record Topic(UUID id, String name, String description, String normalized) {
        String text() { return description == null || description.isBlank() ? name : name + ". " + description; }
    }
    /** A grouped count and its weight: passages and binding confidence, or questions and their difficulty. */
    private record Counts(int items, double weight, int documents) { static final Counts EMPTY = new Counts(0, 0, 0); }
}
