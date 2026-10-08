package com.studyos.mastery;

/**
 * Difficulty, stability and retrievability for one topic — the FSRS scheduling model, as pure arithmetic.
 *
 * <p>Replaces a fixed table of review intervals. "Mastery is high, so come back in fourteen days" says the
 * same thing about a topic answered correctly once and a topic answered correctly six times over two months,
 * and it says nothing at all about how hard that topic has been for this learner. FSRS keeps two numbers per
 * topic instead: <em>difficulty</em>, how much work each correct answer buys, and <em>stability</em>, the
 * number of days after which recall probability has fallen to ninety percent. Retrievability then follows from
 * stability and elapsed time, and the next review date follows from the retention the schedule is aiming at.
 *
 * <p>Subject-general by construction: every input is a grade, an elapsed time, or a prior state. Nothing here
 * knows what was being reviewed, so the same model schedules a language course and a proof-based one.
 *
 * <p>The weights are the published FSRS-4.5 defaults, fitted over hundreds of millions of reviews. They are
 * defaults, not truths — the per-attempt retrievability and post-review stability are recorded on each attempt
 * so they can one day be refitted for an individual learner.
 */
public final class SpacedRepetition {
    /** Grades, worst to best. A lapse is {@link #AGAIN}; everything else counts as recall. */
    public static final int AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

    /** The retention a schedule aims for: review when recall probability has fallen to this. */
    public static final double TARGET_RETENTION = .9;

    /**
     * Exponent of the forgetting curve. Negative one half makes recall decay as a power law rather than an
     * exponential, which is the point: forgetting slows down as material ages, so an exponential curve
     * understates what a learner still knows about something they studied a term ago.
     */
    private static final double DECAY = -.5;
    /** Chosen so that {@code retrievability(stability, stability)} is exactly {@value #TARGET_RETENTION}. */
    private static final double FACTOR = Math.pow(.9, 1 / DECAY) - 1;

    /** FSRS-4.5 default weights: initial stability per grade, then difficulty, recall and lapse terms. */
    private static final double[] W = {
            .4872, 1.4003, 3.7145, 13.8206,   // 0-3  initial stability for AGAIN, HARD, GOOD, EASY
            5.1618, 1.2298,                    // 4-5  initial difficulty and how far a grade moves it from the outset
            .8975, .0310,                      // 6-7  difficulty change and its reversion to the easy anchor
            1.6474, .1367, 1.0461,             // 8-10 stability growth after recall
            2.1072, .0793, .3246, 1.5870,      // 11-14 stability after a lapse
            .2272, 2.8755};                    // 15-16 penalty for a hard recall, bonus for an easy one

    private static final double MINIMUM_STABILITY = .01, MAXIMUM_STABILITY = 36500;
    private static final double MINIMUM_DIFFICULTY = 1, MAXIMUM_DIFFICULTY = 10;

    private SpacedRepetition() {}

    /**
     * Probability of recall {@code elapsedDays} after a review that left the topic at {@code stabilityDays}.
     * A topic reviewed just now reads one; stability is the elapsed time at which it reads nine tenths.
     */
    public static double retrievability(double elapsedDays, double stabilityDays) {
        double elapsed = Math.max(0, elapsedDays);
        double stability = clampStability(stabilityDays);
        return Math.pow(1 + FACTOR * elapsed / stability, DECAY);
    }

    /** Days until recall probability falls to {@code targetRetention} from a topic at {@code stabilityDays}. */
    public static double intervalDays(double stabilityDays, double targetRetention) {
        double target = Math.max(.5, Math.min(.99, targetRetention));
        return clampStability(stabilityDays) / FACTOR * (Math.pow(target, 1 / DECAY) - 1);
    }

    /**
     * The grade a graded attempt earns. A score is continuous and a grade is not, so the thresholds are the
     * only judgement in this class; they read the way a marker would, with a near-perfect answer as easy and
     * anything under half as a lapse.
     *
     * <p>Support caps the grade. An answer produced after the next step was handed over is not evidence of
     * easy recall whatever it scored, and treating it as such is how a schedule pushes a topic out to a
     * fortnight that the learner could not actually retrieve unaided.
     */
    public static int grade(double score, int supportLevelUsed) {
        double bounded = BetaEvidenceModel.clamp(score);
        int earned = bounded < .5 ? AGAIN : bounded < .7 ? HARD : bounded < .9 ? GOOD : EASY;
        int ceiling = supportLevelUsed <= 0 ? EASY : supportLevelUsed == 1 ? GOOD : HARD;
        return Math.min(earned, ceiling);
    }

    /** The state a topic is in after its first graded attempt, with no history to update from. */
    public static State first(int grade) {
        int bounded = boundedGrade(grade);
        return new State(initialDifficulty(bounded), clampStability(W[bounded - 1]));
    }

    /**
     * The state after another graded attempt, {@code elapsedDays} since the previous one.
     *
     * <p>Both halves of the update are driven by how surprising the result was. Recalling something whose
     * retrievability had dropped low is strong evidence and buys a large increase in stability; recalling
     * something reviewed yesterday buys almost none. A lapse resets stability towards a small value scaled by
     * difficulty rather than to zero, because a topic once known is relearned faster than one never known.
     */
    public static State next(State current, int grade, double elapsedDays) {
        if (current == null) return first(grade);
        int bounded = boundedGrade(grade);
        double retrievability = current.retrievability(elapsedDays);
        double difficulty = nextDifficulty(current.difficulty(), bounded);
        double stability = bounded == AGAIN
                ? lapsedStability(difficulty, current.stability(), retrievability)
                : recalledStability(difficulty, current.stability(), retrievability, bounded);
        return new State(difficulty, clampStability(Math.min(stability, MAXIMUM_STABILITY)));
    }

    /** Difficulty of a topic graded for the first time: an easy first answer starts it low, a lapse high. */
    private static double initialDifficulty(int grade) { return clampDifficulty(W[4] - W[5] * (grade - GOOD)); }

    /**
     * Difficulty moves against the grade and is then pulled back towards the value an easy first answer would
     * have set. Without that reversion a run of hard-won correct answers ratchets a topic to permanently
     * maximal difficulty and it never leaves the review queue.
     */
    private static double nextDifficulty(double current, int grade) {
        double moved = current - W[6] * (grade - GOOD) * (MAXIMUM_DIFFICULTY - current) / 9;
        return clampDifficulty(W[7] * initialDifficulty(EASY) + (1 - W[7]) * moved);
    }

    private static double recalledStability(double difficulty, double stability, double retrievability, int grade) {
        double hardPenalty = grade == HARD ? W[15] : 1;
        double easyBonus = grade == EASY ? W[16] : 1;
        double growth = Math.exp(W[8]) * (11 - difficulty) * Math.pow(stability, -W[9])
                * (Math.exp(W[10] * (1 - retrievability)) - 1) * hardPenalty * easyBonus;
        return stability * (1 + growth);
    }

    /** A lapse never raises stability, whatever the terms work out to. */
    private static double lapsedStability(double difficulty, double stability, double retrievability) {
        double relearned = W[11] * Math.pow(difficulty, -W[12]) * (Math.pow(stability + 1, W[13]) - 1)
                * Math.exp(W[14] * (1 - retrievability));
        return Math.min(relearned, stability);
    }

    private static int boundedGrade(int grade) { return Math.max(AGAIN, Math.min(EASY, grade)); }
    private static double clampStability(double value) {
        return Double.isFinite(value) ? Math.max(MINIMUM_STABILITY, Math.min(MAXIMUM_STABILITY, value)) : MINIMUM_STABILITY;
    }
    private static double clampDifficulty(double value) {
        return Double.isFinite(value) ? Math.max(MINIMUM_DIFFICULTY, Math.min(MAXIMUM_DIFFICULTY, value)) : MINIMUM_DIFFICULTY;
    }

    /** What one topic's schedule is made of: how hard it is, and how long recall of it lasts. */
    public record State(double difficulty, double stability) {
        public double retrievability(double elapsedDays) { return SpacedRepetition.retrievability(elapsedDays, stability); }
        /** Whole days until the next review, never less than one: a schedule cannot ask for the same day twice. */
        public int reviewInDays() { return (int) Math.max(1, Math.round(intervalDays(stability, TARGET_RETENTION))); }
    }
}
