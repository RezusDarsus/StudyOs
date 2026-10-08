package com.studyos.ai;

/** Explicit generation controls for one operation. */
public record GenerationPolicy(AiOperation operation, String model, int maxOutputTokens,
                               double temperature, double topP, boolean thinking, ResponseMode responseMode) {
    public enum ResponseMode { TEXT, JSON }
}
