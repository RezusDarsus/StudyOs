package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.assessment.QuizService;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Drives the real gateway structured path — prompt contract, normalization, repair metadata, bounded
 * continuation — with the HTTP transport replaced by fixtures. This is the seam every service calls.
 */
class NvidiaGatewayStructuredPathTest {
    private final ObjectMapper mapper = new ObjectMapper();

    private record Fixture(String text, String finishReason) {
        Fixture(String text) { this(text, "stop"); }
    }

    /** The gateway under test with its transport stubbed to one fixture per call. */
    private static final class FixtureGateway extends NvidiaGateway {
        final List<Fixture> fixtures;
        final AtomicInteger calls = new AtomicInteger();
        String lastSystemPrompt;

        FixtureGateway(ObjectMapper mapper, List<Fixture> fixtures) {
            super("test-key", "chat-model", "embedding-model", 2048, false, mapper);
            this.fixtures = fixtures;
        }

        @Override public AiResult<String> generateResult(String systemPrompt, String userPrompt, GenerationPolicy policy) {
            lastSystemPrompt = systemPrompt;
            Fixture fixture = fixtures.get(Math.min(calls.getAndIncrement(), fixtures.size() - 1));
            return new AiResult<>(fixture.text(), 100, 40, 140, "chat-model", fixture.finishReason(), 0);
        }
    }

    @BeforeEach void start() { ProviderCallTelemetry.reset(); }
    @AfterEach void finish() { ProviderCallTelemetry.clear(); RequestDeadline.clear(); }

    @Test void validJsonParsesExactlyWithThePromptContractAppended() {
        FixtureGateway gateway = new FixtureGateway(mapper, List.of(new Fixture("{\"questions\":[{\"prompt\":\"Q1\",\"answer\":\"A1\"}]}")));
        AiResult<QuizService.QuestionBatch> result = gateway.generateStructuredResult("system", "user", QuizService.QuestionBatch.class);
        assertThat(result.value().questions()).hasSize(1);
        assertThat(result.structuredParseSuccess()).isTrue();
        assertThat(result.structuredRepairUsed()).isFalse();
        assertThat(gateway.lastSystemPrompt).contains("Return only valid JSON").contains("markdown");
        assertThat(ProviderCallTelemetry.snapshot().structuredExactParses()).isEqualTo(1);
    }

    @Test void fencedAndProseWrappedResponsesAreRepairedInsideTheGateway() {
        FixtureGateway gateway = new FixtureGateway(mapper, List.of(new Fixture("Here you go:\n```json\n{\"questions\":[{\"prompt\":\"Q1\",\"answer\":\"A1\"}]}\n```")));
        AiResult<QuizService.QuestionBatch> result = gateway.generateStructuredResult("system", "user", QuizService.QuestionBatch.class);
        assertThat(result.value().questions()).hasSize(1);
        assertThat(result.structuredRepairUsed()).isTrue();
        assertThat(ProviderCallTelemetry.snapshot().repairKinds()).contains("stripped_code_fence:1");
    }

    @Test void aBareSingleQuestionObjectIsWrappedInsteadOfSilentlyEmptied() {
        FixtureGateway gateway = new FixtureGateway(mapper, List.of(new Fixture("{\"prompt\":\"Q1\",\"answer\":\"A1\"}")));
        AiResult<QuizService.QuestionBatch> result = gateway.generateStructuredResult("system", "user", QuizService.QuestionBatch.class);
        assertThat(result.value().questions()).hasSize(1);
        assertThat(result.structuredRepairUsed()).isTrue();
    }

    @Test void ambiguousOutputThrowsWithTheStructuredFailureClassified() {
        FixtureGateway gateway = new FixtureGateway(mapper, List.of(new Fixture("{\"questions\":[]} {\"questions\":[]}")));
        assertThatThrownBy(() -> gateway.generateStructuredResult("system", "user", QuizService.QuestionBatch.class))
                .isInstanceOf(StructuredGenerationException.class)
                .satisfies(error -> {
                    StructuredGenerationException structured = (StructuredGenerationException) error;
                    assertThat(structured.failure()).isEqualTo(StructuredOutputFailure.MULTIPLE_JSON_PAYLOADS);
                    assertThat(structured.truncated()).isFalse();
                    assertThat(structured.telemetryResult().structuredParseSuccess()).isFalse();
                });
    }

    @Test void aTruncatedBatchCostsAtMostOneContinuationCallInsideTheGateway() {
        FixtureGateway gateway = new FixtureGateway(mapper, List.of(
                new Fixture("{\"questions\":[{\"prompt\":\"Q1\",\"answer\":\"", "length"),
                new Fixture("4\"}]}")));
        AiResult<QuizService.QuestionBatch> result = gateway.generateStructuredResult("system", "user", QuizService.QuestionBatch.class);
        assertThat(result.value().questions()).hasSize(1);
        assertThat(gateway.calls.get()).isEqualTo(2);
        assertThat(ProviderCallTelemetry.snapshot().continuationSuccesses()).isEqualTo(1);
    }
}
