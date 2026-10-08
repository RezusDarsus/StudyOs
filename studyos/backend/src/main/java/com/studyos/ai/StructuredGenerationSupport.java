package com.studyos.ai;

import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The shared structured-generation path both real gateways run: normalize the raw response, parse it
 * strictly into the requested type, and — only for a length-capped, unfinished response — make ONE
 * bounded continuation attempt before failing.
 *
 * <p>Retry budget (per structured call): transport retries follow the gateway's existing policy;
 * local structural repair makes zero provider calls; truncation continuation is capped at exactly
 * one call; caller-level fallbacks stay the caller's existing bounded policies. Nothing here
 * multiplies retries.
 *
 * <p>Deadline safety: a continuation is only attempted when the shared {@link RequestDeadline} still
 * has room for a useful attempt, and the continuation call itself goes through the gateway's normal
 * request path, which caps its timeout at the remaining budget. A parse failure at 29s of a 30s
 * request fails cleanly instead of chaining another 30s call.
 */
public final class StructuredGenerationSupport {
    /** Hard cap: one continuation attempt, then the structured failure stands. */
    static final int MAX_CONTINUATION_ATTEMPTS = 1;
    /** How much of the cut-off tail the continuation prompt carries for context. */
    private static final int CONTINUATION_CONTEXT_CHARS = 6000;
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(StructuredGenerationSupport.class);

    private StructuredGenerationSupport() {}

    /** The gateway's own generation entry point, so continuations reuse its retry and deadline policy. */
    public interface Provider {
        AiResult<String> generate(String systemPrompt, String userPrompt, GenerationPolicy policy);
    }

    public static <T> AiResult<T> parseStructured(ObjectMapper mapper, Provider provider, GenerationPolicy basePolicy,
                                                  AiResult<String> raw, Class<T> responseType, StructuredOutputNormalizer normalizer) {
        StructuredNormalizationResult normalization = normalizer.normalize(raw.value(), responseType, raw.finishReason());
        if (normalization.success()) {
            boolean exact = normalization.repairKind() == StructuredRepairKind.NONE;
            ProviderCallTelemetry.structuredParse(normalization.repairKind(), exact);
            return new AiResult<>(parse(mapper, normalization, responseType), raw.inputTokens(), raw.outputTokens(),
                    raw.totalTokens(), raw.model(), raw.finishReason(), raw.reasoningTokens(), true, normalization.repaired());
        }
        if (normalization.failure() == StructuredOutputFailure.TRUNCATED) {
            if (!continuationAffordable()) {
                // Deadline safety: a near-spent turn fails cleanly instead of chaining another call.
                log.warn("truncation continuation skipped: the turn has {} left", RequestDeadline.remaining());
            } else {
                AiResult<String> continued = continueOnce(provider, basePolicy, raw);
                if (continued == null) log.warn("truncation continuation produced no usable response; failing with the truncation classification");
                if (continued != null && continued.value() != null && !continued.value().isBlank()) {
                    ProviderCallTelemetry.continuationAttempt();
                    // Prefer the honest continuation: the raw response with the remainder appended.
                    StructuredNormalizationResult merged = normalizer.normalize(concat(raw.value(), continued.value()), responseType, continued.finishReason());
                    if (!merged.success()) {
                        // The model restarted the whole document instead of continuing. Its restart is
                        // only used when the continuation reading genuinely failed, and it still has to
                        // pass the same strict parse.
                        merged = normalizer.normalize(continued.value(), responseType, continued.finishReason());
                    }
                    if (merged.success()) {
                        ProviderCallTelemetry.continuationSuccess();
                        ProviderCallTelemetry.structuredParse(merged.repairKind(), merged.repairKind() == StructuredRepairKind.NONE);
                        T value = parse(mapper, merged, responseType);
                        return new AiResult<>(value,
                                sum(raw.inputTokens(), continued.inputTokens()), sum(raw.outputTokens(), continued.outputTokens()),
                                sum(raw.totalTokens(), continued.totalTokens()), raw.model(), continued.finishReason(),
                                raw.reasoningTokens(), true, true);
                    }
                }
            }
        }
        ProviderCallTelemetry.structuredFailure(normalization.failure());
        log.warn("structured generation failed: {} (raw {} chars, finishReason={}){}{}; payload head: {}", normalization.failure(),
                raw.value() == null ? 0 : raw.value().length(), raw.finishReason(),
                normalization.repairKind() == StructuredRepairKind.NONE ? "" : ", after " + normalization.repairKind() + " repair",
                normalization.detail() == null ? "" : ", detail: " + normalization.detail(),
                excerpt(raw.value()));
        throw new StructuredGenerationException(describe(normalization), normalization, raw);
    }

    /** A bounded, structural excerpt for diagnostics: enough to see the shape, never the whole response. */
    private static String excerpt(String raw) {
        if (raw == null) return "";
        String head = raw.strip().replaceAll("\\s+", " ");
        return head.length() <= 240 ? head : head.substring(0, 240) + "…";
    }

    /**
     * Whether one more provider call can still be afforded. {@link RequestDeadline#spent} is the
     * turn's own floor for a useful attempt; when unbounded it never blocks. The call itself is
     * still deadline-capped by the gateway.
     */
    static boolean continuationAffordable() { return !RequestDeadline.spent(); }

    private static AiResult<String> continueOnce(Provider provider, GenerationPolicy basePolicy, AiResult<String> raw) {
        String prefix = raw.value() == null ? "" : raw.value();
        String tail = prefix.length() <= CONTINUATION_CONTEXT_CHARS
                ? prefix
                : prefix.substring(prefix.length() - CONTINUATION_CONTEXT_CHARS);
        GenerationPolicy textPolicy = new GenerationPolicy(basePolicy.operation(), basePolicy.model(),
                basePolicy.maxOutputTokens(), basePolicy.temperature(), basePolicy.topP(), false, GenerationPolicy.ResponseMode.TEXT);
        try {
            return provider.generate(
                    "You resume an answer that was cut off mid-JSON. The user gives you the tail of an unfinished JSON document. "
                            + "Output ONLY the missing remainder, continuing at the exact cut point. No preamble, no repetition of earlier text, "
                            + "no markdown fences, no commentary. Close every bracket and brace the document still has open.",
                    "The JSON document began earlier. Its unfinished tail is:\n\n" + tail,
                    textPolicy);
        } catch (DeadlineExceededException error) {
            // The turn's budget ran out reaching for the continuation: the deadline is global and
            // must stand, so the truncation failure is reported through it.
            log.warn("truncation continuation abandoned: the request deadline ran out");
            throw error;
        } catch (RuntimeException error) {
            log.warn("truncation continuation did not complete: {}", error.toString());
            return null;
        }
    }

    /**
     * The continuation is appended to the original response verbatim, and the merged text goes
     * through the same normalizer, which extracts the single payload. Fences and prose the model
     * added around the remainder are harmless there; only if the merged reading fails can the
     * continuation be tried alone, as a restarted document.
     */
    static String concat(String raw, String continuation) {
        return (raw == null ? "" : raw) + (continuation == null ? "" : continuation);
    }

    private static Integer sum(Integer left, Integer right) {
        return left == null ? right : right == null ? left : left + right;
    }

    private static <T> T parse(ObjectMapper mapper, StructuredNormalizationResult normalization, Class<T> responseType) {
        try {
            return mapper.readValue(normalization.normalizedJson(), responseType);
        } catch (RuntimeException | java.io.IOException error) {
            // The normalizer trial-parsed this exact tree, so a failure here means the mapper and
            // the normalizer disagree — a bug, not a provider problem, and it must be loud.
            throw new IllegalStateException("Normalized structured output failed strict deserialization", error);
        }
    }

    private static String describe(StructuredNormalizationResult normalization) {
        return "structured output could not be parsed: " + normalization.failure()
                + (normalization.truncated() ? " (response truncated)" : "")
                + (normalization.repairKind() != StructuredRepairKind.NONE ? ", after " + normalization.repairKind() : "");
    }
}
