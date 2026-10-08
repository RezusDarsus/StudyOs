package com.studyos.mastery;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

/**
 * How much of a measured mastery a learner still has, this many days after they last worked on the topic.
 *
 * <p>The decay is {@link SpacedRepetition}'s forgetting curve, so a topic decays at the rate its own review
 * history earned. A fixed curve for every topic is what this replaced, and it was wrong in both directions at
 * once: it forgot a topic proved six times as fast as one scraped through yesterday, and it kept insisting a
 * term-old topic was nearly gone when the power-law tail says otherwise.
 */
public final class RetentionModel {
    /**
     * The stability assumed for a topic with no measured one — the stability a single adequate answer earns.
     * A topic studied but never graded has to decay somehow, and it should decay like weakly-held material.
     */
    public static final double DEFAULT_STABILITY_DAYS = SpacedRepetition.first(SpacedRepetition.GOOD).stability();

    /**
     * Retention never reads as fully gone. What a learner retains of something they once knew is not nothing,
     * and a floor of zero would erase the topic from every ranking that multiplies mastery by retention —
     * turning "studied a year ago" into "never studied", which is the one thing it certainly is not.
     */
    private static final double FLOOR = .2;

    private RetentionModel() {}

    public static double retention(Instant anchor, Instant now) { return retention(anchor, now, DEFAULT_STABILITY_DAYS); }

    public static double retention(Instant anchor, Instant now, double stabilityDays) {
        double days = elapsedDays(anchor, now);
        double stability = stabilityDays > 0 && Double.isFinite(stabilityDays) ? stabilityDays : DEFAULT_STABILITY_DAYS;
        return Math.max(FLOOR, SpacedRepetition.retrievability(days, stability));
    }

    public static double effectiveMastery(double measuredMastery, Instant anchor, Instant now) {
        return effectiveMastery(measuredMastery, anchor, now, DEFAULT_STABILITY_DAYS);
    }

    public static double effectiveMastery(double measuredMastery, Instant anchor, Instant now, double stabilityDays) {
        return measuredMastery * retention(anchor, now, stabilityDays);
    }

    /** Fractional, so retention measured an hour after an attempt still reads as an hour and not as a day. */
    private static double elapsedDays(Instant anchor, Instant now) {
        if (anchor == null || now == null) return 0;
        return Math.max(0, ChronoUnit.MINUTES.between(anchor, now) / 1440.0);
    }
}
