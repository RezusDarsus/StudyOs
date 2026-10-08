package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ProviderCallTelemetryTest {
    @BeforeEach void start() { ProviderCallTelemetry.reset(); }
    @AfterEach void finish() { ProviderCallTelemetry.clear(); }

    @Test
    void countsEveryUpstreamAttemptAndTheTransientFailuresItRetriedThrough() {
        ProviderCallTelemetry.call(ProviderCallTelemetry.Kind.CHAT);
        ProviderCallTelemetry.attempt();
        ProviderCallTelemetry.transientFailure(404, "blank-body");
        ProviderCallTelemetry.attempt();
        ProviderCallTelemetry.transientFailure(503, "http");
        ProviderCallTelemetry.attempt();

        var snapshot = ProviderCallTelemetry.snapshot();

        assertThat(snapshot.upstreamCalls()).isEqualTo(1);
        assertThat(snapshot.upstreamAttempts()).isEqualTo(3);
        assertThat(snapshot.retries()).isEqualTo(2);
        assertThat(snapshot.transientFailures()).isEqualTo(2);
        assertThat(snapshot.transientDetail()).isEqualTo("404:blank-body 503:http");
    }

    @Test
    void separatesDistinctCallsFromRetriesSoAHealthyTurnReportsNoRetries() {
        ProviderCallTelemetry.call(ProviderCallTelemetry.Kind.EMBEDDING);
        ProviderCallTelemetry.attempt();
        ProviderCallTelemetry.call(ProviderCallTelemetry.Kind.CHAT);
        ProviderCallTelemetry.attempt();
        ProviderCallTelemetry.call(ProviderCallTelemetry.Kind.CHAT);
        ProviderCallTelemetry.attempt();

        var snapshot = ProviderCallTelemetry.snapshot();

        assertThat(snapshot.upstreamCalls()).isEqualTo(3);
        assertThat(snapshot.chatCalls()).isEqualTo(2);
        assertThat(snapshot.embeddingCalls()).isEqualTo(1);
        assertThat(snapshot.upstreamAttempts()).isEqualTo(3);
        assertThat(snapshot.retries()).isZero();
        assertThat(snapshot.transientFailures()).isZero();
    }

    @Test
    void separatesTurnsSoOneReplyNeverInheritsAnEarlierRequestsAttempts() {
        ProviderCallTelemetry.call(ProviderCallTelemetry.Kind.CHAT);
        ProviderCallTelemetry.attempt();
        ProviderCallTelemetry.transientFailure(500, "http");

        ProviderCallTelemetry.reset();
        ProviderCallTelemetry.call(ProviderCallTelemetry.Kind.CHAT);
        ProviderCallTelemetry.attempt();

        assertThat(ProviderCallTelemetry.snapshot().upstreamCalls()).isEqualTo(1);
        assertThat(ProviderCallTelemetry.snapshot().upstreamAttempts()).isEqualTo(1);
        assertThat(ProviderCallTelemetry.snapshot().transientFailures()).isZero();
    }

    @Test
    void reportsEmptyCountersOutsideARequestInsteadOfFailing() {
        ProviderCallTelemetry.clear();
        ProviderCallTelemetry.call(ProviderCallTelemetry.Kind.CHAT);
        ProviderCallTelemetry.attempt();

        assertThat(ProviderCallTelemetry.snapshot()).isEqualTo(ProviderCallTelemetry.Snapshot.empty());
    }

    @Test
    void recordsTransportFailuresThatCarryNoUpstreamStatus() {
        ProviderCallTelemetry.transientFailure(null, "timeout");

        assertThat(ProviderCallTelemetry.snapshot().transientDetail()).isEqualTo("timeout");
    }

    @Test
    void structuredCountersSplitExactParsesFromRepairsAndClassifyFailures() {
        ProviderCallTelemetry.structuredParse(StructuredRepairKind.NONE, true);
        ProviderCallTelemetry.structuredParse(StructuredRepairKind.STRIPPED_CODE_FENCE, false);
        ProviderCallTelemetry.structuredParse(StructuredRepairKind.WRAPPED_SINGLE_OBJECT, false);
        ProviderCallTelemetry.structuredFailure(StructuredOutputFailure.MULTIPLE_JSON_PAYLOADS);
        ProviderCallTelemetry.continuationAttempt();
        ProviderCallTelemetry.continuationAttempt();
        ProviderCallTelemetry.continuationSuccess();

        var snapshot = ProviderCallTelemetry.snapshot();

        assertThat(snapshot.structuredRequests()).isEqualTo(4);
        assertThat(snapshot.structuredExactParses()).isEqualTo(1);
        assertThat(snapshot.structuredLocalRepairs()).isEqualTo(2);
        assertThat(snapshot.repairRate()).isEqualTo(0.5);
        assertThat(snapshot.repairKinds()).contains("stripped_code_fence:1").contains("wrapped_single_object:1");
        assertThat(snapshot.structuredFailures()).isEqualTo("multiple_json_payloads:1");
        assertThat(snapshot.continuationAttempts()).isEqualTo(2);
        assertThat(snapshot.continuationSuccesses()).isEqualTo(1);
    }

    @Test
    void structuredCountersOutsideARequestReportNothing() {
        ProviderCallTelemetry.clear();
        ProviderCallTelemetry.structuredParse(StructuredRepairKind.NONE, true);
        ProviderCallTelemetry.structuredFailure(StructuredOutputFailure.TRUNCATED);

        assertThat(ProviderCallTelemetry.snapshot()).isEqualTo(ProviderCallTelemetry.Snapshot.empty());
    }
}
