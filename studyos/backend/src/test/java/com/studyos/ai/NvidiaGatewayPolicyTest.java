package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class NvidiaGatewayPolicyTest {
    @Test
    void explicitlyDisablesThinkingWhenPolicyTurnsItOff() {
        NvidiaGateway gateway = new NvidiaGateway("test-key", "chat-model", "embedding-model", 2048, false, new ObjectMapper());

        var body = gateway.generationBody("chat-model", .2, 1, 1600, false, "system", "user");

        assertThat(body.at("/chat_template_kwargs/enable_thinking").asBoolean()).isFalse();
        assertThat(body.has("reasoning_budget")).isFalse();
        assertThat(body.path("max_tokens").asInt()).isEqualTo(1600);
    }

    @Test
    void enablesThinkingWithABoundedReasoningBudget() {
        NvidiaGateway gateway = new NvidiaGateway("test-key", "chat-model", "embedding-model", 4096, true, new ObjectMapper());

        var body = gateway.generationBody("chat-model", 1, .95, 4096, true, "system", "user");

        assertThat(body.at("/chat_template_kwargs/enable_thinking").asBoolean()).isTrue();
        assertThat(body.path("reasoning_budget").asInt()).isEqualTo(2048);
    }

    @Test
    void sendsNativeJsonObjectModeForJsonPolicies() {
        NvidiaGateway gateway = new NvidiaGateway("test-key", "chat-model", "embedding-model", 2048, false, new ObjectMapper());
        var body=gateway.generationBody("chat-model",.1,1,2048,false,GenerationPolicy.ResponseMode.JSON,"Return JSON","user");
        assertThat(body.at("/response_format/type").asText()).isEqualTo("json_object");
    }

    @Test
    void keepsQueryAndPassageEmbeddingModesDistinct() {
        NvidiaGateway gateway = new NvidiaGateway("test-key", "chat-model", "embedding-model", 2048, false, new ObjectMapper());
        assertThat(gateway.embeddingBody(java.util.List.of("search"),EmbeddingInputType.QUERY).path("input_type").asText()).isEqualTo("query");
        assertThat(gateway.embeddingBody(java.util.List.of("chunk"),EmbeddingInputType.PASSAGE).path("input_type").asText()).isEqualTo("passage");
    }

    @Test
    void retriesEmptyHostedEndpoint404ButNotARealModelNotFoundResponse() {
        NvidiaGateway gateway = new NvidiaGateway("test-key", "chat-model", "embedding-model", 2048, false, new ObjectMapper());

        assertThat(gateway.transientStatus(404, "")).isTrue();
        assertThat(gateway.transientStatus(404, "   ")).isTrue();
        assertThat(gateway.transientStatus(404, "{\"detail\":\"model not found\"}")).isFalse();
    }

    @Test
    void retriesStandardTransientProviderStatusesWithBoundedBackoff() {
        NvidiaGateway gateway = new NvidiaGateway("test-key", "chat-model", "embedding-model", 2048, false, new ObjectMapper());

        assertThat(gateway.transientStatus(408, "timeout")).isTrue();
        assertThat(gateway.transientStatus(429, "rate limited")).isTrue();
        assertThat(gateway.transientStatus(500, "upstream failure")).isTrue();
        assertThat(gateway.retryDelayMillis(1, null)).isEqualTo(250);
        assertThat(gateway.retryDelayMillis(4, null)).isEqualTo(2000);
        assertThat(gateway.retryDelayMillis(1, "3")).isEqualTo(3000);
    }

    @Test
    void credentialAndConfigurationFailuresNeverEnterRetryLoops() {
        NvidiaGateway gateway = new NvidiaGateway("test-key", "chat-model", "embedding-model", 2048, false, new ObjectMapper());

        assertThat(gateway.transientStatus(401, "{\"detail\":\"invalid api key\"}")).isFalse();
        assertThat(gateway.transientStatus(403, "{\"detail\":\"forbidden\"}")).isFalse();
        assertThat(ProviderFailureClassification.fromStatus(401, "unauthorized")).isEqualTo(ProviderFailureClassification.CREDENTIALS_OR_CONFIG);
        assertThat(ProviderFailureClassification.fromStatus(403, "forbidden")).isEqualTo(ProviderFailureClassification.CREDENTIALS_OR_CONFIG);
        assertThat(ProviderFailureClassification.fromStatus(401, "unauthorized").transientlyRetryable()).isFalse();
    }

    @Test
    void modelNotFoundIsConfigurationWhileEmpty404StaysTransient() {
        NvidiaGateway gateway = new NvidiaGateway("test-key", "chat-model", "embedding-model", 2048, false, new ObjectMapper());

        assertThat(ProviderFailureClassification.fromStatus(404, "{\"detail\":\"model not found\"}"))
                .isEqualTo(ProviderFailureClassification.MODEL_OR_ROUTE_NOT_FOUND);
        assertThat(ProviderFailureClassification.fromStatus(404, "{\"detail\":\"model not found\"}").transientlyRetryable()).isFalse();
        assertThat(ProviderFailureClassification.fromStatus(404, "")).isEqualTo(ProviderFailureClassification.HOSTED_ENDPOINT_EMPTY_404);
        assertThat(ProviderFailureClassification.fromStatus(404, "").transientlyRetryable()).isTrue();
    }

    @Test
    void throttlingAndProviderOutagesAreTransientWithReasons() {
        assertThat(ProviderFailureClassification.fromStatus(429, "slow down")).isEqualTo(ProviderFailureClassification.RATE_LIMITED);
        assertThat(ProviderFailureClassification.fromStatus(502, "bad gateway")).isEqualTo(ProviderFailureClassification.PROVIDER_TRANSIENT);
        assertThat(ProviderFailureClassification.fromStatus(503, "unavailable")).isEqualTo(ProviderFailureClassification.PROVIDER_TRANSIENT);
        assertThat(ProviderFailureClassification.fromStatus(504, "gateway timeout")).isEqualTo(ProviderFailureClassification.PROVIDER_TRANSIENT);
        assertThat(ProviderFailureClassification.fromStatus(429, "slow down").transientlyRetryable()).isTrue();
        assertThat(ProviderFailureClassification.fromStatus(503, "unavailable").transientlyRetryable()).isTrue();
    }

    @Test
    void timeoutsAndNetworkErrorsClassifyWithoutExposingProviderInternals() {
        assertThat(ProviderFailureClassification.fromThrowable(new java.net.http.HttpTimeoutException("timed out")))
                .isEqualTo(ProviderFailureClassification.TIMEOUT);
        assertThat(ProviderFailureClassification.fromThrowable(new java.io.IOException("connection reset")))
                .isEqualTo(ProviderFailureClassification.NETWORK);
        assertThat(ProviderFailureClassification.fromThrowable(new RuntimeException("mystery")))
                .isEqualTo(ProviderFailureClassification.UNKNOWN);
    }
}
