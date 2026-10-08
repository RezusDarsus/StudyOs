package com.studyos.planner;

import java.util.*;
import java.util.function.ToIntFunction;

/** Pure bounded ordering of already-ranked study candidates and their prerequisites. */
public final class PrerequisiteSequencer {
    private PrerequisiteSequencer() {}

    public static <T> List<Selection<T>> sequence(List<Node<T>> ordered, Map<T, List<T>> prerequisites,
                                                    int availableMinutes, Settings settings,
                                                    ToIntFunction<Node<T>> durationMinutes) {
        Map<T, Node<T>> byId = new LinkedHashMap<>();
        ordered.forEach(node -> byId.put(node.id(), node));
        State<T> state = new State<>(availableMinutes);
        for (Node<T> node : ordered) schedule(node, false, 0, byId, prerequisites, settings, durationMinutes, state);
        return List.copyOf(state.selections);
    }

    private static <T> void schedule(Node<T> node, boolean injected, int depth, Map<T, Node<T>> byId,
                                     Map<T, List<T>> prerequisites, Settings settings,
                                     ToIntFunction<Node<T>> durationMinutes, State<T> state) {
        if (state.scheduled.contains(node.id()) || state.taskCount >= settings.maxTasks() || state.remaining < settings.minimumTaskMinutes()) return;
        if (depth > settings.maxPrerequisiteDepth()) return;
        List<T> required = prerequisites.getOrDefault(node.id(), List.of());
        for (T prerequisiteId : required) {
            Node<T> prerequisite = byId.get(prerequisiteId);
            if (prerequisite == null || prerequisite.effectiveMastery() >= settings.weakPrerequisiteThreshold() || state.scheduled.contains(prerequisiteId)) continue;
            if (state.injectedPrerequisites >= settings.maxInjectedPrerequisites()) return;
            state.injectedPrerequisites++;
            schedule(prerequisite, true, depth + 1, byId, prerequisites, settings, durationMinutes, state);
        }
        boolean weakPrerequisiteUnscheduled = required.stream().map(byId::get).filter(Objects::nonNull)
                .anyMatch(prerequisite -> prerequisite.effectiveMastery() < settings.weakPrerequisiteThreshold() && !state.scheduled.contains(prerequisite.id()));
        if (weakPrerequisiteUnscheduled) return;
        int duration = durationMinutes.applyAsInt(node);
        if (state.remaining < duration) return;
        state.selections.add(new Selection<>(node, injected, duration));
        state.remaining -= duration;
        state.taskCount++;
        state.scheduled.add(node.id());
    }

    public record Node<T>(T id, double effectiveMastery) {}
    public record Selection<T>(Node<T> node, boolean injectedPrerequisite, int durationMinutes) {}
    public record Settings(double weakPrerequisiteThreshold, int maxPrerequisiteDepth,
                           int maxInjectedPrerequisites, int maxTasks, int minimumTaskMinutes) {}
    private static final class State<T> {
        private int remaining;
        private int taskCount;
        private int injectedPrerequisites;
        private final Set<T> scheduled = new HashSet<>();
        private final List<Selection<T>> selections = new ArrayList<>();
        private State(int remaining) { this.remaining = remaining; }
    }
}
