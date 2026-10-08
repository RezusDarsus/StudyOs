package com.studyos.prediction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class PredictionMetricsTest {
    private static final UUID A = UUID.randomUUID();
    private static final UUID B = UUID.randomUUID();
    private static final UUID C = UUID.randomUUID();
    private static final UUID D = UUID.randomUUID();

    private static PredictionMetrics.ScoredTopic scored(UUID id, double probability) {
        return new PredictionMetrics.ScoredTopic(id, probability);
    }

    @Test
    void precisionAndRecallAtK() {
        var ranked = List.of(scored(A, .9), scored(B, .7), scored(C, .5), scored(D, .1));
        var actual = Set.of(A, C);
        assertThat(PredictionMetrics.precisionAtK(ranked, actual, 2)).isEqualTo(.5);
        assertThat(PredictionMetrics.precisionAtK(ranked, actual, 4)).isEqualTo(.5);
        assertThat(PredictionMetrics.recallAtK(ranked, actual, 2)).isEqualTo(.5);
        assertThat(PredictionMetrics.recallAtK(ranked, actual, 3)).isEqualTo(1.0);
        assertThat(PredictionMetrics.precisionAtK(ranked, Set.of(), 3)).isZero();
        assertThat(PredictionMetrics.precisionAtK(List.of(), actual, 3)).isZero();
    }

    @Test
    void reciprocalRank() {
        var ranked = List.of(scored(A, .9), scored(B, .7), scored(C, .5));
        assertThat(PredictionMetrics.reciprocalRank(ranked, Set.of(B))).isEqualTo(1.0 / 2, within(1e-9));
        assertThat(PredictionMetrics.reciprocalRank(ranked, Set.of(UUID.randomUUID()))).isZero();
    }

    @Test
    void ndcgMatchesHandComputation() {
        var ranked = List.of(scored(A, .9), scored(B, .7), scored(C, .5));
        var actual = Set.of(B, C);
        // DCG = 1/log2(3) + 1/log2(4); IDCG = 1/log2(2) + 1/log2(3)
        double dcg = 1 / (Math.log(3) / Math.log(2)) + 1 / (Math.log(4) / Math.log(2));
        double idcg = 1 + 1 / (Math.log(3) / Math.log(2));
        assertThat(PredictionMetrics.ndcgAtK(ranked, actual, 3)).isCloseTo(dcg / idcg, within(1e-9));
        assertThat(PredictionMetrics.ndcgAtK(ranked, Set.of(A), 1)).isEqualTo(1.0);
    }

    @Test
    void spearmanDetectsMonotoneAndInverse() {
        assertThat(PredictionMetrics.spearman(List.of(1.0, 2.0, 3.0, 4.0), List.of(10.0, 20.0, 30.0, 40.0))).isCloseTo(1.0, within(1e-9));
        assertThat(PredictionMetrics.spearman(List.of(1.0, 2.0, 3.0, 4.0), List.of(40.0, 30.0, 20.0, 10.0))).isCloseTo(-1.0, within(1e-9));
        assertThat(PredictionMetrics.spearman(List.of(1.0), List.of(1.0))).isZero();
        assertThat(PredictionMetrics.spearman(List.of(1.0, 1.0, 1.0), List.of(1.0, 2.0, 3.0))).isZero();
    }

    @Test
    void brierScoresPerfectAndUselessPredictors() {
        var perfect = List.of(new PredictionMetrics.PredictionOutcome(.9, true), new PredictionMetrics.PredictionOutcome(.1, false));
        assertThat(PredictionMetrics.brierScore(perfect)).isLessThan(0.05);
        var wrong = List.of(new PredictionMetrics.PredictionOutcome(.9, false), new PredictionMetrics.PredictionOutcome(.1, true));
        assertThat(PredictionMetrics.brierScore(wrong)).isGreaterThan(0.8);
        assertThat(PredictionMetrics.brierScore(List.of())).isZero();
    }

    @Test
    void calibrationBucketsExposeOverconfidence() {
        // Predictions around 0.8 that only come true 54% of the time: the spec's own example.
        List<PredictionMetrics.PredictionOutcome> outcomes = new java.util.ArrayList<>();
        int highPredictions = 0;
        for (int index = 0; index < 200; index++) {
            boolean occurred = highPredictions % 100 < 54;
            outcomes.add(new PredictionMetrics.PredictionOutcome(0.75 + (index % 3) * 0.02, occurred));
            highPredictions++;
            outcomes.add(new PredictionMetrics.PredictionOutcome(0.15, false));
        }
        var buckets = PredictionMetrics.calibrationBuckets(outcomes, 0.1);
        var highBucket = buckets.stream().filter(bucket -> bucket.from() >= 0.7).findFirst().orElseThrow();
        assertThat(highBucket.observedRate()).isEqualTo(0.54, within(0.01));
        assertThat(highBucket.meanPredicted()).isGreaterThan(0.7);
        assertThat(PredictionMetrics.calibrationError(buckets)).isGreaterThan(0.1);
    }

    @Test
    void bucketWithNoMembersIsOmitted() {
        var buckets = PredictionMetrics.calibrationBuckets(List.of(new PredictionMetrics.PredictionOutcome(.95, true)), 0.1);
        assertThat(buckets).hasSize(1);
        assertThat(buckets.get(0).from()).isEqualTo(.9, within(1e-9));
    }

    @Test
    void sortedRankingIsDescending() {
        var sorted = PredictionMetrics.sorted(List.of(scored(A, .1), scored(B, .9), scored(C, .5)));
        assertThat(sorted).extracting(PredictionMetrics.ScoredTopic::topicId).containsExactly(B, C, A);
    }
}
