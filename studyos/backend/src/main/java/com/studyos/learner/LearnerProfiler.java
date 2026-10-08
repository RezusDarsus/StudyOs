package com.studyos.learner;

import com.studyos.adaptive.CognitiveLevel;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * Derives the long-term student model from recorded evidence. Pure and deterministic: no database,
 * no AI call, and no subject vocabulary anywhere in it.
 *
 * <p>Two things keep this honest. First, acquisition speed is judged against the student's own
 * median rate rather than an absolute scale, so "picks this up quickly" means quickly <em>for them</em>
 * and the same code works for a slow-and-careful student as for a fast one. Second, nothing is
 * claimed from a single observation: every threshold has a minimum evidence count behind it, and each
 * trait reports the confidence its evidence actually supports.
 */
public final class LearnerProfiler {
    /** Below this many graded attempts a topic says nothing about how fast the student learns. */
    public static final int MIN_TOPIC_ATTEMPTS = 3;
    /** A mistake has to come back before it is a pattern rather than a slip. */
    public static final int MIN_MISTAKE_OCCURRENCES = 2;
    public static final int MIN_LEVEL_ATTEMPTS = 3;

    private static final double FAST_RATIO = 1.35;
    private static final double SLOW_RATIO = .7;
    private static final double STRENGTH_BAR = .75;
    private static final double WEAKNESS_BAR = .5;
    private static final double SUPPORT_RELIANCE_BAR = .45;
    private static final double RETENTION_RISK_BAR = .75;
    private static final double AVOIDANCE_BAR = .3;
    private static final double LEVEL_HELD_BAR = .6;
    private static final double LEVEL_FAILED_BAR = .5;
    /** How many topic-scoped traits of one kind to keep, so the profile stays readable. */
    private static final int MAX_PER_KIND = 5;
    /**
     * Shrinkage prior for trait confidence. Smaller than the mastery model's because a trait is a
     * coarser claim than a mastery estimate, so a handful of consistent observations already means
     * something.
     */
    private static final double CONFIDENCE_PRIOR = 4;

    private LearnerProfiler() {}

    /** The whole profile, most notable trait of each kind first. */
    public static List<Trait> derive(Evidence evidence) {
        if (evidence == null) return List.of();
        List<TopicEvidence> topics = evidence.topics() == null ? List.of() : evidence.topics();
        List<Trait> traits = new ArrayList<>();
        traits.addAll(acquisition(topics));
        traits.addAll(areas(topics));
        traits.addAll(mistakes(evidence.mistakes() == null ? List.of() : evidence.mistakes()));
        traits.addAll(levelCeiling(evidence.levels() == null ? List.of() : evidence.levels()));
        traits.addAll(behaviour(topics, evidence.behaviour()));
        return traits.stream()
                .sorted(Comparator.comparingInt((Trait trait) -> trait.kind().ordinal())
                        .thenComparing(Comparator.comparingDouble(Trait::value).reversed())
                        .thenComparing(Trait::subject))
                .toList();
    }

    /**
     * Which topics this student picks up faster or slower than they usually do. Needs at least two
     * comparable topics, because a single topic cannot be faster than itself.
     */
    private static List<Trait> acquisition(List<TopicEvidence> topics) {
        List<TopicEvidence> comparable = topics.stream().filter(topic -> topic.attempts() >= MIN_TOPIC_ATTEMPTS).toList();
        if (comparable.size() < 2) return List.of();
        double median = median(comparable.stream().mapToDouble(TopicEvidence::gainPerAttempt).toArray());
        if (median <= 0) return List.of();
        List<Trait> fast = new ArrayList<>();
        List<Trait> slow = new ArrayList<>();
        for (TopicEvidence topic : comparable) {
            double ratio = topic.gainPerAttempt() / median;
            if (ratio >= FAST_RATIO)
                fast.add(new Trait(LearnerTraitKind.FAST_ACQUISITION, topic.topic(), topic.topicId(),
                        String.format(Locale.ROOT, "Gained %.0f%% mastery over %d attempts — about %.1fx this student's usual rate",
                                topic.masteryGain() * 100, topic.attempts(), ratio),
                        Math.min(1, (ratio - 1) / 2), topic.attempts(), confidence(topic.attempts())));
            else if (ratio <= SLOW_RATIO)
                slow.add(new Trait(LearnerTraitKind.SLOW_ACQUISITION, topic.topic(), topic.topicId(),
                        String.format(Locale.ROOT, "Gained only %.0f%% mastery over %d attempts — about %.0f%% of this student's usual rate",
                                topic.masteryGain() * 100, topic.attempts(), ratio * 100),
                        Math.min(1, 1 - Math.max(0, ratio)), topic.attempts(), confidence(topic.attempts())));
        }
        List<Trait> traits = new ArrayList<>(top(fast));
        traits.addAll(top(slow));
        return traits;
    }

    /** Where the student is secure and where they are not, on effective (retention-decayed) mastery. */
    private static List<Trait> areas(List<TopicEvidence> topics) {
        List<Trait> strengths = new ArrayList<>();
        List<Trait> weaknesses = new ArrayList<>();
        for (TopicEvidence topic : topics) {
            if (topic.attempts() <= 0 && topic.evidenceCount() <= 0) continue;
            double effective = clamp(topic.effectiveMastery());
            int observations = Math.max(topic.attempts(), topic.evidenceCount());
            if (effective >= STRENGTH_BAR)
                strengths.add(new Trait(LearnerTraitKind.STRENGTH, topic.topic(), topic.topicId(),
                        String.format(Locale.ROOT, "Holding at %.0f%% across %d recorded attempts", effective * 100, observations),
                        effective, observations, confidence(observations)));
            else if (effective < WEAKNESS_BAR)
                weaknesses.add(new Trait(LearnerTraitKind.WEAKNESS, topic.topic(), topic.topicId(),
                        String.format(Locale.ROOT, "Sitting at %.0f%% after %d recorded attempts", effective * 100, observations),
                        1 - effective, observations, confidence(observations)));
        }
        List<Trait> traits = new ArrayList<>(top(strengths));
        traits.addAll(top(weaknesses));
        return traits;
    }

    /** Mistakes that have come back. The label is the student's own recorded misconception text. */
    private static List<Trait> mistakes(List<MistakeEvidence> mistakes) {
        List<Trait> traits = new ArrayList<>();
        for (MistakeEvidence mistake : mistakes) {
            if (mistake.label() == null || mistake.label().isBlank()) continue;
            if (mistake.occurrences() < MIN_MISTAKE_OCCURRENCES || mistake.resolved()) continue;
            double value = clamp(clamp(mistake.severity()) * .6 + Math.min(1, mistake.occurrences() / 6.0) * .4);
            traits.add(new Trait(LearnerTraitKind.RECURRING_MISTAKE, mistake.label(), mistake.topicId(),
                    String.format(Locale.ROOT, "Seen %d times%s and still open", mistake.occurrences(),
                            mistake.topic() == null || mistake.topic().isBlank() ? "" : " in " + mistake.topic()),
                    value, mistake.occurrences(), confidence(mistake.occurrences())));
        }
        return top(traits);
    }

    /**
     * The lowest cognitive level the student reliably fails while holding a level below it. That gap
     * is exactly where a worked example belongs, which is why only one ceiling is reported.
     */
    private static List<Trait> levelCeiling(List<LevelEvidence> levels) {
        List<LevelEvidence> ordered = levels.stream().filter(level -> level.attempts() >= MIN_LEVEL_ATTEMPTS)
                .sorted(Comparator.comparingInt(LevelEvidence::level)).toList();
        LevelEvidence held = null;
        for (LevelEvidence level : ordered) {
            if (level.meanScore() >= LEVEL_HELD_BAR) { held = level; continue; }
            if (held == null || level.meanScore() >= LEVEL_FAILED_BAR) continue;
            return List.of(new Trait(LearnerTraitKind.LEVEL_CEILING, CognitiveLevel.ofRank(level.level()).label(), null,
                    String.format(Locale.ROOT, "Averaging %.0f%% at %s over %d attempts, after holding %s at %.0f%%",
                            level.meanScore() * 100, CognitiveLevel.ofRank(level.level()).label(), level.attempts(),
                            CognitiveLevel.ofRank(held.level()).label(), held.meanScore() * 100),
                    1 - clamp(level.meanScore()), level.attempts(), confidence(level.attempts())));
        }
        return List.of();
    }

    /** How this student works: hint use, what survives to the next session, skipping, and rhythm. */
    private static List<Trait> behaviour(List<TopicEvidence> topics, BehaviourEvidence behaviour) {
        List<Trait> traits = new ArrayList<>();
        if (behaviour == null) return traits;
        if (behaviour.gradedAttempts() >= MIN_TOPIC_ATTEMPTS) {
            double share = (double) behaviour.supportedAttempts() / behaviour.gradedAttempts();
            if (share >= SUPPORT_RELIANCE_BAR)
                traits.add(new Trait(LearnerTraitKind.SUPPORT_RELIANCE, "Hint use", null,
                        String.format(Locale.ROOT, "Needed a hint on %d of %d graded attempts%s", behaviour.supportedAttempts(),
                                behaviour.gradedAttempts(), behaviour.revealedSolutions() > 0
                                        ? ", and the full solution " + behaviour.revealedSolutions() + " times" : ""),
                        clamp(share), behaviour.gradedAttempts(), confidence(behaviour.gradedAttempts())));
        }
        List<TopicEvidence> retained = topics.stream()
                .filter(topic -> topic.measuredMastery() > 0 && (topic.attempts() > 0 || topic.evidenceCount() > 0)).toList();
        if (!retained.isEmpty()) {
            double ratio = retained.stream()
                    .mapToDouble(topic -> Math.min(1, topic.effectiveMastery() / topic.measuredMastery())).average().orElse(1);
            if (ratio < RETENTION_RISK_BAR)
                traits.add(new Trait(LearnerTraitKind.RETENTION_RISK, "Retention between sessions", null,
                        String.format(Locale.ROOT, "About %.0f%% of measured mastery survives to the next session, across %d topics",
                                ratio * 100, retained.size()),
                        clamp(1 - ratio), retained.size(), confidence(retained.size())));
        }
        int decided = behaviour.completedSteps() + behaviour.skippedSteps();
        if (decided >= MIN_TOPIC_ATTEMPTS) {
            double share = (double) behaviour.skippedSteps() / decided;
            if (share >= AVOIDANCE_BAR)
                traits.add(new Trait(LearnerTraitKind.TASK_AVOIDANCE, "Skipped steps", null,
                        String.format(Locale.ROOT, "Skipped %d of %d planned steps", behaviour.skippedSteps(), decided),
                        clamp(share), decided, confidence(decided)));
        }
        if (behaviour.windowDays() > 0 && behaviour.activeDays() > 0)
            traits.add(new Trait(LearnerTraitKind.STUDY_RHYTHM, "Days studied", null,
                    String.format(Locale.ROOT, "Studied on %d of the last %d days", behaviour.activeDays(), behaviour.windowDays()),
                    clamp((double) behaviour.activeDays() / behaviour.windowDays()), behaviour.activeDays(),
                    confidence(behaviour.activeDays())));
        if (behaviour.medianSessionMinutes() > 0)
            traits.add(new Trait(LearnerTraitKind.SESSION_LENGTH, "Minutes per session", null,
                    String.format(Locale.ROOT, "Typically works about %d minutes at a time", behaviour.medianSessionMinutes()),
                    clamp(behaviour.medianSessionMinutes() / 120.0), Math.max(1, behaviour.sessions()),
                    confidence(behaviour.sessions())));
        return traits;
    }

    private static List<Trait> top(List<Trait> traits) {
        return traits.stream().sorted(Comparator.comparingDouble(Trait::value).reversed()
                .thenComparing(Trait::subject)).limit(MAX_PER_KIND).toList();
    }

    /** Evidence-count shrinkage: the same shape the mastery model uses, with a smaller prior. */
    static double confidence(int evidenceCount) {
        double count = Math.max(0, evidenceCount);
        return Math.min(.95, count / (count + CONFIDENCE_PRIOR));
    }

    static double median(double[] values) {
        if (values == null || values.length == 0) return 0;
        double[] sorted = values.clone();
        java.util.Arrays.sort(sorted);
        int middle = sorted.length / 2;
        return sorted.length % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    private static double clamp(double value) { return Math.max(0, Math.min(1, value)); }

    /**
     * One topic's recorded history. {@code masteryGain} is how much mastery the attempts actually
     * produced, which is what makes acquisition speed measurable rather than guessed.
     */
    public record TopicEvidence(UUID topicId, String topic, int attempts, int evidenceCount, double meanScore,
                                double masteryGain, double measuredMastery, double effectiveMastery) {
        public double gainPerAttempt() { return masteryGain / Math.max(1, attempts); }
    }

    public record MistakeEvidence(String label, UUID topicId, String topic, int occurrences, double severity, String status) {
        public boolean resolved() { return "RESOLVED".equalsIgnoreCase(status); }
    }

    /** Aggregate performance at one cognitive level, across every topic. */
    public record LevelEvidence(int level, int attempts, double meanScore) {}

    public record BehaviourEvidence(int gradedAttempts, int supportedAttempts, int revealedSolutions,
                                    int activeDays, int windowDays, int medianSessionMinutes, int sessions,
                                    int completedSteps, int skippedSteps) {}

    public record Evidence(List<TopicEvidence> topics, List<MistakeEvidence> mistakes,
                           List<LevelEvidence> levels, BehaviourEvidence behaviour) {}

    public record Trait(LearnerTraitKind kind, String subject, UUID topicId, String detail, double value,
                        int evidenceCount, double confidence) {}
}
