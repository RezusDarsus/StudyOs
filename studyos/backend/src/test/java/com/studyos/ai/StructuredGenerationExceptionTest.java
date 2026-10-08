package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

class StructuredGenerationExceptionTest {
    @Test void preservesProviderUsageOnParseFailure() {
        AiResult<String> raw = new AiResult<>("not json",120,30,150,"model","stop",7);
        StructuredGenerationException error = new StructuredGenerationException("bad json",new IllegalArgumentException(),raw,true);
        AiResult<Object> telemetry = error.telemetryResult();
        assertThat(telemetry.inputTokens()).isEqualTo(120);
        assertThat(telemetry.outputTokens()).isEqualTo(30);
        assertThat(telemetry.structuredParseSuccess()).isFalse();
        assertThat(telemetry.structuredRepairUsed()).isTrue();
    }
}
