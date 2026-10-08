package com.studyos.ai;

/**
 * Why a structured provider response could not be turned into the requested type. The classes are
 * diagnostics first: they say which stage failed (extraction, syntax, schema, truncation) so the
 * funnel and the usage records can distinguish "the model ignored the shape" from "the model was
 * cut off" from "the content itself was invalid". Provider transport failures never land here —
 * those are {@link AiProviderException}s and keep their own classification.
 */
public enum StructuredOutputFailure {
    /** Blank or whitespace-only response. */
    EMPTY_OUTPUT,
    /** Non-blank text, but no top-level JSON object or array could be identified in it. */
    NO_JSON_PAYLOAD,
    /** More than one top-level JSON payload; choosing between them would be guesswork. */
    MULTIPLE_JSON_PAYLOADS,
    /** Exactly one payload was identified but it is not parseable JSON and not truncated. */
    INVALID_JSON,
    /** Parseable JSON that does not fit the requested type, with no eligible structural repair. */
    SCHEMA_MISMATCH,
    /** The root shape (scalar, array against a non-wrappable target) cannot be used at all. */
    UNSUPPORTED_ROOT_SHAPE,
    /** The response looks cut off by the token cap: length finish reason or unterminated JSON. */
    TRUNCATED,
    /** A structural repair was eligible but its result failed strict validation, so it was refused. */
    REPAIR_REJECTED
}
