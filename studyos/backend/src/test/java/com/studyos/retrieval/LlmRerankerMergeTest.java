package com.studyos.retrieval;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class LlmRerankerMergeTest {
    private static Map<Integer, Double> scores(double... values) {
        Map<Integer, Double> relevance = new LinkedHashMap<>();
        for (int index = 0; index < values.length; index++) if (values[index] >= 0) relevance.put(index, values[index]);
        return relevance;
    }

    @Test void aPassageTheModelRatesHighestComesFirst() {
        assertThat(LlmRerankerProvider.merge(3, scores(.1, .2, .9))).containsExactly(2, 0, 1);
    }

    /**
     * The model sees a fragment of each passage and nothing of the course, so it is not allowed to overturn
     * retrieval outright: its favourite rises, but a confident mistake cannot bury what both halves of the
     * search agreed on.
     */
    @Test void theModelMovesTheOrderRatherThanReplacingIt() {
        assertThat(LlmRerankerProvider.merge(4, scores(.5, -1, -1, 1))).containsExactly(0, 1, 3, 2);
    }

    /** A candidate the model never mentioned keeps the place term evidence gave it. */
    @Test void anUnscoredCandidateKeepsItsPosition() {
        assertThat(LlmRerankerProvider.merge(3, scores(-1, -1, -1))).containsExactly(0, 1, 2);
    }

    /** Reordering, never filtering: everything handed in comes back, so nothing is silently dropped. */
    @Test void everyCandidateSurvivesTheMerge() {
        assertThat(LlmRerankerProvider.merge(5, scores(0, 0, 0, 0, 0))).containsExactlyInAnyOrder(0, 1, 2, 3, 4);
        assertThat(LlmRerankerProvider.merge(1, scores(.9))).containsExactly(0);
        assertThat(LlmRerankerProvider.merge(0, scores())).isEmpty();
    }

    /** Equal model scores leave the term ranking standing, so the merge adds no arbitrariness of its own. */
    @Test void equalScoresPreserveTheIncomingOrder() {
        assertThat(LlmRerankerProvider.merge(3, scores(.5, .5, .5))).containsExactly(0, 1, 2);
    }
}
