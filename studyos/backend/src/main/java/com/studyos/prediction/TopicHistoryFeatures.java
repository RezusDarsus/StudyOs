package com.studyos.prediction;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Pure, deterministic per-topic history features for the EXAM_TOPIC_V2 experiment. Everything here
 * is computed from the TRAINING exams of a fold only — the held-out exam is structurally invisible
 * — and every feature is normalized within the course, so a 30-topic course and a 300-topic course
 * produce comparable values.
 *
 * <p>Features map one-to-one to the measured questions:
 * <ul>
 *   <li><b>trend/momentum</b> — appearances in the last 2–3 training exams vs the whole history;</li>
 *   <li><b>spacing/repetition</b> — gap regularity: every-exam and every-k-th topics score high,
 *       irregular sparsers low, combined with prevalence;</li>
 *   <li><b>exam position/weight</b> — average points when present, shared by the course maximum,
 *       so a 20-point problem outranks a 2-point definition at equal frequency;</li>
 *   <li><b>question-style compatibility</b> — the topic's apply-level objective share × the
 *       problem-solving share of recent exams;</li>
 *   <li><b>course emphasis</b> — homework / lecture / syllabus kept as three separate shares;</li>
 *   <li><b>prerequisite unlock</b> — dependents that were historically tested, course-normalized;</li>
 *   <li><b>omission pressure</b> — taught-but-recently-absent, hard-capped weak: a bounded nudge,
 *       never a "hasn't appeared yet, so it must appear" gambler's fallacy.</li>
 * </ul>
 * Ranking score and evidence confidence remain separate concerns; this class produces ranking
 * inputs only.
 */
public final class TopicHistoryFeatures {

    private TopicHistoryFeatures() {}

    /** Temporal decay shapes tested against the walk-forward folds; the corpus picks, not intuition. */
    public enum DecayShape {
        NONE { double decay(int age) { return 1; } },
        LINEAR { double decay(int age) { return Math.max(0, 1 - age / 6.0); } },
        HALF_LIFE_2 { double decay(int age) { return Math.pow(0.5, age / 2.0); } },
        HALF_LIFE_3 { double decay(int age) { return Math.pow(0.5, age / 3.0); } },
        HALF_LIFE_4 { double decay(int age) { return Math.pow(0.5, age / 4.0); } };
        abstract double decay(int age);
    }

    /**
     * @param frequencyRate appearances / training exams
     * @param recencyRate decay-weighted appearance rate under one decay shape
     * @param momentum share of the last 3 training exams containing the topic
     * @param spacingRegularity regularity of appearance gaps × prevalence
     * @param averagePointsShare mean points when present / course maximum
     * @param styleCompatibility topic apply-objective share × recent problem-solving share
     * @param homeworkShare / lectureShare / syllabusShare separate course emphasis, course-normalized
     * @param unlockCentrality tested dependents / course maximum
     * @param omissionPressure taught-but-recently-absent, already bounded by construction
     */
    public record Vector(double frequencyRate, double recencyRate, double momentum, double spacingRegularity,
                         double averagePointsShare, double styleCompatibility,
                         double homeworkShare, double lectureShare, double syllabusShare,
                         double unlockCentrality, double omissionPressure) {}

    /** Everything the feature computation needs about one topic's course context. */
    public record Context(Double objectiveApplyShare, List<UUID> dependents, double homeworkItems,
                          double lectureDocuments, boolean inSyllabus, Double importance) {}

    /** Per-fold course-wide aggregates the normalization needs. */
    public record CourseStats(int trainingExamCount, double maxAveragePoints, double maxHomeworkItems,
                              double maxLectureDocuments, double maxTestedDependents, double recentProblemSolvingShare) {}

    private static final int MOMENTUM_WINDOW = 3;
    /** Omission pressure saturates after this many exams of absence — a bounded nudge, never an insistence. */
    private static final double ABSENCE_SATURATION_EXAMS = 4;

    /**
     * @param appearancePoints appearances mapped to the points the topic carried on that exam
     *                         (key = 0-based training-exam index, oldest first)
     */
    public static Vector compute(Map<Integer, Double> appearancePoints, int trainingExamCount,
                                 Context context, CourseStats stats, DecayShape decay) {
        int appearances = appearancePoints.size();
        double frequencyRate = trainingExamCount == 0 ? 0 : (double) appearances / trainingExamCount;

        double decayMass = 0;
        double decayedAppearances = 0;
        for (int age = 0; age < trainingExamCount; age++) {
            decayMass += decay.decay(age);
            Integer examIndex = trainingExamCount - 1 - age;
            if (appearancePoints.containsKey(examIndex)) decayedAppearances += decay.decay(age);
        }
        double recencyRate = decayMass == 0 ? 0 : decayedAppearances / decayMass;

        int window = Math.min(MOMENTUM_WINDOW, Math.max(1, trainingExamCount));
        int recentHits = 0;
        for (int age = 0; age < window; age++) {
            if (appearancePoints.containsKey(trainingExamCount - 1 - age)) recentHits++;
        }
        double momentum = (double) recentHits / window;

        double spacing = spacingRegularity(appearancePoints.keySet(), trainingExamCount) * frequencyRate;

        double averagePoints = appearances == 0 ? 0 : appearancePoints.values().stream().mapToDouble(Double::doubleValue).sum() / appearances;
        double averagePointsShare = stats.maxAveragePoints() <= 0 ? 0 : Math.min(1, averagePoints / stats.maxAveragePoints());

        double applyShare = context.objectiveApplyShare() == null ? 0.5 : clamp(context.objectiveApplyShare());
        double styleCompatibility = applyShare * stats.recentProblemSolvingShare();

        double homeworkShare = stats.maxHomeworkItems() <= 0 ? 0 : clamp(context.homeworkItems() / stats.maxHomeworkItems());
        double lectureShare = stats.maxLectureDocuments() <= 0 ? 0 : clamp(context.lectureDocuments() / stats.maxLectureDocuments());
        double syllabusShare = context.inSyllabus() ? 1 : 0;

        double unlock = stats.maxTestedDependents() <= 0 || context.dependents() == null ? 0
                : clamp(context.dependents().size() / stats.maxTestedDependents());

        // Omission: only for topics that HAVE appeared before and then went quiet. A topic never seen
        // gets no pressure at all — absence of a first appearance is not evidence of an omission.
        int examsSinceLastSeen = appearancePoints.isEmpty() ? Integer.MAX_VALUE
                : trainingExamCount - 1 - maxKey(appearancePoints);
        double taught = clamp(0.5 * clamp(context.importance() == null ? 0 : context.importance())
                + 0.25 * homeworkShare + 0.25 * lectureShare);
        double omissionPressure = appearancePoints.isEmpty() || examsSinceLastSeen <= 0 ? 0
                : taught * Math.min(1, examsSinceLastSeen / ABSENCE_SATURATION_EXAMS);

        return new Vector(frequencyRate, recencyRate, momentum, spacing, averagePointsShare, styleCompatibility,
                homeworkShare, lectureShare, syllabusShare, unlock, omissionPressure);
    }

    /**
     * 1 when the gaps between appearances are uniform (every exam, every second exam, …), falling
     * toward 0 as they scatter. A single appearance is neutral 0.5 — no pattern is knowable.
     */
    static double spacingRegularity(java.util.Set<Integer> appearanceIndices, int trainingExamCount) {
        if (appearanceIndices.size() < 2) return 0.5;
        List<Integer> sorted = new ArrayList<>(appearanceIndices);
        java.util.Collections.sort(sorted);
        double meanGap = (double) (sorted.get(sorted.size() - 1) - sorted.get(0)) / (sorted.size() - 1);
        if (meanGap <= 0) return 0;
        double variance = 0;
        for (int index = 1; index < sorted.size(); index++) {
            double gap = sorted.get(index) - sorted.get(index - 1);
            variance += (gap - meanGap) * (gap - meanGap);
        }
        variance /= sorted.size() - 1;
        double deviation = Math.sqrt(variance) / meanGap;
        return clamp(1 - deviation);
    }

    /** The V2 scoring blend; every coefficient is named so backtests can vary one at a time. */
    public static double score(Vector vector, Weights weights) {
        return clamp(
                weights.frequencyRate() * vector.frequencyRate()
                        + weights.recencyRate() * vector.recencyRate()
                        + weights.momentum() * vector.momentum()
                        + weights.spacing() * vector.spacingRegularity()
                        + weights.points() * vector.averagePointsShare()
                        + weights.style() * vector.styleCompatibility()
                        + weights.homework() * vector.homeworkShare()
                        + weights.lecture() * vector.lectureShare()
                        + weights.syllabus() * vector.syllabusShare()
                        + weights.unlock() * vector.unlockCentrality()
                        + weights.omission() * vector.omissionPressure());
    }

    /** The EXAM_TOPIC_V2 candidate weights. Bound by construction; only a winning held-out
     *  backtest may promote them from candidate to registered model version. */
    public record Weights(double frequencyRate, double recencyRate, double momentum, double spacing,
                          double points, double style, double homework, double lecture, double syllabus,
                          double unlock, double omission) {
        public static final Weights V2_CANDIDATE = new Weights(.18, .18, .10, .05, .10, .05, .10, .10, .05, .05, .04);

        public java.util.Map<String, Double> asMap() {
            java.util.Map<String, Double> map = new java.util.LinkedHashMap<>();
            map.put("frequencyRate", frequencyRate);
            map.put("recencyRate", recencyRate);
            map.put("momentum", momentum);
            map.put("spacing", spacing);
            map.put("points", points);
            map.put("style", style);
            map.put("homework", homework);
            map.put("lecture", lecture);
            map.put("syllabus", syllabus);
            map.put("unlock", unlock);
            map.put("omission", omission);
            return map;
        }
    }

    private static int maxKey(Map<Integer, Double> map) {
        int max = -1;
        for (Integer key : map.keySet()) max = Math.max(max, key);
        return max;
    }

    private static double clamp(double value) { return Math.max(0, Math.min(1, value)); }
}
