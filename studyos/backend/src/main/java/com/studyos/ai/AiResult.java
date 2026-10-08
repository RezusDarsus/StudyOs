package com.studyos.ai;

/** Value returned by an AI provider together with provider-reported usage when available. */
public record AiResult<T>(T value, Integer inputTokens, Integer outputTokens, Integer totalTokens, String model, String finishReason, Integer reasoningTokens, Boolean structuredParseSuccess, Boolean structuredRepairUsed) {
    public AiResult(T value, Integer inputTokens, Integer outputTokens, Integer totalTokens, String model) { this(value,inputTokens,outputTokens,totalTokens,model,null,null,null,null); }
    public AiResult(T value, Integer inputTokens, Integer outputTokens, Integer totalTokens, String model, String finishReason, Integer reasoningTokens) { this(value,inputTokens,outputTokens,totalTokens,model,finishReason,reasoningTokens,null,null); }
    public static <T> AiResult<T> withoutUsage(T value, String model) { return new AiResult<>(value, null, null, null, model, null, null, null, null); }
}
