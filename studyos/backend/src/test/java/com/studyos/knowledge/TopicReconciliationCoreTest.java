package com.studyos.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class TopicReconciliationCoreTest {

    private TopicReconciliationCore.CandidateTopic topic(String name) {
        return topic(name, List.of(), null, Set.of());
    }

    private TopicReconciliationCore.CandidateTopic topic(String name, List<String> aliases, float[] embedding, Set<String> context) {
        return new TopicReconciliationCore.CandidateTopic(name, name, aliases, embedding, context);
    }

    @Test
    void exactNormalizedMatchMerges() {
        TopicReconciliationCore.Verdict verdict = TopicReconciliationCore.evaluate(topic("Vector Clocks"), topic("vector clocks!"));
        assertThat(verdict.decision()).isEqualTo(ReconciliationDecision.SAME);
        assertThat(verdict.confidence()).isEqualTo(1.0);
        assertThat(verdict.stages()).anyMatch(stage -> "EXACT".equals(stage.stage()) && stage.matched());
    }

    @Test
    void registeredAliasMerges() {
        TopicReconciliationCore.Verdict verdict = TopicReconciliationCore.evaluate(
                topic("Inversion of Control"),
                topic("IoC", List.of("Inversion of Control"), null, Set.of()));
        assertThat(verdict.decision()).isEqualTo(ReconciliationDecision.SAME);
        assertThat(verdict.confidence()).isGreaterThanOrEqualTo(0.95);
    }

    @Test
    void sameTokensDifferentWordingMerges() {
        TopicReconciliationCore.Verdict verdict = TopicReconciliationCore.evaluate(
                topic("tuning of hyperparameters"), topic("hyperparameter tuning"));
        assertThat(verdict.decision()).isEqualTo(ReconciliationDecision.SAME);
        assertThat(verdict.reason()).contains("different wording");
    }

    @Test
    void multiTokenContainmentMerges() {
        // The canonical case from the problem statement: research extracts the longer phrase,
        // the curriculum holds the shorter one — same concept, must fold together.
        TopicReconciliationCore.Verdict verdict = TopicReconciliationCore.evaluate(
                topic("Dependency Injection"), topic("Dependency Injection and Inversion of Control"));
        assertThat(verdict.decision()).isEqualTo(ReconciliationDecision.SAME);
        assertThat(verdict.confidence()).isGreaterThanOrEqualTo(TopicReconciliationCore.MERGE_CONFIDENCE);
    }

    @Test
    void singleTokenContainmentNeverMerges() {
        assertThat(TopicReconciliationCore.evaluate(topic("gradient"), topic("gradient descent")).decision())
                .isEqualTo(ReconciliationDecision.DIFFERENT);
        assertThat(TopicReconciliationCore.evaluate(topic("gene"), topic("gene expression")).decision())
                .isEqualTo(ReconciliationDecision.DIFFERENT);
    }

    @Test
    void relatedButDistinctControlsStaySeparateEvenWithStrongVectors() {
        float[] left = unit(0.9f, 0.9f, 0.1f, 0.1f);
        float[] right = unit(0.9f, 0.1f, 0.9f, 0.1f);
        // Force a very strong vector so the guard, not weak evidence, is what refuses the merge.
        TopicReconciliationCore.Verdict verdict = TopicReconciliationCore.evaluate(
                topic("TCP flow control", List.of(), left, Set.of("window", "acknowledgement", "sender")),
                topic("TCP congestion control", List.of(), scale(left, right), Set.of("window", "loss", "router")));
        assertThat(verdict.decision()).isEqualTo(ReconciliationDecision.DIFFERENT);
        assertThat(verdict.reason()).contains("too few concepts");
    }

    @Test
    void strongEmbeddingWithoutContextOverlapStaysAmbiguous() {
        float[] vector = unit(0.5f, 0.5f, 0.7f);
        TopicReconciliationCore.Verdict verdict = TopicReconciliationCore.evaluate(
                topic("distributed consensus raft protocol", List.of(), vector, Set.of("bully", "ring")),
                topic("distributed consensus raft paxos", List.of(), scale(vector, vector), Set.of("raft", "term")));
        assertThat(verdict.decision()).isEqualTo(ReconciliationDecision.AMBIGUOUS);
    }

    @Test
    void embeddingAndContextAgreementMergesWhenLexicallyClose() {
        float[] vector = unit(0.5f, 0.5f, 0.7f);
        Set<String> context = Set.of("consensus", "raft", "quorum", "term");
        TopicReconciliationCore.Verdict verdict = TopicReconciliationCore.evaluate(
                topic("distributed consensus raft protocol", List.of(), vector, context),
                topic("distributed consensus raft quorum", List.of(), scale(vector, vector), context));
        assertThat(verdict.decision()).isEqualTo(ReconciliationDecision.SAME);
    }

    @Test
    void cosineOfMissingVectorsAbstains() {
        assertThat(TopicReconciliationCore.cosine(null, new float[]{1f})).isZero();
        assertThat(TopicReconciliationCore.cosine(new float[]{1f}, new float[]{1f, 2f})).isZero();
        assertThat(TopicReconciliationCore.cosine(new float[]{1f, 0f}, new float[]{1f, 0f})).isEqualTo(1.0, within(1e-6));
    }

    private static org.assertj.core.data.Offset<Double> within(double tolerance) {
        return org.assertj.core.data.Offset.offset(tolerance);
    }

    @Test
    void pluralFoldingCountsAsSameTokens() {
        assertThat(TopicReconciliationCore.evaluate(topic("Lamport clocks"), topic("lamport clock")).decision())
                .isEqualTo(ReconciliationDecision.SAME);
    }

    @Test
    void verdictCarriesScoresForAudit() {
        float[] vector = unit(1f, 2f, 3f);
        TopicReconciliationCore.Verdict verdict = TopicReconciliationCore.evaluate(
                topic("routing", List.of(), vector, Set.of("bgp")),
                topic("routing", List.of(), vector, Set.of("bgp")));
        assertThat(verdict.lexicalScore()).isEqualTo(1.0);
        assertThat(verdict.stages()).isNotEmpty();
    }

    @Test
    void contextTermsExtractSignificantWords() {
        Set<String> terms = TopicReconciliationCore.contextTerms("Raft elects a leader using terms and quorums; quorums confirm the leader. Terms increase monotonically.", 3);
        assertThat(terms).contains("leader");
        assertThat(terms.size()).isLessThanOrEqualTo(3);
        assertThat(terms).doesNotContain("using", "with", "the");
    }

    private static float[] unit(float... values) {
        double norm = 0;
        for (float value : values) norm += value * value;
        norm = Math.sqrt(norm);
        float[] result = new float[values.length];
        for (int index = 0; index < values.length; index++) result[index] = (float) (values[index] / norm);
        return result;
    }

    /** A vector deliberately made extremely similar to {@code left} so only guards can refuse. */
    private static float[] scale(float[] left, float[] right) {
        float[] blended = new float[left.length];
        for (int index = 0; index < left.length; index++) blended[index] = left[index] * 0.98f + (right[index % right.length]) * 0.02f;
        return unit(blended);
    }
}
