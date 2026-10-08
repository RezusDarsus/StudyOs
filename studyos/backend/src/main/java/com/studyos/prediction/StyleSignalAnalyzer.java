package com.studyos.prediction;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Evidence-backed style signals derived from the exam history. Every statement is a count or a
 * share computed from stored ground truth — never a personality reading. The output sentences are
 * deliberately of the form "4 of the last 6 exams contained multi-concept application questions",
 * not "the examiner likes trick questions".
 */
public final class StyleSignalAnalyzer {

    private StyleSignalAnalyzer() {}

    public record StyleReport(int examsAnalyzed, String dominantQuestionType, double dominantQuestionTypeShare,
                              double repeatTopicShare, double parameterReuseRate, double conceptCombinationTendency,
                              List<String> statements) {}

    public static StyleReport analyze(List<BacktestEngine.ExamGroundTruth> exams) {
        if (exams.size() < 2) {
            return new StyleReport(exams.size(), null, 0, 0, 0, 0,
                    List.of("At least two historical exams are needed before any style statement can be made."));
        }

        // Dominant question type by total question share.
        Map<String, Integer> typeCounts = new HashMap<>();
        int totalQuestions = 0;
        for (BacktestEngine.ExamGroundTruth exam : exams) {
            for (Map.Entry<String, Integer> entry : exam.structures().entrySet()) {
                typeCounts.merge(entry.getKey(), entry.getValue(), Integer::sum);
                totalQuestions += entry.getValue();
            }
        }
        String dominantType = typeCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .map(Map.Entry::getKey).findFirst().orElse(null);
        double dominantShare = totalQuestions == 0 ? 0
                : (dominantType == null ? 0 : typeCounts.get(dominantType) / (double) totalQuestions);

        // Repeat-topic share: how many exams reused at least one topic from the exam before them.
        int repeatExams = 0;
        int comparable = 0;
        Set<UUID> everSeen = new HashSet<>();
        for (int index = 0; index < exams.size(); index++) {
            BacktestEngine.ExamGroundTruth exam = exams.get(index);
            if (index > 0) {
                comparable++;
                boolean repeats = exam.topicIds().stream().anyMatch(everSeen::contains);
                if (repeats) repeatExams++;
            }
            everSeen.addAll(exam.topicIds());
        }
        double repeatShare = comparable == 0 ? 0 : (double) repeatExams / comparable;

        // Parameter reuse: the share of exams whose topic set overlaps the previous exam by >= 60%.
        int parameterReuse = 0;
        for (int index = 1; index < exams.size(); index++) {
            Set<UUID> previous = exams.get(index - 1).topicIds();
            Set<UUID> current = exams.get(index).topicIds();
            if (previous.isEmpty() || current.isEmpty()) continue;
            long shared = current.stream().filter(previous::contains).count();
            double overlap = (double) shared / Math.min(previous.size(), current.size());
            if (overlap >= 0.6) parameterReuse++;
        }
        double parameterReuseRate = (exams.size() - 1) == 0 ? 0 : (double) parameterReuse / (exams.size() - 1);

        // Concept combination: the average number of distinct topics per exam, normalised against
        // the first exam so the statement reads as a tendency, not an absolute.
        double averageTopics = exams.stream().mapToInt(exam -> exam.topicIds().size()).average().orElse(0);
        double firstExamTopics = Math.max(1, exams.get(0).topicIds().size());
        double combinationTendency = Math.max(0, averageTopics / firstExamTopics - 1);

        List<String> statements = new ArrayList<>();
        if (dominantType != null) {
            statements.add(String.format("%d of %d questions across %d exams were %s (%.0f%%).",
                    typeCounts.get(dominantType), totalQuestions, exams.size(), dominantType.replaceAll("_", " ").toLowerCase(), dominantShare * 100));
        }
        statements.add(String.format("%d of the last %d exams reused at least one topic from earlier exams.", repeatExams, comparable));
        statements.add(String.format("%d of %d exam transitions reused at least 60%% of the previous exam's topics.", parameterReuse, exams.size() - 1));
        statements.add(String.format("Exams average %.1f distinct topics (first exam: %.0f), a concept-combination tendency of %.0f%%.",
                averageTopics, firstExamTopics, combinationTendency * 100));
        return new StyleReport(exams.size(), dominantType, dominantShare, repeatShare, parameterReuseRate, combinationTendency, statements);
    }
}
