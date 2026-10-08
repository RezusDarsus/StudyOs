package com.studyos.mastery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import org.junit.jupiter.api.Test;

class SpacedRepetitionTest {
    /** The curve's defining property: stability is by definition the interval at which recall is nine tenths. */
    @Test void stabilityIsTheIntervalAtWhichRecallHasFallenToTheTargetRetention() {
        for (double stability : new double[] {1, 3.5, 21, 400})
            assertThat(SpacedRepetition.retrievability(stability, stability)).isCloseTo(SpacedRepetition.TARGET_RETENTION, within(.0001));
        assertThat(SpacedRepetition.retrievability(0, 10)).isEqualTo(1);
    }

    /** Scheduling and the curve are two readings of one model, so the interval must land back on the target. */
    @Test void theScheduledIntervalIsWhereTheCurveReachesTheTarget() {
        for (double stability : new double[] {2, 12, 90}) {
            double days = SpacedRepetition.intervalDays(stability, SpacedRepetition.TARGET_RETENTION);
            assertThat(days).isCloseTo(stability, within(.0001));
            assertThat(SpacedRepetition.retrievability(days, stability)).isCloseTo(.9, within(.0001));
        }
        assertThat(SpacedRepetition.intervalDays(30, .95)).isLessThan(SpacedRepetition.intervalDays(30, .8));
    }

    /** Forgetting slows as material ages: the second week costs less recall than the first. */
    @Test void decayIsAPowerLawRatherThanAnExponential() {
        double first = SpacedRepetition.retrievability(0, 7) - SpacedRepetition.retrievability(7, 7);
        double second = SpacedRepetition.retrievability(7, 7) - SpacedRepetition.retrievability(14, 7);
        assertThat(second).isLessThan(first);
        assertThat(SpacedRepetition.retrievability(3650, 7)).isGreaterThan(0);
    }

    @Test void aBetterGradeStartsATopicEasierAndMoreStable() {
        var again = SpacedRepetition.first(SpacedRepetition.AGAIN);
        var good = SpacedRepetition.first(SpacedRepetition.GOOD);
        var easy = SpacedRepetition.first(SpacedRepetition.EASY);
        assertThat(again.stability()).isLessThan(good.stability());
        assertThat(good.stability()).isLessThan(easy.stability());
        assertThat(again.difficulty()).isGreaterThan(good.difficulty()).isGreaterThan(easy.difficulty());
        assertThat(easy.difficulty()).isBetween(1.0, 10.0);
    }

    /**
     * The reason the model exists. Recalling something that had nearly faded is strong evidence and earns a
     * long interval; recalling something reviewed the same day earns almost nothing, however right the answer.
     */
    @Test void recallOfNearlyForgottenMaterialEarnsMoreStabilityThanRecallOfFreshMaterial() {
        var state = new SpacedRepetition.State(5, 10);
        double fromFaded = SpacedRepetition.next(state, SpacedRepetition.GOOD, 30).stability();
        double fromFresh = SpacedRepetition.next(state, SpacedRepetition.GOOD, 0).stability();
        assertThat(fromFaded).isGreaterThan(fromFresh);
        assertThat(fromFresh).isGreaterThanOrEqualTo(state.stability());
    }

    @Test void aLapseNeverRaisesStabilityAndAHarderGradeRaisesItLess() {
        var state = new SpacedRepetition.State(5, 20);
        assertThat(SpacedRepetition.next(state, SpacedRepetition.AGAIN, 20).stability()).isLessThan(state.stability());
        double hard = SpacedRepetition.next(state, SpacedRepetition.HARD, 20).stability();
        double good = SpacedRepetition.next(state, SpacedRepetition.GOOD, 20).stability();
        double easy = SpacedRepetition.next(state, SpacedRepetition.EASY, 20).stability();
        assertThat(hard).isLessThan(good);
        assertThat(good).isLessThan(easy);
    }

    /** A lapse must leave the topic relearnable rather than pinned at maximum difficulty forever. */
    @Test void difficultyMovesWithTheGradeAndStaysInsideItsBounds() {
        var state = new SpacedRepetition.State(5, 20);
        assertThat(SpacedRepetition.next(state, SpacedRepetition.AGAIN, 5).difficulty()).isGreaterThan(state.difficulty());
        assertThat(SpacedRepetition.next(state, SpacedRepetition.EASY, 5).difficulty()).isLessThan(state.difficulty());
        var lapsing = new SpacedRepetition.State(9.9, 20);
        for (int review = 0; review < 40; review++) lapsing = SpacedRepetition.next(lapsing, SpacedRepetition.AGAIN, 5);
        assertThat(lapsing.difficulty()).isBetween(1.0, 10.0);
        var mastered = new SpacedRepetition.State(1.1, 20);
        for (int review = 0; review < 40; review++) mastered = SpacedRepetition.next(mastered, SpacedRepetition.EASY, 30);
        assertThat(mastered.difficulty()).isGreaterThanOrEqualTo(1);
        assertThat(mastered.stability()).isLessThanOrEqualTo(36500);
    }

    /** A hard topic gains less from the same answer than an easy one, which is what difficulty is for. */
    @Test void aHarderTopicGainsLessStabilityFromTheSameRecall() {
        double hardTopic = SpacedRepetition.next(new SpacedRepetition.State(9, 10), SpacedRepetition.GOOD, 10).stability();
        double easyTopic = SpacedRepetition.next(new SpacedRepetition.State(2, 10), SpacedRepetition.GOOD, 10).stability();
        assertThat(hardTopic).isLessThan(easyTopic);
    }

    @Test void gradesFollowTheScoreAndAreCappedByTheHelpUsed() {
        assertThat(SpacedRepetition.grade(1, 0)).isEqualTo(SpacedRepetition.EASY);
        assertThat(SpacedRepetition.grade(.8, 0)).isEqualTo(SpacedRepetition.GOOD);
        assertThat(SpacedRepetition.grade(.6, 0)).isEqualTo(SpacedRepetition.HARD);
        assertThat(SpacedRepetition.grade(.2, 0)).isEqualTo(SpacedRepetition.AGAIN);
        assertThat(SpacedRepetition.grade(1, 1)).isEqualTo(SpacedRepetition.GOOD);
        assertThat(SpacedRepetition.grade(1, 3)).isEqualTo(SpacedRepetition.HARD);
        assertThat(SpacedRepetition.grade(.2, 3)).isEqualTo(SpacedRepetition.AGAIN);
        assertThat(SpacedRepetition.grade(5, -2)).isEqualTo(SpacedRepetition.EASY);
    }

    /** A schedule cannot ask for a review the same day, and a lapsed topic must come back soon. */
    @Test void everyScheduleAsksForAtLeastOneDayAndALapsedTopicComesBackFirst() {
        assertThat(SpacedRepetition.first(SpacedRepetition.AGAIN).reviewInDays()).isEqualTo(1);
        assertThat(SpacedRepetition.first(SpacedRepetition.EASY).reviewInDays()).isGreaterThan(SpacedRepetition.first(SpacedRepetition.GOOD).reviewInDays());
        assertThat(new SpacedRepetition.State(5, .001).reviewInDays()).isEqualTo(1);
    }

    /** A first attempt has no history to update from, so a missing prior state is the initial state. */
    @Test void aMissingPriorStateIsTheFirstReview() {
        assertThat(SpacedRepetition.next(null, SpacedRepetition.GOOD, 12)).isEqualTo(SpacedRepetition.first(SpacedRepetition.GOOD));
    }

    /** Repeated successful review has to reach months, or the schedule never stops asking about known material. */
    @Test void sustainedRecallGrowsIntervalsIntoMonths() {
        var state = SpacedRepetition.first(SpacedRepetition.GOOD);
        for (int review = 0; review < 6; review++) state = SpacedRepetition.next(state, SpacedRepetition.GOOD, state.reviewInDays());
        assertThat(state.reviewInDays()).isGreaterThan(60);
    }
}
