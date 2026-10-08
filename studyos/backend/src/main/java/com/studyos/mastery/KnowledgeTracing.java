package com.studyos.mastery;

/**
 * Bayesian knowledge tracing: the probability that this learner knows a topic, given what they have answered.
 *
 * <p>The Beta model next to this one counts evidence — it asks how much of the work has been right, and how
 * much work there has been. That is the right long-run estimate and the wrong reading of a single answer,
 * because it takes every answer at face value. A correct answer to an easy item may be a guess; a wrong answer
 * on a topic the learner has proved six times is more likely a slip than forgetting. Knowledge tracing puts
 * those two possibilities in the model, so one lucky answer moves the estimate less than one earned answer and
 * one careless mistake does not erase a term of evidence.
 *
 * <p>The two live together deliberately. {@link BetaEvidenceModel} produces the calibrated mastery figure and
 * its confidence, which is what a plan should be built from; this produces the probability that the learner
 * could answer right now, which is what deciding whether to test them should turn on.
 *
 * <p>Nothing here is subject-specific: guess and slip come from the item's difficulty and from how much help
 * was used, both of which are recorded for every attempt in every course.
 */
public final class KnowledgeTracing {
    /**
     * Where a topic starts before any attempt. Low, because assuming a learner knows something unseen is how a
     * planner skips it — but not zero, because a topic never assessed is not a topic known to be missing, and
     * this figure must never be reported as a measurement. Callers store it only once a real attempt exists.
     */
    public static final double PRIOR_KNOWN = .25;

    /** Guess probability at the extremes of difficulty: a trivial item is often answerable without knowing. */
    private static final double GUESS_FLOOR = .05, GUESS_RANGE = .30;
    /** Slip probability at the extremes: a demanding item is fumbled sometimes even when the topic is known. */
    private static final double SLIP_FLOOR = .05, SLIP_RANGE = .20;
    /** How much of the remaining gap full support closes towards a certain guess. */
    private static final double SUPPORT_SHARE = .5;
    /** Support levels beyond this add nothing further; the answer was handed over either way. */
    private static final double FULL_SUPPORT = 3;
    /** Probability that attempting a topic once, with feedback, teaches it. */
    private static final double TRANSIT = .10;
    /**
     * The estimate never reaches certainty in either direction. An absorbing state is not a belief: once a
     * topic reads one, no wrong answer can ever move it again, and the model stops learning from the learner.
     */
    private static final double FLOOR = .01, CEILING = .99;

    private KnowledgeTracing() {}

    /** The estimate for a topic with no recorded attempt, which no caller should present as measured. */
    public static Estimate unassessed() { return new Estimate(PRIOR_KNOWN, PRIOR_KNOWN, 0, 0, 0); }

    /**
     * The posterior probability of knowing the topic after one graded attempt.
     *
     * <p>A partly correct answer is read as what it is — part evidence of knowing and part evidence of not —
     * by mixing the two posteriors in the score's proportion. A score of exactly one or zero therefore reduces
     * to ordinary knowledge tracing, and a half-marked answer moves the estimate half as far as either.
     */
    public static Estimate update(double priorKnown, double score, double difficulty, int supportLevelUsed) {
        double prior = bounded(priorKnown);
        double correctness = BetaEvidenceModel.clamp(score);
        double difficultyBounded = BetaEvidenceModel.clamp(difficulty);
        double guess = guess(difficultyBounded, supportLevelUsed);
        double slip = slip(difficultyBounded);
        double posterior = correctness * posteriorAfterCorrect(prior, guess, slip)
                + (1 - correctness) * posteriorAfterWrong(prior, guess, slip);
        double learned = bounded(posterior + (1 - posterior) * TRANSIT);
        return new Estimate(learned, prior, guess, slip, posterior);
    }

    /** Bayes, with a correct answer explainable either by knowing the topic or by guessing it. */
    private static double posteriorAfterCorrect(double prior, double guess, double slip) {
        double knowing = prior * (1 - slip);
        double guessing = (1 - prior) * guess;
        return knowing + guessing <= 0 ? prior : knowing / (knowing + guessing);
    }

    /** Bayes, with a wrong answer explainable either by not knowing the topic or by slipping. */
    private static double posteriorAfterWrong(double prior, double guess, double slip) {
        double slipping = prior * slip;
        double notKnowing = (1 - prior) * (1 - guess);
        return slipping + notKnowing <= 0 ? prior : slipping / (slipping + notKnowing);
    }

    /**
     * How likely a correct answer is without knowing the topic. Falls with difficulty, and rises with the help
     * used: an answer reached after the next step was supplied is much more explainable without knowledge, so
     * crediting it as fully as an unaided one is how a topic reads as mastered on the strength of the hints.
     */
    public static double guess(double difficulty, int supportLevelUsed) {
        double base = GUESS_FLOOR + GUESS_RANGE * (1 - BetaEvidenceModel.clamp(difficulty));
        double support = Math.min(FULL_SUPPORT, Math.max(0, supportLevelUsed)) / FULL_SUPPORT;
        return bounded(base + (1 - base) * SUPPORT_SHARE * support);
    }

    /** How likely a wrong answer is despite knowing the topic. Rises with difficulty. */
    public static double slip(double difficulty) { return SLIP_FLOOR + SLIP_RANGE * BetaEvidenceModel.clamp(difficulty); }

    private static double bounded(double value) {
        return Double.isFinite(value) ? Math.max(FLOOR, Math.min(CEILING, value)) : PRIOR_KNOWN;
    }

    /**
     * @param known     probability the learner knows the topic after this attempt and whatever it taught
     * @param prior     the probability this update started from
     * @param posterior the probability explained by the answer alone, before crediting the attempt as practice
     */
    public record Estimate(double known, double prior, double guess, double slip, double posterior) {
        public double change() { return known - prior; }
    }
}
