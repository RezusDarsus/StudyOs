package com.studyos.research;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * Turns a learning goal into a bounded list of search queries.
 *
 * <p>A goal like "learn Kubernetes" searched as one string returns one page. What a course
 * actually needs is coverage across distinct kinds of material — foundations, definitions,
 * practical usage, common mistakes — so the planner expands the goal over a fixed set of
 * subject-neutral aspects and caps the result at the configured query budget. The aspects name
 * kinds of material, not subjects: the same expansion serves organic chemistry and contract law,
 * and nothing here knows what the goal is about.
 *
 * <p>The plan is deterministic: the same goal and budget always produce the same queries, so the
 * run is reproducible and testable without a model. Query suggestions are explicitly something a
 * model may propose in a later iteration, but the floor is this planner, and research runs with
 * the AI disabled still plan.
 */
@Component
public class ResearchQueryPlanner {
    /** The kinds of material a self-learning course needs coverage of, in teaching order. */
    private static final List<String> ASPECTS = List.of(
            "",                        // the goal itself, plain
            "foundations explained",
            "introduction overview",
            "core concepts",
            "prerequisites basics",
            "practical examples",
            "common mistakes",
            "best practices",
            "advanced topics",
            "step by step tutorial");

    /** Words that add nothing to a search and only widen it, stripped in a fixed order for determinism. */
    private static final List<String> GOAL_NOISE = List.of("i want to", "from scratch", "teach me", "learn", "study", "understand",
            "master", "become", "capable", "building", "build", "teach", "me", "i", "want", "course", "basics", "beginner");

    /** Produces at most {@code maxQueries} distinct, non-trivial queries for the goal. */
    public List<String> plan(String goal, int maxQueries) {
        String subject = subject(goal);
        if (subject.isBlank()) return List.of();
        List<String> queries = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (String aspect : ASPECTS) {
            if (queries.size() >= Math.max(1, maxQueries)) break;
            String query = (subject + " " + aspect).trim().replaceAll("\\s+", " ");
            if (query.length() > 200) query = query.substring(0, 200).trim();
            if (seen.add(query.toLowerCase(Locale.ROOT))) queries.add(query);
        }
        return List.copyOf(queries);
    }

    /**
     * The goal as a subject, with the verb-fighting stripped: "I want to learn Spring Boot from
     * scratch" and "Learn Spring Boot" should search the same web.
     */
    String subject(String goal) {
        if (goal == null) return "";
        String cleaned = goal.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}\\s-]+", " ").trim();
        for (String noise : GOAL_NOISE) cleaned = cleaned.replaceAll("(?i)\\b" + java.util.regex.Pattern.quote(noise) + "\\b", " ");
        cleaned = cleaned.replaceAll("\\s+", " ").trim();
        // Leftover connectors from the stripped phrases fold away at the edges.
        cleaned = cleaned.replaceAll("(?i)^(?:to|from)\\s+", "").replaceAll("(?i)\\s+(?:to|from)$", "").trim();
        return cleaned;
    }
}
