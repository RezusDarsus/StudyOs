package com.studyos.ai;

import java.util.Arrays;
import java.util.List;
import org.springframework.stereotype.Component;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;

/** Safe local seam until a real provider key is configured. */
@Component
@ConditionalOnProperty(name = "studyos.ai.provider", havingValue = "stub", matchIfMissing = true)
public class StubAiGateway implements AiGateway {
    private static final int DIMENSIONS = 2048;
    @Override public AiResult<float[]> embedResult(String text,EmbeddingInputType inputType) { return AiResult.withoutUsage(new float[DIMENSIONS], "stub"); }
    @Override public AiResult<List<float[]>> embedBatchResult(List<String> texts,EmbeddingInputType inputType) { return AiResult.withoutUsage(texts.stream().map(value->new float[DIMENSIONS]).toList(), "stub"); }
    @Override public <T> AiResult<T> generateStructuredResult(String systemPrompt, String userPrompt, Class<T> responseType) { throw new UnsupportedOperationException("Configure an AI provider before structured generation"); }
    @Override public AiResult<String> generateResult(String systemPrompt, String userPrompt) { return AiResult.withoutUsage("The local AI stub is active. Configure an AI provider for source-grounded answers.", "stub"); }
}
