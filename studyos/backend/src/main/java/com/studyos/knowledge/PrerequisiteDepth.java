package com.studyos.knowledge;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * How deep into a course's prerequisite chain each topic sits: the longest run of prerequisites that has to be
 * understood before it. A root is 0, something resting on one root is 1, and so on.
 *
 * <p>Longest rather than shortest, because the shortest path understates what a topic demands. If a topic can be
 * reached both directly from a root and through four intervening ideas, a learner still has to hold all five, and
 * the shortest path would call it as shallow as the root's immediate neighbour.
 *
 * <p>Cycles are expected, not guarded against as an anomaly. The prerequisite edges come from extraction over
 * course text, and text says "A needs B" and "B needs A" often enough — in genuinely mutually-defined pairs as
 * much as in extraction mistakes — that a depth walk which assumed a DAG would loop forever on real courses. A
 * cycle is broken where it closes: the walk does not re-enter a topic already on the path it is measuring, so the
 * chain is counted once round and no further.
 */
public final class PrerequisiteDepth {
    private PrerequisiteDepth() {}

    /**
     * A course's prerequisite ordering, in the direction the graph stores it.
     *
     * @param prerequisite what has to come first
     * @param dependent what rests on it
     */
    public record Edge(UUID prerequisite, UUID dependent) {}

    /**
     * Depth per topic, or an empty map when the course has no prerequisite edges at all.
     *
     * <p>Empty rather than zero-for-everything, and the distinction is the whole reason this returns a map instead
     * of filling in a default. A course whose graph has never been built has no measured depth for any topic, and
     * a caller that read that as "every topic is a root" would report a flat course to a learner on the strength of
     * a missing computation. With edges present, a topic absent from all of them really is a root, and gets 0.
     */
    public static Map<UUID, Integer> of(Collection<UUID> topics, Collection<Edge> edges) {
        List<Edge> usable = edges == null ? List.of() : edges.stream().filter(edge -> edge != null && edge.prerequisite() != null && edge.dependent() != null && !edge.prerequisite().equals(edge.dependent())).toList();
        if (usable.isEmpty()) return Map.of();
        Map<UUID, List<UUID>> prerequisites = new HashMap<>();
        for (Edge edge : usable) prerequisites.computeIfAbsent(edge.dependent(), key -> new ArrayList<>()).add(edge.prerequisite());
        Set<UUID> wanted = new HashSet<>();
        if (topics != null) for (UUID topic : topics) if (topic != null) wanted.add(topic);
        for (Edge edge : usable) { wanted.add(edge.prerequisite()); wanted.add(edge.dependent()); }
        Map<UUID, Integer> depths = new HashMap<>();
        for (UUID topic : wanted) depths.put(topic, depth(topic, prerequisites, depths, new ArrayDeque<>()));
        return Map.copyOf(depths);
    }

    /**
     * Depth of one topic, memoised across the whole course because a shared prerequisite is otherwise re-walked
     * once per topic that rests on it.
     *
     * <p>The memo is only written for topics measured on a clean path. A topic reached while its own cycle is open
     * gets a depth that depends on where the walk started, so caching it would let the first topic queried decide
     * the answer for the rest.
     */
    private static int depth(UUID topic, Map<UUID, List<UUID>> prerequisites, Map<UUID, Integer> depths, Deque<UUID> path) {
        Integer known = depths.get(topic);
        if (known != null) return known;
        if (path.contains(topic)) return 0;
        List<UUID> parents = prerequisites.getOrDefault(topic, List.of());
        if (parents.isEmpty()) { depths.put(topic, 0); return 0; }
        path.push(topic);
        int deepest = 0;
        for (UUID parent : parents) deepest = Math.max(deepest, 1 + depth(parent, prerequisites, depths, path));
        path.pop();
        if (path.isEmpty()) depths.put(topic, deepest);
        return deepest;
    }
}
