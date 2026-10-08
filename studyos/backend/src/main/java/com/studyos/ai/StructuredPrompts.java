package com.studyos.ai;

/**
 * The shared structured-output prompt contract. Prevention before repair: every structured caller
 * states the exact top-level shape it expects, and the gateway appends the one non-negotiable rule.
 * Keeping the phrasing in one place stops twenty services from drifting into twenty different
 * (and sometimes contradictory) ways of asking for JSON.
 */
public final class StructuredPrompts {
    private StructuredPrompts() {}

    /** Appended by the gateway to every structured request: bare JSON, nothing else. */
    public static String jsonOnly() {
        return "\nReturn only valid JSON. Do not use markdown fences or explanatory text.";
    }

    /**
     * For callers that can state the exact root shape. Passing the shape explicitly is the primary
     * defense against mis-shaped replies; the gateway's repair layer is only the fallback.
     */
    public static String exactShape(String shapeJson) {
        return "\nReturn JSON only, exactly this shape: " + shapeJson + " No markdown fences, no commentary before or after.";
    }
}
