package com.studyos.ai;

/**
 * Preserves provider telemetry when JSON parsing fails after a successful model response, together
 * with the structured failure classification: what kind of repair was attempted, why the output
 * could not be used, and whether it looked truncated. Never carries learner content — only lengths.
 */
public class StructuredGenerationException extends IllegalStateException {
    private final AiResult<Void> telemetry;
    private final String rawText;
    private final StructuredOutputFailure failure;
    private final StructuredRepairKind repairKind;
    private final boolean truncated;

    public StructuredGenerationException(String message, Throwable cause, AiResult<String> raw, boolean repairUsed) {
        this(message, cause, raw, repairUsed, null, null, false);
    }

    public StructuredGenerationException(String message, StructuredNormalizationResult normalization, AiResult<String> raw) {
        this(message, null, raw, normalization.repaired(), normalization.failure(), normalization.repairKind(), normalization.truncated());
    }

    public StructuredGenerationException(String message, Throwable cause, AiResult<String> raw, boolean repairUsed,
                                         StructuredOutputFailure failure, StructuredRepairKind repairKind, boolean truncated) {
        super(message, cause);
        this.telemetry = new AiResult<>(null, raw.inputTokens(), raw.outputTokens(), raw.totalTokens(), raw.model(),
                raw.finishReason(), raw.reasoningTokens(), false, repairUsed);
        this.rawText = raw.value();
        this.failure = failure;
        this.repairKind = repairKind;
        this.truncated = truncated;
    }

    @SuppressWarnings("unchecked")
    public <T> AiResult<T> telemetryResult() { return (AiResult<T>) (AiResult<?>) telemetry; }
    public String rawText() { return rawText; }
    public StructuredOutputFailure failure() { return failure; }
    public StructuredRepairKind repairKind() { return repairKind; }
    public boolean truncated() { return truncated; }
    public int rawLength() { return rawText == null ? 0 : rawText.length(); }
}
