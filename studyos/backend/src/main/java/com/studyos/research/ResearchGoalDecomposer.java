package com.studyos.research;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.studyos.ai.AiGateway;
import com.studyos.ai.AiOperation;
import com.studyos.ai.AiResult;
import com.studyos.ai.AiUsageService;
import com.studyos.ai.GenerationPolicyRegistry;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Decomposes a research goal into the specific knowledge it requires before any web search runs.
 *
 * <p>"Learn Spring Boot" should not just produce aspect templates — it should identify dependency
 * injection, configuration, REST controllers, validation, persistence, security, testing and the
 * rest, and then spend the bounded query budget on the parts the workspace's own material does not
 * already cover. The LLM is asked for structured needs; everything it returns is validated here
 * (duplicates, caps, lengths, URLs, unsafe strings) and merged with a deterministic fallback so the
 * pipeline always has a plan, AI or no AI.
 */
@Service
public class ResearchGoalDecomposer {
    private static final Logger log = LoggerFactory.getLogger(ResearchGoalDecomposer.class);
    static final int MAX_NEEDS = 12;
    static final int MAX_QUERIES_PER_NEED = 3;
    static final int MAX_QUERIES_TOTAL = 16;

    private final AiGateway ai;
    private final GenerationPolicyRegistry policies;
    private final AiUsageService usage;
    private final JdbcTemplate jdbc;
    private final ResearchQueryPlanner planner;

    public ResearchGoalDecomposer(AiGateway ai, GenerationPolicyRegistry policies, AiUsageService usage, JdbcTemplate jdbc, ResearchQueryPlanner planner) {
        this.ai = ai;
        this.policies = policies;
        this.usage = usage;
        this.jdbc = jdbc;
        this.planner = planner;
    }

    /** One knowledge need the goal implies, with the bounded queries that could satisfy it. */
    public record ResearchNeed(String name, double importance, String reason, List<String> researchQueries) {}

    /** What the workspace's own material already covers, so research targets gaps instead of repeating. */
    public record TopicCoverage(String topic, long sourceCount) {}

    public record Decomposition(List<ResearchNeed> needs, boolean llmUsed, List<String> issues) {}

    /**
     * Full decomposition for a course: existing topic coverage is read here, then the pure
     * decomposition runs. Never throws — a failed LLM call degrades to the deterministic plan.
     */
    public Decomposition decompose(UUID courseId, String goal) {
        List<TopicCoverage> coverage = existingCoverage(courseId);
        List<ResearchNeed> deterministic = deterministicNeeds(planner, goal);
        List<ResearchNeed> llmNeeds = llmNeeds(goal, coverage);
        return merge(goal, deterministic, llmNeeds, coverage);
    }

    /** Existing material awareness: what the workspace's documents already bind to topics. */
    public List<TopicCoverage> existingCoverage(UUID courseId) {
        if (courseId == null) return List.of();
        return jdbc.query("""
                SELECT t.canonical_name, COUNT(DISTINCT c.document_id) AS source_count
                FROM topics t LEFT JOIN chunk_topics ct ON ct.topic_id=t.id
                LEFT JOIN chunks c ON c.id=ct.chunk_id
                WHERE t.course_id=? GROUP BY t.id,t.canonical_name ORDER BY COUNT(DISTINCT c.document_id) DESC, t.canonical_name LIMIT 120
                """, (rs, row) -> new TopicCoverage(rs.getString(1), rs.getLong(2)), courseId);
    }

    /** The always-available deterministic decomposition: the goal plus the subject-neutral aspects. */
    public static List<ResearchNeed> deterministicNeeds(ResearchQueryPlanner planner, String goal) {
        if (goal == null || goal.isBlank()) return List.of();
        String subject = planner.subject(goal);
        if (subject.isBlank()) return List.of();
        List<String> queries = new ArrayList<>();
        queries.add(subject);
        for (String aspect : List.of("official documentation", "foundations explained", "practical examples", "common mistakes")) {
            String query = (subject + " " + aspect).trim();
            if (query.length() <= 160) queries.add(query);
        }
        return List.of(new ResearchNeed(subject, 0.8, "The stated goal itself", List.copyOf(queries)));
    }

    private List<ResearchNeed> llmNeeds(String goal, List<TopicCoverage> coverage) {
        StringBuilder prompt = new StringBuilder("A learner states a research goal. Break it into the specific knowledge areas the goal requires, so research can target each one.\n")
                .append("GOAL: ").append(goal).append("\n");
        if (!coverage.isEmpty()) {
            prompt.append("Material the learner already has (topic: sources). Prefer researching what is NOT covered or only thinly covered:\n");
            for (TopicCoverage topic : coverage.stream().limit(40).toList()) {
                prompt.append("- ").append(topic.topic()).append(": ").append(topic.sourceCount()).append(" source(s)\n");
            }
        }
        prompt.append("\nReturn JSON only: {\"needs\":[{\"name\":\"specific knowledge area\",\"importance\":0.0-1.0,\"reason\":\"why this matters for the goal\",\"researchQueries\":[\"search query 1\",\"search query 2\"]}]}")
                .append("\nAt most ").append(MAX_NEEDS).append(" needs, at most ").append(MAX_QUERIES_PER_NEED).append(" queries per need. Queries are plain search strings, never URLs.");
        long started = System.nanoTime();
        AiResult<LlmNeeds> result = null;
        boolean success = false;
        try {
            result = ai.generateStructuredResult("You decompose learning goals into concrete knowledge areas with web-search queries. Return only valid JSON.",
                    prompt.toString(), LlmNeeds.class, policies.policy(AiOperation.RESEARCH_PLANNING));
            success = true;
            List<ResearchNeed> needs = new ArrayList<>();
            if (result.value() != null) {
                for (LlmNeed need : result.value().needs()) {
                    if (need == null || need.name() == null || need.name().isBlank()) continue;
                    needs.add(new ResearchNeed(need.name().trim(), need.importance() == null ? 0.5 : need.importance(), need.reason() == null ? "" : need.reason(), need.researchQueries() == null ? List.of() : need.researchQueries()));
                }
            }
            return needs;
        } catch (RuntimeException error) {
            log.info("LLM goal decomposition unavailable, using deterministic plan: {}", error.getMessage());
            return List.of();
        } finally {
            usage.record(AiOperation.RESEARCH_PLANNING, result, null, null, null, (System.nanoTime() - started) / 1_000_000, success);
        }
    }

    /**
     * Validates, dedupes and gap-prioritizes the candidate needs. Pure so it is directly testable:
     * duplicates collapse, URLs and unsafe query strings are rejected, caps hold, and needs the
     * existing material already covers rank below genuine gaps.
     */
    public static Decomposition merge(String goal, List<ResearchNeed> deterministic, List<ResearchNeed> llmNeeds, List<TopicCoverage> coverage) {
        List<String> issues = new ArrayList<>();
        LinkedHashMap<String, ResearchNeed> unique = new LinkedHashMap<>();
        Set<String> seenQueries = new LinkedHashSet<>();
        for (ResearchNeed need : llmNeeds) {
            String key = fold(need.name());
            if (key.isBlank() || key.length() < 3 || key.length() > 80) { issues.add("Need name rejected: " + trim(need.name(), 40)); continue; }
            if (unique.containsKey(key)) { issues.add("Duplicate need dropped: " + need.name()); continue; }
            List<String> queries = new ArrayList<>();
            for (String query : need.researchQueries()) {
                String verdict = queryVerdict(query, seenQueries);
                if (verdict == null) { queries.add(query.trim()); seenQueries.add(fold(query)); }
                else issues.add("Query rejected for '" + need.name() + "': " + verdict);
                if (queries.size() >= MAX_QUERIES_PER_NEED) break;
            }
            double importance = clamp(need.importance());
            unique.put(key, new ResearchNeed(need.name().trim(), importance, trim(need.reason(), 240), List.copyOf(queries)));
            if (unique.size() >= MAX_NEEDS) { issues.add("Need cap reached"); break; }
        }
        // The deterministic need always survives as the backbone, unless the LLM already covers the subject.
        if (deterministic != null && !deterministic.isEmpty()) {
            ResearchNeed base = deterministic.get(0);
            String baseKey = fold(base.name());
            ResearchNeed merged = unique.get(baseKey);
            if (merged == null) {
                List<String> queries = new ArrayList<>();
                for (String query : base.researchQueries()) {
                    if (queries.size() >= MAX_QUERIES_PER_NEED) break;
                    if (seenQueries.contains(fold(query))) continue;
                    if (queryVerdict(query, seenQueries) == null) { queries.add(query.trim()); seenQueries.add(fold(query)); }
                }
                unique.put(baseKey, new ResearchNeed(base.name(), base.importance(), base.reason(), queries));
            }
        }
        List<ResearchNeed> ordered = gapPrioritize(new ArrayList<>(unique.values()), coverage);
        int totalQueries = 0;
        List<ResearchNeed> capped = new ArrayList<>();
        for (ResearchNeed need : ordered) {
            List<String> queries = new ArrayList<>();
            for (String query : need.researchQueries()) {
                if (totalQueries >= MAX_QUERIES_TOTAL) break;
                queries.add(query);
                totalQueries++;
            }
            capped.add(new ResearchNeed(need.name(), need.importance(), need.reason(), queries));
        }
        boolean llmUsed = !llmNeeds.isEmpty();
        return new Decomposition(List.copyOf(capped), llmUsed, issues);
    }

    /**
     * Gap-aware ordering: a need whose name matches an already well-covered topic drops in priority;
     * uncovered needs rise. Well-covered means the workspace already binds the topic to real sources.
     */
    static List<ResearchNeed> gapPrioritize(List<ResearchNeed> needs, List<TopicCoverage> coverage) {
        if (coverage == null || coverage.isEmpty()) return sortByImportance(needs);
        Map<String, Long> covered = new LinkedHashMap<>();
        for (TopicCoverage topic : coverage) covered.put(fold(topic.topic()), topic.sourceCount());
        record Scored(ResearchNeed need, double score) {}
        List<Scored> scored = new ArrayList<>();
        for (ResearchNeed need : needs) {
            long sources = 0;
            for (Map.Entry<String, Long> entry : covered.entrySet()) {
                String key = fold(need.name());
                if (key.equals(entry.getKey()) || (key.length() > 5 && (key.contains(entry.getKey()) || entry.getKey().contains(key)))) {
                    sources = Math.max(sources, entry.getValue());
                }
            }
            // Existing material reduces urgency but never to zero: refreshed material is still useful.
            double gapFactor = sources == 0 ? 1.0 : sources >= 3 ? 0.4 : 0.7;
            scored.add(new Scored(need, clamp(need.importance()) * gapFactor));
        }
        return scored.stream().sorted(Comparator.comparingDouble((Scored item) -> item.score()).reversed()).map(Scored::need).toList();
    }

    private static List<ResearchNeed> sortByImportance(List<ResearchNeed> needs) {
        return needs.stream().sorted(Comparator.comparingDouble((ResearchNeed need) -> clamp(need.importance())).reversed()).toList();
    }

    /** null means the query is acceptable; otherwise the reason it was rejected. */
    static String queryVerdict(String query, Set<String> seenQueries) {
        if (query == null) return "null query";
        String trimmed = query.trim();
        if (trimmed.length() < 8 || trimmed.length() > 160) return "length out of bounds";
        String lowered = trimmed.toLowerCase(Locale.ROOT);
        if (lowered.matches(".*\\b(https?://|www\\.)\\b.*") || lowered.contains("http://") || lowered.contains("https://") || lowered.contains("www.")) return "must not be a URL";
        if (lowered.contains("file:") || lowered.contains("ftp:")) return "must not be a non-web scheme";
        if (fold(trimmed).isEmpty()) return "no usable characters";
        if (seenQueries.contains(fold(trimmed))) return "duplicate";
        return null;
    }

    private static double clamp(double value) {
        if (Double.isNaN(value)) return 0.5;
        return Math.max(0, Math.min(1, value));
    }

    private static String fold(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{Nd}]+", " ").trim();
    }

    private static String trim(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, max);
    }

    public record LlmNeeds(List<LlmNeed> needs) {
        @JsonCreator public LlmNeeds(@JsonProperty("needs") List<LlmNeed> needs) { this.needs = needs == null ? List.of() : needs; }
    }

    public record LlmNeed(String name, Double importance, String reason, List<String> researchQueries) {
        @JsonCreator public LlmNeed(@JsonProperty("name") String name, @JsonProperty("importance") Double importance,
                                    @JsonProperty("reason") String reason, @JsonProperty("researchQueries") List<String> researchQueries) {
            this.name = name; this.importance = importance; this.reason = reason; this.researchQueries = researchQueries;
        }
    }
}
