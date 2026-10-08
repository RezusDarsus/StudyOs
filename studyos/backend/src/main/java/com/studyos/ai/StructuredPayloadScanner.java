package com.studyos.ai;

import java.util.List;

/**
 * Finds the top-level JSON payloads in a raw provider response, without rewriting anything.
 *
 * <p>The scan is character-level and state-machine based so that braces inside string literals,
 * escaped quotes, Markdown fences and prose between payloads cannot produce a false payload
 * boundary. It answers exactly the questions the normalizer is allowed to act on: is there one
 * unambiguous payload, several (ambiguity — refuse), or one that never closed (truncation signal).
 */
final class StructuredPayloadScanner {
    private StructuredPayloadScanner() {}

    /** One complete top-level JSON object or array found in the text. */
    record Payload(String text, boolean fenced) {}

    record Scan(List<Payload> payloads, boolean unterminated) {}

    static Scan scan(String raw) {
        String text = raw == null ? "" : stripByteOrderMark(raw);
        List<Payload> payloads = new java.util.ArrayList<>();
        int depth = 0;
        int start = -1;
        boolean inString = false;
        boolean escaped = false;
        boolean inFence = false;
        boolean payloadStartedInFence = false;
        int index = 0;
        while (index < text.length()) {
            char current = text.charAt(index);
            if (inString) {
                if (escaped) escaped = false;
                else if (current == '\\') escaped = true;
                else if (current == '"') inString = false;
                index++;
                continue;
            }
            if (depth > 0) {
                if (current == '"') { inString = true; escaped = false; }
                else if (current == '{' || current == '[') depth++;
                else if (current == '}' || current == ']') {
                    depth--;
                    if (depth == 0) {
                        payloads.add(new Payload(text.substring(start, index + 1).trim(), payloadStartedInFence));
                        start = -1;
                    }
                }
                index++;
                continue;
            }
            if (current == '"') { inString = true; escaped = false; index++; continue; }
            if (current == '`') { index = skipFenceMarker(text, index); inFence = !inFence; continue; }
            if (current == '{' || current == '[') {
                if (start < 0) { start = index; depth = 1; payloadStartedInFence = inFence; }
            }
            index++;
        }
        return new Scan(List.copyOf(payloads), start >= 0);
    }

    /**
     * Consumes one or more backticks. A run of three or more toggles a fenced block; the language
     * tag on the opening line belongs to the fence, not to a payload, so it is skipped too. Short
     * runs are inline-code markers and are simply stepped over.
     */
    private static int skipFenceMarker(String text, int backtickStart) {
        int index = backtickStart;
        int run = 0;
        while (index < text.length() && text.charAt(index) == '`') { run++; index++; }
        if (run < 3) return index;
        if (index < text.length()) {
            int lineEnd = text.indexOf('\n', index);
            // An opening fence may carry a language tag; a closing fence sits on its own line.
            boolean opensWithLanguage = lineEnd >= 0 && text.substring(index, lineEnd).chars().noneMatch(character -> character == '`');
            if (opensWithLanguage) return lineEnd + 1;
        }
        return index;
    }

    private static String stripByteOrderMark(String raw) {
        return raw.startsWith("\uFEFF") ? raw.substring(1) : raw;
    }
}
