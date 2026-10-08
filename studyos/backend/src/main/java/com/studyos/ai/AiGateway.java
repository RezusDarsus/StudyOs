package com.studyos.ai;

import java.util.List;

/** Provider-independent seam for embeddings, structured extraction, and generation. */
public interface AiGateway extends ChatProvider, EmbeddingProvider {
    AiResult<float[]> embedResult(String text, EmbeddingInputType inputType);
    AiResult<List<float[]>> embedBatchResult(List<String> texts, EmbeddingInputType inputType);
    default AiResult<float[]> embedResult(String text) { return embedResult(text,EmbeddingInputType.QUERY); }
    default AiResult<List<float[]>> embedBatchResult(List<String> texts) { return embedBatchResult(texts,EmbeddingInputType.PASSAGE); }
    <T> AiResult<T> generateStructuredResult(String systemPrompt, String userPrompt, Class<T> responseType);
    default <T> AiResult<T> generateStructuredResult(String systemPrompt, String userPrompt, Class<T> responseType, GenerationPolicy policy) { return generateStructuredResult(systemPrompt, userPrompt, responseType); }
    AiResult<String> generateResult(String systemPrompt, String userPrompt);
    default AiResult<String> generateResult(String systemPrompt, String userPrompt, GenerationPolicy policy) { return generateResult(systemPrompt, userPrompt); }
    default float[] embed(String text) { return embedResult(text,EmbeddingInputType.QUERY).value(); }
    default List<float[]> embedBatch(List<String> texts) { return embedBatchResult(texts,EmbeddingInputType.PASSAGE).value(); }
    default <T> T generateStructured(String systemPrompt, String userPrompt, Class<T> responseType) { return generateStructuredResult(systemPrompt, userPrompt, responseType).value(); }
    default String generate(String systemPrompt, String userPrompt) { return generateResult(systemPrompt, userPrompt).value(); }
}
