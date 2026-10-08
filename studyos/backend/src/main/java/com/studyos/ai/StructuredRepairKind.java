package com.studyos.ai;

/**
 * The one deterministic structural change, if any, that turned a raw provider response into the JSON
 * that was finally deserialized. Structural only: nothing here rewrites field values, fills missing
 * data, or converts types — content problems stay content problems.
 */
public enum StructuredRepairKind {
    /** The response was already the exact JSON object/array the caller asked for. */
    NONE,
    /** A Markdown code fence around the payload was removed. */
    STRIPPED_CODE_FENCE,
    /** The single JSON payload was extracted from surrounding prose. */
    EXTRACTED_SINGLE_JSON_PAYLOAD,
    /** The JSON only parsed once trailing commas were tolerated (never rewritten by hand). */
    REMOVED_TRAILING_COMMA,
    /** A bare top-level array was wrapped into the target's single collection field. */
    WRAPPED_BARE_ARRAY,
    /** A bare single object was wrapped as the one element of the target's single collection field. */
    WRAPPED_SINGLE_OBJECT
}
