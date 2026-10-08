package com.studyos.prediction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.studyos.prediction.TopicHistoryFeatures.CourseStats;
import com.studyos.prediction.TopicHistoryFeatures.Context;
import com.studyos.prediction.TopicHistoryFeatures.DecayShape;
import com.studyos.prediction.TopicHistoryFeatures.Vector;
import com.studyos.prediction.TopicHistoryFeatures.Weights;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The history features for the EXAM_TOPIC_V2 experiment, against hand-computed cases. Each feature
 * answers one measured question: trend, spacing, exam position, style compatibility, emphasis,
 * unlock value, and the deliberately weak omission nudge. All features are training-slice-only by
 * construction; the leak protection lives in the engine and is tested there.
 */
class TopicHistoryFeaturesTest {

    private static final CourseStats STATS = new CourseStats(6, 0.25, 10, 6, 3, 0.8);
    private static final Weights W = Weights.V2_CANDIDATE;

    @Test
    void momentumSeparatesRecentTopicsFromOldFrequentOnes() {
        // Appeared on the last 2 exams only: strong momentum, weak overall frequency.
        Vector recent = compute(Map.of(4, 0.2, 5, 0.2));
        // Appeared early, same total appearances: no momentum.
        Vector old = compute(Map.of(0, 0.2, 1, 0.2));

        assertThat(recent.momentum()).isCloseTo(2.0 / 3, within(1e-9));
        assertThat(old.momentum()).isEqualTo(0);
        assertThat(recent.frequencyRate()).isCloseTo(old.frequencyRate(), within(1e-9));
        // Under a DECAYING recency rate, the recent topic outranks the old one at equal frequency.
        // (Under NONE the two are identical by design — recency rate collapses to frequency.)
        Vector recentDecayed = TopicHistoryFeatures.compute(Map.of(4, 0.2, 5, 0.2), 6, context(), STATS, DecayShape.HALF_LIFE_2);
        Vector oldDecayed = TopicHistoryFeatures.compute(Map.of(0, 0.2, 1, 0.2), 6, context(), STATS, DecayShape.HALF_LIFE_2);
        assertThat(recentDecayed.recencyRate()).isGreaterThan(oldDecayed.recencyRate());
    }

    @Test
    void decayShapesSeparateRecentTopicsFromStaleOnes() {
        // Under NONE the two histories are indistinguishable (both 2 of 6). Decay shapes must open
        // exactly that gap: a steeper shape rewards the recent-only topic and punishes the stale one.
        Map<Integer, Double> recentOnly = Map.of(4, 0.2, 5, 0.2);
        Map<Integer, Double> oldOnly = Map.of(0, 0.2, 1, 0.2);
        assertThat(recency(recentOnly, DecayShape.NONE)).isCloseTo(recency(oldOnly, DecayShape.NONE), within(1e-9));
        assertThat(recency(recentOnly, DecayShape.HALF_LIFE_2)).isGreaterThan(recency(oldOnly, DecayShape.HALF_LIFE_2));
        assertThat(recency(oldOnly, DecayShape.HALF_LIFE_2)).isLessThan(recency(oldOnly, DecayShape.NONE));
        assertThat(recency(recentOnly, DecayShape.HALF_LIFE_2)).isGreaterThan(recency(recentOnly, DecayShape.NONE));
    }

    @Test
    void spacingRegularityRewardsSteadyRecurrence() {
        // Every second exam: perfectly regular gaps × 3/6 prevalence.
        Vector everySecond = compute(Map.of(0, 0.1, 2, 0.1, 4, 0.1));
        // Three appearances with scattered gaps (0,1,5): irregular.
        Vector irregular = compute(Map.of(0, 0.1, 1, 0.1, 5, 0.1));
        assertThat(everySecond.spacingRegularity()).isCloseTo(0.5, within(1e-9));
        assertThat(irregular.spacingRegularity()).isLessThan(everySecond.spacingRegularity());
        // A single appearance carries no pattern information: neutral regularity × 1/6 prevalence.
        assertThat(compute(Map.of(3, 0.1)).spacingRegularity()).isCloseTo(0.5 / 6, within(1e-9));
    }

    @Test
    void examPositionBeatsOccurrenceCountAtEqualFrequency() {
        // Both appear once; one carried 20 points (0.2 share), the other 2 points (0.02 share).
        Vector heavy = compute(Map.of(5, 0.2));
        Vector light = compute(Map.of(5, 0.02), new CourseStats(6, 0.25, 10, 6, 3, 0.8));
        assertThat(heavy.averagePointsShare()).isGreaterThan(light.averagePointsShare());
        assertThat(TopicHistoryFeatures.score(heavy, W)).isGreaterThan(TopicHistoryFeatures.score(light, W));
    }

    @Test
    void styleCompatibilityFollowsObjectivesAndRecentExamMix() {
        Context applied = new Context(1.0, List.of(), 0, 0, false, null);
        Context recall = new Context(0.0, List.of(), 0, 0, false, null);
        CourseStats problemHeavy = new CourseStats(6, 0.25, 10, 6, 3, 0.8);
        CourseStats recallHeavy = new CourseStats(6, 0.25, 10, 6, 3, 0.1);
        Map<Integer, Double> history = Map.of(5, 0.1);
        double appliedOnProblems = TopicHistoryFeatures.compute(history, 6, applied, problemHeavy, DecayShape.NONE).styleCompatibility();
        double recallOnProblems = TopicHistoryFeatures.compute(history, 6, recall, problemHeavy, DecayShape.NONE).styleCompatibility();
        double appliedOnRecall = TopicHistoryFeatures.compute(history, 6, applied, recallHeavy, DecayShape.NONE).styleCompatibility();
        assertThat(appliedOnProblems).isGreaterThan(recallOnProblems);
        assertThat(appliedOnProblems).isGreaterThan(appliedOnRecall);
        // Unknown objectives are neutral, not zero and not full.
        double unknown = TopicHistoryFeatures.compute(history, 6, new Context(null, List.of(), 0, 0, false, null), problemHeavy, DecayShape.NONE).styleCompatibility();
        assertThat(unknown).isBetween(recallOnProblems, appliedOnProblems);

    }

    @Test
    void unlockCentralityCountsOnlyHistoricallyTestedDependents() {
        // Contract: the engine passes dependents already intersected with topics that appeared in
        // training exams, and the course maximum counts only tested dependents.
        UUID tested = UUID.randomUUID();
        CourseStats stats = new CourseStats(6, 0.25, 0, 0, 1, 0.5);
        Context unlocksOneTested = new Context(null, List.of(tested), 0, 0, false, null);
        Vector v = TopicHistoryFeatures.compute(Map.of(0, 0.1), 6, unlocksOneTested, stats, DecayShape.NONE);
        assertThat(v.unlockCentrality()).isEqualTo(1.0);
        Context unlocksNothing = new Context(null, List.of(), 0, 0, false, null);
        Vector none = TopicHistoryFeatures.compute(Map.of(0, 0.1), 6, unlocksNothing, stats, DecayShape.NONE);
        assertThat(none.unlockCentrality()).isEqualTo(0);
    }

    @Test
    void omissionPressureIsBoundedAndNeverFiresForNeverSeenTopics() {
        // Taught (importance 1, homework, lecture) but absent for 4+ exams after prior appearances.
        Context taught = new Context(null, List.of(), 10, 6, false, 1.0);
        Vector absent = TopicHistoryFeatures.compute(Map.of(0, 0.1, 1, 0.1), 6, taught, STATS, DecayShape.NONE);
        assertThat(absent.omissionPressure()).isCloseTo(1.0, within(1e-9));
        // Appeared on the most recent exam: no pressure.
        Vector current = TopicHistoryFeatures.compute(Map.of(5, 0.1), 6, taught, STATS, DecayShape.NONE);
        assertThat(current.omissionPressure()).isEqualTo(0);
        // Never appeared: zero, always — absence of a first appearance is not an omission.
        Vector neverSeen = TopicHistoryFeatures.compute(Map.of(), 6, taught, STATS, DecayShape.NONE);
        assertThat(neverSeen.omissionPressure()).isEqualTo(0);
        // Even at full pressure the term is small by weight: the gambler's-fallacy guard.
        double contribution = W.omission() * absent.omissionPressure();
        assertThat(contribution).isLessThanOrEqualTo(0.05);
    }

    @Test
    void emphasisStaysThreeSeparateSignals() {
        Context homeworkOnly = new Context(null, List.of(), 10, 0, false, null);
        Context lectureOnly = new Context(null, List.of(), 0, 6, false, null);
        Context syllabusOnly = new Context(null, List.of(), 0, 0, true, null);
        Vector hw = compute(Map.of(5, 0.1), homeworkOnly, STATS);
        Vector le = compute(Map.of(5, 0.1), lectureOnly, STATS);
        Vector sy = compute(Map.of(5, 0.1), syllabusOnly, STATS);
        assertThat(hw.homeworkShare()).isEqualTo(1.0);
        assertThat(le.homeworkShare()).isEqualTo(0);
        assertThat(le.lectureShare()).isEqualTo(1.0);
        assertThat(sy.syllabusShare()).isEqualTo(1.0);
        // Emphasis signals are independent: adding lecture evidence on top of homework raises the score.
        Context both = new Context(null, List.of(), 10, 6, false, null);
        Vector bothVector = compute(Map.of(5, 0.1), both, STATS);
        assertThat(TopicHistoryFeatures.score(bothVector, W)).isGreaterThan(TopicHistoryFeatures.score(hw, W));
    }

    @Test
    void scoresAreDeterministicAndBounded() {
        Vector v = compute(Map.of(1, 0.2, 3, 0.2, 5, 0.2));
        double first = TopicHistoryFeatures.score(v, W);
        double second = TopicHistoryFeatures.score(v, W);
        assertThat(first).isEqualTo(second);
        assertThat(first).isBetween(0.0, 1.0);
    }

    private Vector compute(Map<Integer, Double> appearances) {
        return compute(appearances, STATS);
    }

    private Vector compute(Map<Integer, Double> appearances, CourseStats stats) {
        return compute(appearances, new Context(0.5, List.of(), 0, 0, false, null), stats);
    }

    private Vector compute(Map<Integer, Double> appearances, Context context) {
        return compute(appearances, context, STATS);
    }

    private Vector compute(Map<Integer, Double> appearances, Context context, CourseStats stats) {
        return TopicHistoryFeatures.compute(appearances, 6, context, stats, DecayShape.NONE);
    }

    private Context context() {
        return new Context(0.5, List.of(), 0, 0, false, null);
    }

    private double recency(Map<Integer, Double> appearances, DecayShape shape) {
        return TopicHistoryFeatures.compute(appearances, 6, context(), STATS, shape).recencyRate();
    }
}
