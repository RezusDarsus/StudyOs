package com.studyos.ai;

import java.util.List;

public interface EmbeddingProvider {
    AiResult<float[]> embedResult(String text,EmbeddingInputType inputType);
    AiResult<List<float[]>> embedBatchResult(List<String> texts,EmbeddingInputType inputType);
}
