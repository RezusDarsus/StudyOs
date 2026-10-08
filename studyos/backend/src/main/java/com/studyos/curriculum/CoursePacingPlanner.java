package com.studyos.curriculum;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Distributes a curriculum's remaining work across the weeks that are actually left.
 *
 * <p>Pacing is honest before it is clever: when the required learning time exceeds the time the
 * learner has, the plan says so and prioritizes instead of pretending everything fits. Completed
 * mastery reduces a lesson's remaining minutes; mastered content contributes review load rather
 * than relearning load. Prerequisites bound the earliest week a lesson may land in.
 */
public final class CoursePacingPlanner {

    public enum Tier { CRITICAL, HIGH, MEDIUM, OPTIONAL }

    public record LessonWork(UUID lessonId, UUID topicId, String title, int estimatedMinutes, double mastery,
                             double topicImportance, double topicDifficulty, int targetLevel, List<UUID> prerequisiteLessons) {}

    public record Task(UUID lessonId, String title, int minutes, Tier tier, double priority, String reason) {}

    public record WeekPlan(int week, int minutes, List<Task> tasks) {}

    public record Plan(int weeksAvailable, long requiredMinutes, long availableMinutes, boolean fits,
                       long reviewMinutes, List<WeekPlan> weeks, List<Task> dropped, List<String> notes) {}

    private CoursePacingPlanner() {}

    /**
     * @param lessons every lesson with its live mastery and topic model figures
     * @param daysUntilDeadline days until the exam/target date; null or large means open-ended
     * @param minutesPerDay the learner's realistic daily budget
     * @param daysPerWeek how many days a week the learner actually studies
     */
    public static Plan plan(List<LessonWork> lessons, Integer daysUntilDeadline, int minutesPerDay, int daysPerWeek) {
        List<String> notes = new ArrayList<>();
        int safeMinutesPerDay = Math.max(10, minutesPerDay);
        int safeDaysPerWeek = Math.max(1, Math.min(7, daysPerWeek));
        int weeksAvailable = daysUntilDeadline == null || daysUntilDeadline <= 0
                ? 8
                : Math.max(1, (int) Math.ceil(daysUntilDeadline / 7.0));
        long availableMinutes = (long) weeksAvailable * safeDaysPerWeek * safeMinutesPerDay;

        long requiredNew = 0;
        long reviewMinutes = 0;
        Map<UUID, Long> remaining = new HashMap<>();
        for (LessonWork lesson : lessons) {
            long left = Math.round(lesson.estimatedMinutes() * (1 - clamp01(lesson.mastery())));
            remaining.put(lesson.lessonId(), left);
            requiredNew += left;
            if (clamp01(lesson.mastery()) >= 0.8) reviewMinutes += 8; // consolidation, not relearning
        }
        long requiredMinutes = requiredNew + reviewMinutes;
        boolean fits = requiredMinutes <= availableMinutes;
        if (!fits) notes.add("Required learning time (" + requiredMinutes + " min) exceeds available time (" + availableMinutes
                + " min) before the deadline; the plan below prioritizes and drops what can wait.");

        // Priority: importance drives tier; within a tier, prerequisite depth and difficulty order the work.
        Map<UUID, Integer> depth = prerequisiteDepth(lessons);
        List<Scored> scored = new ArrayList<>();
        for (LessonWork lesson : lessons) {
            long left = remaining.get(lesson.lessonId());
            if (left <= 0) continue;
            double importance = clamp01(lesson.topicImportance()) == 0 && lesson.targetLevel() >= 5 ? 0.6 : clamp01(lesson.topicImportance());
            Tier tier = tier(importance, lesson.topicDifficulty(), depth.getOrDefault(lesson.lessonId(), 0));
            double priority = importance * 2 + clamp01(lesson.topicDifficulty()) + Math.min(depth.getOrDefault(lesson.lessonId(), 0), 4) * 0.1;
            scored.add(new Scored(lesson, left, tier, priority));
        }
        scored.sort(Comparator.comparing((Scored item) -> item.tier).thenComparing(item -> -item.priority));

        // Budget: when capacity is short, only the head of the priority order is scheduled.
        long budget = fits ? availableMinutes - reviewMinutes : Math.max(0, availableMinutes - reviewMinutes);
        List<Scored> scheduled = new ArrayList<>();
        List<Scored> dropped = new ArrayList<>();
        long spent = 0;
        for (Scored item : scored) {
            if (spent + item.minutes <= budget || scheduled.isEmpty()) {
                scheduled.add(item);
                spent += item.minutes;
            } else {
                dropped.add(item);
            }
        }

        // Distribute into weeks. A lesson cannot start before the week after its latest prerequisite.
        Map<UUID, Integer> weekOf = new HashMap<>();
        List<WeekPlan> weeks = new ArrayList<>();
        for (int week = 1; week <= weeksAvailable; week++) weeks.add(new WeekPlan(week, 0, new ArrayList<>()));
        long weeklyCapacity = (long) safeDaysPerWeek * safeMinutesPerDay;
        List<Scored> orderedForScheduling = orderedRespectingPrerequisites(scheduled, lessons);
        for (Scored item : orderedForScheduling) {
            int earliest = 1;
            for (UUID prerequisite : item.lesson.prerequisiteLessons()) {
                Integer prerequisiteWeek = weekOf.get(prerequisite);
                if (prerequisiteWeek != null) earliest = Math.max(earliest, prerequisiteWeek + 1);
            }
            int week = weeksAvailable + 1;
            for (int candidate = earliest; candidate <= weeksAvailable; candidate++) {
                if (weeks.get(candidate - 1).minutes() + item.minutes <= weeklyCapacity) { week = candidate; break; }
            }
            if (week > weeksAvailable) {
                // Does not fit inside the horizon even with prioritization; keep it honest.
                dropped.add(item);
                continue;
            }
            weekOf.put(item.lesson.lessonId(), week);
            WeekPlan target = weeks.get(week - 1);
            target.tasks().add(new Task(item.lesson.lessonId(), item.lesson.title(), (int) item.minutes, item.tier, round(item.priority),
                    "Importance " + Math.round(clamp01(item.lesson.topicImportance()) * 100) + "%, mastery " + Math.round(clamp01(item.lesson.mastery()) * 100) + "%"));
            weeks.set(week - 1, new WeekPlan(target.week(), target.minutes() + (int) item.minutes, target.tasks()));
        }
        if (!dropped.isEmpty() && fits) notes.add("Some work could not be placed within " + weeksAvailable + " weeks; extend the horizon or raise the daily budget.");
        return new Plan(weeksAvailable, requiredMinutes, availableMinutes, fits, reviewMinutes,
                weeks.stream().filter(week -> !week.tasks().isEmpty()).toList(),
                dropped.stream().map(item -> new Task(item.lesson.lessonId(), item.lesson.title(), (int) item.minutes, item.tier, round(item.priority), "Dropped: capacity")).toList(),
                notes);
    }

    /** Tier from the learner-facing priority classes; deep prerequisites and low mastery pull up. */
    static Tier tier(double importance, double difficulty, int prerequisiteDepth) {
        double value = clamp01(importance) * 0.7 + clamp01(difficulty) * 0.2 + Math.min(prerequisiteDepth, 4) * 0.025;
        if (value >= 0.62) return Tier.CRITICAL;
        if (value >= 0.42) return Tier.HIGH;
        if (value >= 0.2) return Tier.MEDIUM;
        return Tier.OPTIONAL;
    }

    /** Longest prerequisite chain per lesson, so foundational work sorts first within a tier. */
    private static Map<UUID, Integer> prerequisiteDepth(List<LessonWork> lessons) {
        Map<UUID, List<UUID>> edges = new HashMap<>();
        for (LessonWork lesson : lessons) edges.put(lesson.lessonId(), lesson.prerequisiteLessons());
        Map<UUID, Integer> depth = new HashMap<>();
        for (LessonWork lesson : lessons) depth.put(lesson.lessonId(), depthOf(lesson.lessonId(), edges, new HashSet<>()));
        return depth;
    }

    private static int depthOf(UUID lessonId, Map<UUID, List<UUID>> edges, Set<UUID> seen) {
        if (!seen.add(lessonId)) return 0; // cycle guard; the validator reports cycles separately
        int best = 0;
        for (UUID prerequisite : edges.getOrDefault(lessonId, List.of())) {
            best = Math.max(best, 1 + depthOf(prerequisite, edges, seen));
        }
        return best;
    }

    /** Stable topological-ish order: prerequisites before dependents where both are scheduled. */
    private static List<Scored> orderedRespectingPrerequisites(List<Scored> scheduled, List<LessonWork> all) {
        Map<UUID, Integer> position = new HashMap<>();
        List<Scored> ordered = new ArrayList<>();
        Set<UUID> placed = new HashSet<>();
        List<Scored> pending = new ArrayList<>(scheduled);
        while (!pending.isEmpty()) {
            boolean progressed = false;
            for (Scored item : pending) {
                boolean ready = item.lesson.prerequisiteLessons().stream().allMatch(prerequisite -> placed.contains(prerequisite) || scheduled.stream().noneMatch(other -> other.lesson.lessonId().equals(prerequisite)));
                if (ready) {
                    ordered.add(item);
                    placed.add(item.lesson.lessonId());
                    progressed = true;
                }
            }
            pending.removeAll(ordered);
            if (!progressed) { ordered.addAll(pending); break; } // cycles handled by the validator
        }
        for (Scored item : ordered) position.put(item.lesson.lessonId(), position.size());
        return ordered;
    }

    private static double clamp01(double value) {
        if (Double.isNaN(value) || value < 0) return 0;
        return Math.min(1, value);
    }

    private static double round(double value) { return Math.round(value * 1000) / 1000.0; }

    private record Scored(LessonWork lesson, long minutes, Tier tier, double priority) {}
}
