package com.studyos.curriculum;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Deterministic validation of a generated curriculum, run after generation and after re-planning.
 *
 * <p>An LLM (or a bulk topic import) can produce a curriculum that looks plausible and still be
 * wrong in ways the learner pays for: a lesson whose topic does not exist, security taught before
 * the dependency injection it rests on, an empty module, a basic-syntax lesson followed by
 * distributed-transaction recovery. Every check here is pure and explainable — each finding names
 * the lesson and the rule that fired — and severity separates what must be fixed from what is
 * merely worth knowing.
 */
public final class CurriculumIntegrityValidator {

    public enum Severity { ERROR, WARNING, INFO }

    public record Finding(String code, Severity severity, String message, UUID lessonId, UUID topicId) {}

    public record LessonInput(UUID id, UUID topicId, String title, int moduleOrdinal, int ordinal,
                              int targetLevel, int estimatedMinutes, String objective) {}

    public record EdgeInput(UUID lessonId, UUID prerequisiteLessonId) {}

    public record Input(List<LessonInput> lessons, List<EdgeInput> edges,
                        Set<UUID> knownTopicIds, Map<UUID, Long> topicEvidence,
                        Map<UUID, Double> topicImportance, Map<UUID, Double> topicDifficulty,
                        Map<UUID, Set<UUID>> topicPrerequisites) {
        public Input {
            knownTopicIds = knownTopicIds == null ? Set.of() : knownTopicIds;
            topicEvidence = topicEvidence == null ? Map.of() : topicEvidence;
            topicImportance = topicImportance == null ? Map.of() : topicImportance;
            topicDifficulty = topicDifficulty == null ? Map.of() : topicDifficulty;
            topicPrerequisites = topicPrerequisites == null ? Map.of() : topicPrerequisites;
        }

        public Input(List<LessonInput> lessons, List<EdgeInput> edges, Set<UUID> knownTopicIds,
                     Map<UUID, Long> topicEvidence, Map<UUID, Double> topicImportance, Map<UUID, Double> topicDifficulty) {
            this(lessons, edges, knownTopicIds, topicEvidence, topicImportance, topicDifficulty, Map.of());
        }
    }

    public record Report(int lessons, int findings, int errors, int warnings, int infos,
                         boolean repairable, boolean needsRegeneration, List<Finding> items) {}

    private CurriculumIntegrityValidator() {}

    public static Report validate(Input input) {
        List<Finding> findings = new ArrayList<>();
        if (input.lessons().isEmpty()) {
            findings.add(new Finding("EMPTY_CURRICULUM", Severity.ERROR, "The curriculum has no lessons", null, null));
            return report(findings);
        }

        List<LessonInput> lessons = input.lessons();
        Map<UUID, LessonInput> byId = new LinkedHashMap<>();
        for (LessonInput lesson : lessons) byId.put(lesson.id(), lesson);

        // Missing topic + unsupported lesson + missing objective.
        for (LessonInput lesson : lessons) {
            if (lesson.topicId() == null || !input.knownTopicIds().contains(lesson.topicId())) {
                findings.add(new Finding("MISSING_TOPIC", Severity.ERROR, "Lesson '" + lesson.title() + "' references a topic that does not exist", lesson.id(), lesson.topicId()));
            } else if (input.topicEvidence().getOrDefault(lesson.topicId(), 0L) == 0) {
                findings.add(new Finding("UNSUPPORTED_LESSON", Severity.WARNING, "Lesson '" + lesson.title() + "' points to a topic with no source evidence", lesson.id(), lesson.topicId()));
            }
            if (lesson.objective() == null || lesson.objective().isBlank()) {
                findings.add(new Finding("MISSING_OBJECTIVE", Severity.INFO, "Lesson '" + lesson.title() + "' has no objective", lesson.id(), lesson.topicId()));
            }
        }

        // Duplicate concepts: same normalized title taught twice without review purpose.
        Map<String, List<LessonInput>> byTitle = new HashMap<>();
        for (LessonInput lesson : lessons) {
            byTitle.computeIfAbsent(fold(lesson.title()), key -> new ArrayList<>()).add(lesson);
        }
        List<UUID> removableDuplicates = new ArrayList<>();
        for (Map.Entry<String, List<LessonInput>> entry : byTitle.entrySet()) {
            if (entry.getValue().size() < 2) continue;
            for (int index = 1; index < entry.getValue().size(); index++) {
                LessonInput duplicate = entry.getValue().get(index);
                findings.add(new Finding("DUPLICATE_LESSON", Severity.WARNING, "Lesson '" + duplicate.title() + "' appears more than once", duplicate.id(), duplicate.topicId()));
                removableDuplicates.add(duplicate.id());
            }
        }

        // Empty modules are invisible gaps in the ordering.
        Map<Integer, Integer> lessonsPerModule = new HashMap<>();
        for (LessonInput lesson : lessons) lessonsPerModule.merge(lesson.moduleOrdinal(), 1, Integer::sum);
        if (!lessonsPerModule.isEmpty()) {
            for (int module = 0; module <= lessonsPerModule.keySet().stream().max(Integer::compare).orElse(0); module++) {
                if (lessonsPerModule.getOrDefault(module, 0) == 0) {
                    findings.add(new Finding("EMPTY_MODULE", Severity.ERROR, "Module " + module + " has no lessons", null, null));
                }
            }
        }

        // Invalid ordering: lesson ordinals inside a module must increase without repeats.
        Map<Integer, Integer> lastOrdinal = new HashMap<>();
        for (LessonInput lesson : lessons) {
            Integer previous = lastOrdinal.get(lesson.moduleOrdinal());
            if (previous != null && lesson.ordinal() <= previous) {
                findings.add(new Finding("INVALID_ORDER", Severity.WARNING, "Lesson '" + lesson.title() + "' breaks the lesson ordering in module " + lesson.moduleOrdinal(), lesson.id(), lesson.topicId()));
            }
            lastOrdinal.put(lesson.moduleOrdinal(), Math.max(previous == null ? Integer.MIN_VALUE : previous, lesson.ordinal()));
        }

        // Cycles: a lesson that (transitively) requires itself can never unlock.
        List<UUID> cyclic = cycles(byId, input.edges());
        for (UUID lessonId : cyclic) {
            findings.add(new Finding("CYCLE", Severity.ERROR, "Lesson '" + byId.get(lessonId).title() + "' sits in a prerequisite cycle", lessonId, byId.get(lessonId).topicId()));
        }

        // Missing prerequisites: a lesson that needs topic P but appears before any lesson on P.
        Map<UUID, UUID> lessonTopic = new HashMap<>();
        for (LessonInput lesson : lessons) if (lesson.topicId() != null) lessonTopic.putIfAbsent(lesson.id(), lesson.topicId());
        Map<UUID, Integer> position = new HashMap<>();
        for (int index = 0; index < lessons.size(); index++) position.put(lessons.get(index).id(), index);
        for (EdgeInput edge : input.edges()) {
            LessonInput lesson = byId.get(edge.lessonId());
            LessonInput prerequisite = byId.get(edge.prerequisiteLessonId());
            if (lesson == null || prerequisite == null) continue;
            Integer lessonAt = position.get(lesson.id());
            Integer prerequisiteAt = position.get(prerequisite.id());
            if (lessonAt != null && prerequisiteAt != null && prerequisiteAt > lessonAt) {
                findings.add(new Finding("PREREQUISITE_ORDER", Severity.ERROR, "Lesson '" + lesson.title() + "' is scheduled before its prerequisite '" + prerequisite.title() + "'", lesson.id(), lesson.topicId()));
            }
        }

        // Topic-level prerequisites: topic P is a prerequisite of topic T, T has a lesson, but no
        // lesson anywhere in the curriculum covers P.
        Set<UUID> coveredTopics = new HashSet<>();
        for (LessonInput lesson : lessons) if (lesson.topicId() != null) coveredTopics.add(lesson.topicId());
        for (LessonInput lesson : lessons) {
            Set<UUID> prerequisites = lesson.topicId() == null ? Set.of() : input.topicPrerequisites().getOrDefault(lesson.topicId(), Set.of());
            for (UUID prerequisiteTopic : prerequisites) {
                if (coveredTopics.contains(prerequisiteTopic)) continue;
                if (!input.knownTopicIds().contains(prerequisiteTopic)) continue;
                findings.add(new Finding("TOPIC_PREREQUISITE_UNCOVERED", Severity.WARNING,
                        "Lesson '" + lesson.title() + "' assumes a prerequisite topic that no lesson covers", lesson.id(), lesson.topicId()));
                break;
            }
        }

        // Important topic omission: high-importance topics the curriculum never teaches.
        for (Map.Entry<UUID, Double> entry : input.topicImportance().entrySet()) {
            if (entry.getValue() < 0.7 || coveredTopics.contains(entry.getKey())) continue;
            findings.add(new Finding("IMPORTANT_TOPIC_OMITTED", Severity.WARNING, "A high-importance topic is not covered by any lesson", null, entry.getKey()));
        }

        // Excessive difficulty jump between lessons taught back to back.
        for (int index = 1; index < lessons.size(); index++) {
            LessonInput before = lessons.get(index - 1);
            LessonInput current = lessons.get(index);
            Double beforeDifficulty = before.topicId() == null ? null : input.topicDifficulty().get(before.topicId());
            Double currentDifficulty = current.topicId() == null ? null : input.topicDifficulty().get(current.topicId());
            if (beforeDifficulty == null || currentDifficulty == null) continue;
            if (currentDifficulty - beforeDifficulty >= 0.5) {
                findings.add(new Finding("DIFFICULTY_JUMP", Severity.WARNING,
                        "Difficulty jumps from '" + before.title() + "' to '" + current.title() + "'", current.id(), current.topicId()));
            }
        }

        Report report = report(findings);
        return new Report(report.lessons(), report.findings(), report.errors(), report.warnings(), report.infos(),
                !removableDuplicates.isEmpty(), report.errors() > 0, report.items());
    }

    /** Findings a deterministic repair may act on without regenerating anything. */
    public static List<UUID> removableDuplicates(Report report) {
        return report.items().stream()
                .filter(finding -> "DUPLICATE_LESSON".equals(finding.code()))
                .map(Finding::lessonId)
                .toList();
    }

    private static Report report(List<Finding> findings) {
        int errors = (int) findings.stream().filter(finding -> finding.severity() == Severity.ERROR).count();
        int warnings = (int) findings.stream().filter(finding -> finding.severity() == Severity.WARNING).count();
        int infos = (int) findings.stream().filter(finding -> finding.severity() == Severity.INFO).count();
        return new Report(0, findings.size(), errors, warnings, infos, false, errors > 0, List.copyOf(findings));
    }

    /** Iterative DFS cycle detection over the lesson prerequisite graph, cycle-safe itself. */
    private static List<UUID> cycles(Map<UUID, LessonInput> byId, List<EdgeInput> edges) {
        Map<UUID, List<UUID>> adjacency = new HashMap<>();
        for (EdgeInput edge : edges) {
            if (!byId.containsKey(edge.lessonId()) || !byId.containsKey(edge.prerequisiteLessonId())) continue;
            adjacency.computeIfAbsent(edge.lessonId(), key -> new ArrayList<>()).add(edge.prerequisiteLessonId());
        }
        Set<UUID> inCycle = new HashSet<>();
        for (UUID start : byId.keySet()) {
            List<UUID> stack = new ArrayList<>();
            Set<UUID> onPath = new HashSet<>();
            if (reaches(start, start, adjacency, stack, onPath)) inCycle.add(start);
        }
        return new ArrayList<>(inCycle);
    }

    private static boolean reaches(UUID start, UUID current, Map<UUID, List<UUID>> adjacency, List<UUID> stack, Set<UUID> onPath) {
        for (UUID next : adjacency.getOrDefault(current, List.of())) {
            if (next.equals(start)) return true;
            if (onPath.contains(next)) continue;
            onPath.add(next);
            if (reaches(start, next, adjacency, stack, onPath)) return true;
            onPath.remove(next);
        }
        return false;
    }

    private static String fold(String value) {
        return value == null ? "" : value.toLowerCase(java.util.Locale.ROOT).replaceAll("[^\\p{L}\\p{Nd}]+", " ").trim();
    }
}
