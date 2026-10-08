package com.studyos.knowledge;

import java.util.List;
import java.util.Objects;

/**
 * How important a topic is to a course and how much it demands of a learner, from counted evidence only.
 *
 * <p>No DB, no provider, no clock: everything this needs is passed in, so both figures can be checked against
 * fixtures rather than against whatever a model happened to say. Nothing here knows what subject is being
 * studied — a topic's importance comes from how much of <em>this</em> corpus is about it, so the same code ranks
 * a contract-law reader and a coding-theory one without a word of either subject appearing in it.
 *
 * <p>The rule both figures follow: a component that was not measured is not zero. A course whose documents have
 * no derived structure has no heading evidence at all, and scoring every topic zero on structural prominence
 * would rank topics by an absence. Missing components are dropped and the remaining weights renormalised, so a
 * figure always means "out of what could be measured" — and when nothing could be, it is {@link #UNMEASURED}
 * rather than a number.
 */
public final class TopicModel {
    private TopicModel() {}

    /** Returned instead of a figure when there was nothing to measure. Stored as NULL, never as 0. */
    public static final double UNMEASURED = -1;

    /**
     * Attempts needed before the observed component counts. Two attempts distinguish almost nothing: one bad day
     * would mark a topic as the hardest in the course, and the ladder would then hold a learner at recall level
     * on the strength of it.
     */
    static final int MIN_OBSERVATIONS = 3;
    /**
     * Prior weight pulling a small sample toward the middle. Three failures make a topic hard, not impossible,
     * and this is what keeps the difference between three failures and thirty visible in the figure.
     */
    static final double SHRINK = 4;
    /** How much of a correct answer is written off when every hint was needed to get there. */
    static final double ASSIST_DISCOUNT = .5;

    private static final double COVERAGE_WEIGHT = .40;
    private static final double BREADTH_WEIGHT = .20;
    private static final double PROMINENCE_WEIGHT = .15;
    private static final double EXAM_WEIGHT = .25;

    private static final double AUTHORED_WEIGHT = .40;
    private static final double DEPTH_WEIGHT = .25;
    private static final double OBSERVED_WEIGHT = .35;

    /**
     * What the corpus says about one topic.
     *
     * @param chunks passages bound to the topic, kept for the reader; the ratio uses {@code bindingWeight}
     * @param bindingWeight those bindings summed by confidence, so ten uncertain mentions do not outrank five
     *     certain ones
     * @param documents distinct documents mentioning it — a topic in the notes, the homework and the past exam is
     *     more central to the course than one confined to a single handout
     * @param headingSections sections whose own title names it, which is a stronger claim than being mentioned
     */
    public record Coverage(int chunks, double bindingWeight, int documents, int headingSections) {}

    /**
     * What the corpus is, so one topic's coverage can be read as a share rather than as a raw count.
     *
     * @param documents completed documents in the course
     * @param busiestBindingWeight the largest {@code bindingWeight} any topic in the course has, so coverage is
     *     relative to the course's own busiest topic instead of to an absolute that means nothing across courses
     * @param structuredSections sections in the course with a derived heading. Zero means no document has been
     *     structured, so structural prominence is unmeasured for every topic rather than zero for all of them
     */
    public record Corpus(int documents, double busiestBindingWeight, int structuredSections) {}

    /**
     * What the course itself asks of the topic, independent of how any learner has done on it.
     *
     * @param authoredDifficulty mean difficulty of the questions the course's own documents set on this topic —
     *     the examiner's demand, not the ladder's. Null when no such question exists, which is not the same as
     *     easy
     * @param authoredItems how many questions that average is over
     * @param prerequisiteDepth longest chain of prerequisites ending at this topic. Null when the course has no
     *     prerequisite edges at all, so depth is unmeasured; 0 means measured, and this topic starts a chain
     */
    public record Demand(Double authoredDifficulty, int authoredItems, Integer prerequisiteDepth) {}

    /**
     * One graded attempt, as the evidence of difficulty it is.
     *
     * @param supportUsed hints revealed before answering; {@code supportRungs} is how many there were to reveal.
     *     A right answer that needed all of them is not the same evidence as one that needed none, which is why
     *     the score alone is not what gets averaged.
     */
    public record Observation(double score, int supportUsed, int supportRungs) {}

    /**
     * Both figures and the counted inputs behind them, so a stored number can be read back and argued with.
     *
     * @param importance 0..1 or {@link #UNMEASURED}
     * @param difficulty 0..1 or {@link #UNMEASURED} when none of its three components could be measured
     * @param observed the attempts component on its own, {@link #UNMEASURED} below {@link #MIN_OBSERVATIONS}
     * @param meanScore the plain average score, measured from a single attempt even though {@code observed} is not
     * @param assistanceShare the average share of available hints used, {@link #UNMEASURED} with no attempts
     */
    public record Assessment(double importance, double difficulty, double observed, int observations, double meanScore,
                             double assistanceShare, Coverage coverage, Corpus corpus, Double examRelevance, Demand demand) {}

    public static Assessment assess(Coverage coverage, Corpus corpus, Double examRelevance, Demand demand, List<Observation> observations) {
        List<Observation> seen = clean(observations);
        double meanScore = seen.isEmpty() ? UNMEASURED : seen.stream().mapToDouble(observation -> clamp(observation.score())).average().orElse(UNMEASURED);
        double assistance = seen.isEmpty() ? UNMEASURED : seen.stream().mapToDouble(TopicModel::assistance).average().orElse(UNMEASURED);
        return new Assessment(importance(coverage, corpus, examRelevance), difficulty(demand, seen), observedDifficulty(seen),
                seen.size(), meanScore, assistance, coverage, corpus, examRelevance, demand);
    }

    /**
     * How central the topic is to this course, on the components that could be measured.
     *
     * <p>Exam relevance is one component among four rather than the whole figure. A course with no past exams
     * still has topics worth ranking, and a topic the examiner has never set is not thereby unimportant — it may
     * simply be this year's material.
     */
    public static double importance(Coverage coverage, Corpus corpus, Double examRelevance) {
        if (coverage == null || corpus == null) return UNMEASURED;
        double weighted = 0;
        double weight = 0;
        if (corpus.busiestBindingWeight() > 0) { weighted += COVERAGE_WEIGHT * clamp(coverage.bindingWeight() / corpus.busiestBindingWeight()); weight += COVERAGE_WEIGHT; }
        if (corpus.documents() > 0) { weighted += BREADTH_WEIGHT * clamp((double) coverage.documents() / corpus.documents()); weight += BREADTH_WEIGHT; }
        if (corpus.structuredSections() > 0) { weighted += PROMINENCE_WEIGHT * diminishing(coverage.headingSections()); weight += PROMINENCE_WEIGHT; }
        if (examRelevance != null) { weighted += EXAM_WEIGHT * clamp(examRelevance); weight += EXAM_WEIGHT; }
        return weight <= 0 ? UNMEASURED : clamp(weighted / weight);
    }

    /**
     * How much the topic demands, from what the course sets on it, where it sits in the prerequisite chain, and
     * how much trouble it has actually given.
     *
     * <p>Three components rather than attempts alone, because in a workspace with one learner "difficulty
     * measured from that learner's attempts" is very nearly their mastery read backwards, and the model would
     * then have two names for one number. The authored and depth components are properties of the topic that hold
     * before anyone has attempted anything, which is exactly when a learner most needs to be told what is hard.
     */
    public static double difficulty(Demand demand, List<Observation> observations) {
        List<Observation> seen = clean(observations);
        double observed = observedDifficulty(seen);
        double weighted = 0;
        double weight = 0;
        if (demand != null && demand.authoredDifficulty() != null && demand.authoredItems() > 0) { weighted += AUTHORED_WEIGHT * clamp(demand.authoredDifficulty()); weight += AUTHORED_WEIGHT; }
        if (demand != null && demand.prerequisiteDepth() != null) { weighted += DEPTH_WEIGHT * diminishing(demand.prerequisiteDepth()); weight += DEPTH_WEIGHT; }
        if (observed != UNMEASURED) { weighted += OBSERVED_WEIGHT * observed; weight += OBSERVED_WEIGHT; }
        return weight <= 0 ? UNMEASURED : clamp(weighted / weight);
    }

    /**
     * The attempts component: how much trouble the topic has given, shrunk toward the middle by how few attempts
     * there are. {@link #UNMEASURED} until {@link #MIN_OBSERVATIONS} of them exist.
     *
     * <p>Deliberately not adjusted for the difficulty of the items attempted. That figure is the level generation
     * aimed at, and folding it in would credit the topic for the ladder's choices: a topic only ever assessed at
     * recall level would come out looking hard the moment the ladder raised it. What the course itself sets on the
     * topic is a separate component, where the demand is the examiner's rather than StudyOS's own.
     */
    public static double observedDifficulty(List<Observation> observations) {
        List<Observation> seen = clean(observations);
        if (seen.size() < MIN_OBSERVATIONS) return UNMEASURED;
        double sum = 0;
        for (Observation observation : seen) sum += observed(observation);
        return clamp((sum + .5 * SHRINK) / (seen.size() + SHRINK));
    }

    /**
     * What one attempt says about the topic's difficulty. A perfect unaided answer says zero; a wrong answer says
     * one; a perfect answer that needed every hint says half, because half of it was the hints.
     */
    public static double observed(Observation observation) {
        if (observation == null) return UNMEASURED;
        return clamp(1 - clamp(observation.score()) * (1 - ASSIST_DISCOUNT * assistance(observation)));
    }

    /**
     * Diminishing returns on a count. The first heading is most of what structural prominence has to say — the
     * topic is what a section of the course is <em>about</em> — and the tenth adds little; the first prerequisite
     * is most of what depth has to say, and the fifth link in the chain little more than the fourth.
     */
    private static double diminishing(int count) { return 1 - 1.0 / (1 + Math.max(0, count)); }

    private static double assistance(Observation observation) {
        return observation.supportRungs() <= 0 ? 0 : clamp((double) observation.supportUsed() / observation.supportRungs());
    }

    private static List<Observation> clean(List<Observation> observations) {
        return observations == null ? List.<Observation>of() : observations.stream().filter(Objects::nonNull).toList();
    }

    static double clamp(double value) { return Math.max(0, Math.min(1, value)); }
}
