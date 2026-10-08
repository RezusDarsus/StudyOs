package com.studyos.curriculum;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * The prerequisite structure of one curriculum, with no database or AI in sight. A lesson is only
 * unlocked once the lessons it rests on are actually understood, which is what stops StudyOS from
 * seriously teaching a topic on top of a gap. Cycles never hang or throw: a lesson inside one is
 * reported as blocked rather than silently treated as ready.
 */
public final class CurriculumGraph {
    /** Below this effective mastery a prerequisite counts as missing. Mirrors the planner default. */
    public static final double DEFAULT_MASTERY_BAR = .6;

    private final Map<UUID, Lesson> lessons;
    private final Map<UUID, Set<UUID>> prerequisites;
    private final double masteryBar;
    private final List<UUID> order;

    private CurriculumGraph(Map<UUID, Lesson> lessons, Map<UUID, Set<UUID>> prerequisites, double masteryBar) {
        this.lessons = lessons;
        this.prerequisites = prerequisites;
        this.masteryBar = masteryBar;
        this.order = topologicalOrder(lessons, prerequisites);
    }

    public static CurriculumGraph of(List<Lesson> lessons, List<Edge> edges) { return of(lessons, edges, DEFAULT_MASTERY_BAR); }

    public static CurriculumGraph of(List<Lesson> lessons, List<Edge> edges, double masteryBar) {
        Map<UUID, Lesson> byId = new LinkedHashMap<>();
        for (Lesson lesson : lessons == null ? List.<Lesson>of() : lessons) if (lesson != null && lesson.id() != null) byId.putIfAbsent(lesson.id(), lesson);
        Map<UUID, Set<UUID>> required = new LinkedHashMap<>();
        for (UUID id : byId.keySet()) required.put(id, new LinkedHashSet<>());
        for (Edge edge : edges == null ? List.<Edge>of() : edges) {
            if (edge == null || edge.lessonId() == null || edge.prerequisiteLessonId() == null) continue;
            if (edge.lessonId().equals(edge.prerequisiteLessonId())) continue;
            if (!byId.containsKey(edge.lessonId()) || !byId.containsKey(edge.prerequisiteLessonId())) continue;
            required.get(edge.lessonId()).add(edge.prerequisiteLessonId());
        }
        return new CurriculumGraph(Map.copyOf(byId), Map.copyOf(required), Math.max(0, Math.min(1, masteryBar)));
    }

    public List<Lesson> lessons() { return order.stream().map(lessons::get).toList(); }
    public int size() { return lessons.size(); }
    public Lesson lesson(UUID lessonId) { return lessons.get(lessonId); }

    /** Teaching order: every lesson after the lessons it depends on. Ties keep the authored order. */
    public List<UUID> teachingOrder() { return order; }

    /** The lessons this one directly rests on. */
    public Set<UUID> directPrerequisites(UUID lessonId) { return prerequisites.getOrDefault(lessonId, Set.of()); }

    /**
     * Everything this lesson rests on, transitively. Safe on cyclic input: the {@code seen} set
     * bounds the walk. A lesson caught in a cycle does transitively rest on itself, so it appears in
     * its own closure — that is the signal {@link #isUnlocked(UUID)} uses to refuse to teach it.
     */
    public Set<UUID> prerequisiteClosure(UUID lessonId) {
        Set<UUID> seen = new LinkedHashSet<>();
        Deque<UUID> pending = new ArrayDeque<>(directPrerequisites(lessonId));
        while (!pending.isEmpty()) {
            UUID next = pending.poll();
            if (!seen.add(next)) continue;
            pending.addAll(directPrerequisites(next));
        }
        return Set.copyOf(seen);
    }

    /** Direct prerequisites that are not understood well enough to build on yet. */
    public List<Lesson> blockers(UUID lessonId) {
        return directPrerequisites(lessonId).stream().map(lessons::get)
                .filter(lesson -> lesson != null && lesson.effectiveMastery() < masteryBar)
                .sorted(Comparator.comparingDouble(Lesson::effectiveMastery)).toList();
    }

    /** True when nothing this lesson depends on is still weak — and when it is not inside a cycle. */
    public boolean isUnlocked(UUID lessonId) {
        if (!lessons.containsKey(lessonId)) return false;
        if (prerequisiteClosure(lessonId).contains(lessonId)) return false;
        return blockers(lessonId).isEmpty();
    }

    /** True once the lesson itself clears the bar. */
    public boolean isMastered(UUID lessonId) {
        Lesson lesson = lessons.get(lessonId);
        return lesson != null && lesson.effectiveMastery() >= masteryBar;
    }

    /** Unlocked lessons that still need work, in teaching order. This is what to study next. */
    public List<Lesson> frontier() {
        return order.stream().map(lessons::get).filter(lesson -> isUnlocked(lesson.id()) && !isMastered(lesson.id())).toList();
    }

    /** The single next lesson: the frontier's head, or the weakest blocker when everything is blocked. */
    public Lesson next() {
        List<Lesson> frontier = frontier();
        if (!frontier.isEmpty()) return frontier.getFirst();
        return order.stream().map(lessons::get).filter(lesson -> !isMastered(lesson.id()))
                .min(Comparator.comparingDouble(Lesson::effectiveMastery)).orElse(null);
    }

    /** Share of the curriculum that is understood, weighted by the minutes each lesson is worth. */
    public double coverage() {
        double total = 0;
        double earned = 0;
        for (Lesson lesson : lessons.values()) {
            double weight = Math.max(1, lesson.estimatedMinutes());
            total += weight;
            earned += weight * Math.max(0, Math.min(1, lesson.effectiveMastery()));
        }
        return total == 0 ? 0 : earned / total;
    }

    /** Lessons whose own prerequisites are fine but which are themselves holding others back. */
    public List<Lesson> criticalGaps() {
        Map<UUID, Integer> dependents = new LinkedHashMap<>();
        for (UUID lessonId : lessons.keySet()) for (UUID required : prerequisiteClosure(lessonId)) if (!required.equals(lessonId)) dependents.merge(required, 1, Integer::sum);
        return lessons.values().stream()
                .filter(lesson -> lesson.effectiveMastery() < masteryBar && dependents.getOrDefault(lesson.id(), 0) > 0)
                .sorted(Comparator.<Lesson>comparingInt(lesson -> -dependents.getOrDefault(lesson.id(), 0))
                        .thenComparingDouble(Lesson::effectiveMastery))
                .toList();
    }

    private static List<UUID> topologicalOrder(Map<UUID, Lesson> lessons, Map<UUID, Set<UUID>> prerequisites) {
        List<UUID> authored = lessons.values().stream()
                .sorted(Comparator.comparingInt(Lesson::moduleOrdinal).thenComparingInt(Lesson::ordinal))
                .map(Lesson::id).toList();
        Map<UUID, Integer> remaining = new LinkedHashMap<>();
        Map<UUID, List<UUID>> unlocks = new LinkedHashMap<>();
        for (UUID id : authored) { remaining.put(id, prerequisites.getOrDefault(id, Set.of()).size()); unlocks.put(id, new ArrayList<>()); }
        for (UUID id : authored) for (UUID required : prerequisites.getOrDefault(id, Set.of())) unlocks.get(required).add(id);
        List<UUID> result = new ArrayList<>();
        List<UUID> ready = new ArrayList<>(authored.stream().filter(id -> remaining.get(id) == 0).toList());
        while (!ready.isEmpty()) {
            UUID next = ready.removeFirst();
            result.add(next);
            for (UUID dependent : unlocks.get(next)) if (remaining.merge(dependent, -1, Integer::sum) == 0) insertAuthored(ready, dependent, authored);
        }
        for (UUID id : authored) if (!result.contains(id)) result.add(id);
        return List.copyOf(result);
    }

    /** Keeps the ready set in authored order so the same curriculum always sequences identically. */
    private static void insertAuthored(List<UUID> ready, UUID lessonId, List<UUID> authored) {
        int rank = authored.indexOf(lessonId);
        int at = 0;
        while (at < ready.size() && authored.indexOf(ready.get(at)) < rank) at++;
        ready.add(at, lessonId);
    }

    public record Lesson(UUID id, UUID topicId, String title, int moduleOrdinal, int ordinal, int targetLevel,
                         int estimatedMinutes, double effectiveMastery) {}
    public record Edge(UUID lessonId, UUID prerequisiteLessonId) {}
}
