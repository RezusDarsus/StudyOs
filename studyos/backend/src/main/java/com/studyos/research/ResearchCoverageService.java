package com.studyos.research;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Computes what the research actually covers, per topic, from stored evidence: how many
 * independent documents support each topic, how good they ranked, how deep the bound material is,
 * and which important topics remain thinly supported. Feeds the research goal decomposer's gap
 * awareness and gives the learner an honest answer to "what does my research actually cover?".
 */
@Service
public class ResearchCoverageService {
    private final JdbcTemplate jdbc;
    private final ResearchProperties properties;

    public ResearchCoverageService(JdbcTemplate jdbc, ResearchProperties properties) {
        this.jdbc = jdbc;
        this.properties = properties;
    }

    public record TopicSupport(UUID topicId, String topic, double importance, long independentSources,
                               long distinctDomains, double meanQuality, long depthChunks, long objectives,
                               long supportedObjectives, double support, ResearchCoverageCore.Level level,
                               boolean researchGap) {}

    public record Coverage(int maxEnrichmentPasses, int completedPasses, boolean enrichmentAllowed,
                           List<TopicSupport> topics, List<TopicSupport> gaps) {}

    public Coverage coverage(UUID courseId) {
        List<TopicSupport> topics = topicSupport(courseId);
        List<TopicSupport> gaps = new ArrayList<>();
        for (TopicSupport topic : topics) if (topic.researchGap()) gaps.add(topic);
        return new Coverage(properties.maxEnrichmentPasses(), completedPasses(courseId), enrichmentAllowed(courseId), topics, gaps);
    }

    /**
     * Per-topic aggregation in a fixed number of grouped queries — one per evidence kind — never
     * one query per topic. Importance prefers the measured topic model and falls back to exam
     * relevance; a topic with neither is unranked rather than assumed important.
     */
    public List<TopicSupport> topicSupport(UUID courseId) {
        record TopicRow(UUID id, String name, Double importance, Double examRelevance) {}
        List<TopicRow> topics = jdbc.query("""
                SELECT t.id, t.canonical_name, t.importance, es.relevance
                FROM topics t
                LEFT JOIN exam_topic_signals es ON es.topic_id=t.id AND es.course_id=t.course_id
                WHERE t.course_id=? AND t.canonical_topic_id IS NULL
                """, (rs, row) -> new TopicRow(rs.getObject("id", UUID.class), rs.getString("canonical_name"),
                rs.getObject("importance", Double.class), rs.getObject("relevance", Double.class)), courseId);
        if (topics.isEmpty()) return List.of();

        Map<UUID, long[]> binding = new HashMap<>();     // distinct documents, distinct domains, chunks
        Map<UUID, double[]> quality = new HashMap<>();   // sum of source quality, count of sourced docs
        jdbc.query("""
                SELECT ct.topic_id, COUNT(DISTINCT c.document_id) AS documents,
                       COUNT(DISTINCT COALESCE(rs.domain, d.document_type || ':' || d.id)) AS domains,
                       COUNT(DISTINCT ct.chunk_id) AS chunks,
                       COALESCE(AVG(rs.quality_score), 0) AS mean_quality
                FROM chunk_topics ct
                JOIN chunks c ON c.id=ct.chunk_id
                JOIN documents d ON d.id=c.document_id
                LEFT JOIN research_sources rs ON rs.document_id=d.id
                WHERE c.course_id=?
                GROUP BY ct.topic_id
                """, rs -> {
            while (rs.next()) {
                UUID topicId = rs.getObject("topic_id", UUID.class);
                binding.put(topicId, new long[]{rs.getLong("documents"), rs.getLong("domains"), rs.getLong("chunks")});
                quality.put(topicId, new double[]{rs.getDouble("mean_quality"), rs.getLong("documents")});
            }
            return null;
        }, courseId);

        Map<UUID, long[]> objectives = new HashMap<>();
        jdbc.query("""
                SELECT o.topic_id, COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE o.source_chunk_id IS NOT NULL OR o.document_id IS NOT NULL) AS supported
                FROM topic_objectives o WHERE o.course_id=? GROUP BY o.topic_id
                """, rs -> {
            while (rs.next()) objectives.put(rs.getObject("topic_id", UUID.class), new long[]{rs.getLong("total"), rs.getLong("supported")});
            return null;
        }, courseId);

        List<TopicSupport> result = new ArrayList<>();
        for (TopicRow topic : topics) {
            long[] counts = binding.getOrDefault(topic.id(), new long[]{0, 0, 0});
            double meanQuality = counts[0] == 0 ? 0 : quality.getOrDefault(topic.id(), new double[]{0, 0})[0];
            long[] objectiveCounts = objectives.getOrDefault(topic.id(), new long[]{0, 0});
            double objectiveCoverage = objectiveCounts[0] == 0 ? 0.5 : (double) objectiveCounts[1] / objectiveCounts[0];
            // Unmeasured objectives must not drag support down: neutral 0.5 keeps the score about sources.
            double importance = topic.importance() != null ? topic.importance()
                    : topic.examRelevance() != null ? topic.examRelevance() : 0;
            double support = ResearchCoverageCore.support(counts[0], meanQuality, counts[2], objectiveCoverage);
            result.add(new TopicSupport(topic.id(), topic.name(), importance, counts[0], counts[1], meanQuality, counts[2],
                    objectiveCounts[0], objectiveCounts[1], support, ResearchCoverageCore.level(support),
                    ResearchCoverageCore.isResearchGap(importance, support)));
        }
        result.sort((left, right) -> Double.compare(right.support(), left.support()));
        return result;
    }

    /** Completed research runs so far — the enrichment passes this course has already spent. */
    public int completedPasses(UUID courseId) {
        Integer passes = jdbc.queryForObject("SELECT COUNT(*) FROM research_runs WHERE course_id=? AND status='COMPLETED'", Integer.class, courseId);
        return passes == null ? 0 : passes;
    }

    /**
     * Whether another enrichment pass may run: the loop stops after the configured number of
     * completed passes, so a gap can never generate research forever.
     */
    public boolean enrichmentAllowed(UUID courseId) {
        return completedPasses(courseId) < properties.maxEnrichmentPasses();
    }
}
