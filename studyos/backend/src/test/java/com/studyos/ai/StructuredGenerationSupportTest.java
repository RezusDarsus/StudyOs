package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The bounded continuation contract: exactly one attempt, only for truncation, only when the shared
 * request deadline can still afford a provider call, and a clean structured failure when it does
 * not work out.
 */
class StructuredGenerationSupportTest {
    private static final GenerationPolicy POLICY = new GenerationPolicy(AiOperation.QUIZ_GENERATION, "model", 2048, .1, 1, false, GenerationPolicy.ResponseMode.JSON);
    private final ObjectMapper mapper = new ObjectMapper();
    private final StructuredOutputNormalizer normalizer = new StructuredOutputNormalizer(mapper);

    @BeforeEach void start() { ProviderCallTelemetry.reset(); }
    @AfterEach void finish() { ProviderCallTelemetry.clear(); RequestDeadline.clear(); }

    private AiResult<String> raw(String text) { return new AiResult<>(text, 100, 50, 150, "model", "length", 0); }

    @Test void truncatedResponseIsCompletedByOneContinuation() {
        AtomicInteger calls = new AtomicInteger();
        var provider = (StructuredGenerationSupport.Provider) (system, user, policy) -> {
            calls.incrementAndGet();
            return new AiResult<>("4\"}]}", 10, 5, 15, "model", "stop", 0);
        };
        AiResult<QuizBatch> result = StructuredGenerationSupport.parseStructured(mapper, provider, POLICY,
                raw("{\"questions\":[{\"prompt\":\"What is 2+2?\",\"answer\":\""), QuizBatch.class, normalizer);
        assertThat(result.value().questions()).hasSize(1);
        assertThat(result.value().questions().getFirst().answer()).isEqualTo("4");
        assertThat(calls.get()).isEqualTo(1);
        var snapshot = ProviderCallTelemetry.snapshot();
        assertThat(snapshot.continuationAttempts()).isEqualTo(1);
        assertThat(snapshot.continuationSuccesses()).isEqualTo(1);
    }

    @Test void aModelThatRestartsTheWholeDocumentIsUsedOnlyWhenTheContinuationReadingFails() {
        var provider = (StructuredGenerationSupport.Provider) (system, user, policy) ->
                new AiResult<>("{\"questions\":[{\"prompt\":\"Full restart\",\"answer\":\"A\"}]}", 10, 5, 15, "model", "stop", 0);
        AiResult<QuizBatch> result = StructuredGenerationSupport.parseStructured(mapper, provider, POLICY,
                raw("{\"questions\":[{\"prompt\":\"What is 2+2?\""), QuizBatch.class, normalizer);
        assertThat(result.value().questions()).hasSize(1);
        assertThat(result.value().questions().getFirst().prompt()).isEqualTo("Full restart");
    }

    @Test void failedContinuationThrowsTheTruncationFailureAfterExactlyOneAttempt() {
        AtomicInteger calls = new AtomicInteger();
        var provider = (StructuredGenerationSupport.Provider) (system, user, policy) -> {
            calls.incrementAndGet();
            return new AiResult<>("this is not json at all", 10, 5, 15, "model", "stop", 0);
        };
        assertThatThrownBy(() -> StructuredGenerationSupport.parseStructured(mapper, provider, POLICY,
                raw("{\"questions\":[{\"prompt\":\"Q\",\"answer\":\""), QuizBatch.class, normalizer))
                .isInstanceOf(StructuredGenerationException.class)
                .satisfies(error -> assertThat(((StructuredGenerationException) error).failure()).isEqualTo(StructuredOutputFailure.TRUNCATED));
        assertThat(calls.get()).isEqualTo(1);
        var snapshot = ProviderCallTelemetry.snapshot();
        assertThat(snapshot.continuationAttempts()).isEqualTo(1);
        assertThat(snapshot.continuationSuccesses()).isZero();
        assertThat(snapshot.structuredFailures()).contains("truncated:1");
    }

    @Test void aSpentDeadlineNeverSpendsAContinuationCall() {
        AtomicInteger calls = new AtomicInteger();
        var provider = (StructuredGenerationSupport.Provider) (system, user, policy) -> { calls.incrementAndGet(); return raw("\"answer\":\"4\"}]"); };
        RequestDeadline.start(Duration.ofMillis(50));
        assertThatThrownBy(() -> StructuredGenerationSupport.parseStructured(mapper, provider, POLICY,
                raw("{\"questions\":[{\"prompt\":\"What is 2+2?\""), QuizBatch.class, normalizer))
                .isInstanceOf(StructuredGenerationException.class);
        assertThat(calls.get()).isZero();
        assertThat(ProviderCallTelemetry.snapshot().continuationAttempts()).isZero();
    }

    @Test void nonTruncatedFailuresNeverTriggerAContinuation() {
        AtomicInteger calls = new AtomicInteger();
        var provider = (StructuredGenerationSupport.Provider) (system, user, policy) -> { calls.incrementAndGet(); return raw("ignored"); };
        assertThatThrownBy(() -> StructuredGenerationSupport.parseStructured(mapper, provider, POLICY,
                new AiResult<>("{\"foo\":\"bar\"}", 100, 50, 150, "model", "stop", 0), QuizBatch.class, normalizer))
                .isInstanceOf(StructuredGenerationException.class);
        assertThat(calls.get()).isZero();
    }

    @Test void exactParsesAreCountedSeparatelyFromRepairs() {
        var provider = (StructuredGenerationSupport.Provider) (system, user, policy) -> raw("unused");
        StructuredGenerationSupport.parseStructured(mapper, provider, POLICY,
                new AiResult<>("{\"questions\":[{\"prompt\":\"Q\",\"answer\":\"A\"}]}", 1, 1, 2, "model", "stop", 0), QuizBatch.class, normalizer);
        var snapshot = ProviderCallTelemetry.snapshot();
        assertThat(snapshot.structuredRequests()).isEqualTo(1);
        assertThat(snapshot.structuredExactParses()).isEqualTo(1);
        assertThat(snapshot.structuredLocalRepairs()).isZero();
        assertThat(snapshot.repairRate()).isZero();
    }

    @Test void repairedParsesRaiseTheRepairRateInsteadOfHidingIt() {
        var provider = (StructuredGenerationSupport.Provider) (system, user, policy) -> raw("unused");
        StructuredGenerationSupport.parseStructured(mapper, provider, POLICY,
                new AiResult<>("{\"prompt\":\"Q\",\"answer\":\"A\"}", 1, 1, 2, "model", "stop", 0), QuizBatch.class, normalizer);
        var snapshot = ProviderCallTelemetry.snapshot();
        assertThat(snapshot.structuredLocalRepairs()).isEqualTo(1);
        assertThat(snapshot.repairRate()).isEqualTo(1.0);
        assertThat(snapshot.repairKinds()).contains("wrapped_single_object:1");
    }

    /** The quiz batch under test; kept local so the support test stays decoupled from services. */
    record QuizBatch(java.util.List<QuestionDraft> questions) {
        @com.fasterxml.jackson.annotation.JsonCreator QuizBatch(@com.fasterxml.jackson.annotation.JsonProperty("questions") java.util.List<QuestionDraft> questions) { this.questions = questions == null ? java.util.List.of() : questions; }
    }
    record QuestionDraft(String prompt, String answer) {}
}
