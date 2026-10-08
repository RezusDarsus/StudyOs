package com.studyos.research;

import java.util.Map;

/**
 * Reduces fetched HTML to the plain text a study workspace can ingest.
 *
 * <p>This is a security boundary as much as a parser. A page arrives as untrusted data that may
 * contain scripts, embedded objects, event handlers and text crafted to read like instructions to
 * whatever processes it later. Everything executable or structural is removed here — script and
 * style bodies, comments, tags, processing instructions — leaving only what a reader would see.
 * What survives is still untrusted content, and every consumer downstream must keep treating it
 * as data: it becomes chunk text and prompt context, never instructions StudyOS follows.
 */
public final class HtmlTextExtractor {
    private HtmlTextExtractor() {}

    /** Titles of common block-level elements, used to keep paragraph boundaries readable. */
    private static final String BLOCK_BOUNDARY = "(?i)<\\s*(?:br|p|div|section|article|header|footer|h[1-6]|li|tr|blockquote|pre|table|ul|ol)\\b[^>]*>";

    /** The handful of entities that matter after tags are gone; numeric forms cover the rest. */
    private static final Map<String, String> ENTITIES = Map.ofEntries(
            Map.entry("amp", "&"), Map.entry("lt", "<"), Map.entry("gt", ">"), Map.entry("quot", "\""),
            Map.entry("apos", "'"), Map.entry("nbsp", " "), Map.entry("mdash", "—"), Map.entry("ndash", "–"),
            Map.entry("hellip", "…"), Map.entry("rsquo", "’"), Map.entry("lsquo", "‘"),
            Map.entry("ldquo", "“"), Map.entry("rdquo", "”"), Map.entry("copy", "©"), Map.entry("reg", "®"),
            Map.entry("trade", "™"), Map.entry("times", "×"));

    /**
     * The page's readable text: script-free, tag-free, whitespace-collapsed. Empty when the page
     * had nothing to say in plain text.
     */
    public static String text(String html) {
        if (html == null || html.isBlank()) return "";
        String withoutExecutable = html
                .replaceAll("(?is)<\\s*script\\b.*?<\\s*/\\s*script\\s*>", " ")
                .replaceAll("(?is)<\\s*style\\b.*?<\\s*/\\s*style\\s*>", " ")
                .replaceAll("(?is)<\\s*noscript\\b.*?<\\s*/\\s*noscript\\s*>", " ")
                .replaceAll("(?is)<\\s*svg\\b.*?<\\s*/\\s*svg\\s*>", " ")
                .replaceAll("(?is)<\\s*iframe\\b.*?<\\s*/\\s*iframe\\s*>", " ")
                .replaceAll("(?is)<\\s*template\\b.*?<\\s*/\\s*template\\s*>", " ")
                .replaceAll("(?is)<!--.*?-->", " ")
                .replaceAll("(?is)<\\?.*?\\?>", " ")
                .replaceAll("(?is)<!\\s*DOCTYPE[^>]*>", " ");
        String readable = withoutExecutable
                .replaceAll(BLOCK_BOUNDARY, "\n")
                .replaceAll("(?is)<\\s*[^>]+\\s*/?\\s*>", " ");
        String decoded = decode(readable);
        return decoded.replaceAll("[ \\t\\x0B\\f\\r]+", " ")
                .replaceAll("(?m)^\\s+$", "")
                .replaceAll("\\n{3,}", "\n\n")
                .trim();
    }

    /** The page's title, or an empty string. */
    public static String title(String html) {
        if (html == null) return "";
        var matcher = java.util.regex.Pattern.compile("(?is)<\\s*title[^>]*>(.*?)<\\s*/\\s*title\\s*>").matcher(html);
        if (!matcher.find()) return "";
        return decode(matcher.group(1)).replaceAll("\\s+", " ").trim();
    }

    private static String decode(String value) {
        StringBuilder result = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char current = value.charAt(i);
            if (current != '&') { result.append(current); continue; }
            int semicolon = value.indexOf(';', i);
            if (semicolon < 0 || semicolon - i > 10) { result.append(current); continue; }
            String entity = value.substring(i + 1, semicolon);
            String replacement = named(entity);
            if (replacement == null && entity.length() > 1 && (entity.charAt(0) == '#' || (entity.charAt(0) == 'x' && entity.length() > 1 && Character.toLowerCase(entity.charAt(1)) == 'x'))) {
                replacement = numeric(entity);
            }
            if (replacement != null) { result.append(replacement); i = semicolon; }
            else result.append(current);
        }
        return result.toString();
    }

    private static String named(String entity) {
        return ENTITIES.get(entity.toLowerCase(java.util.Locale.ROOT));
    }

    private static String numeric(String entity) {
        try {
            int code = entity.charAt(0) == '#' ? Integer.parseInt(entity.substring(1).replaceFirst("(?i)^x", "0x"), 16)
                    : Integer.parseInt(entity.substring(2), 16);
            return code > 0 && code <= Character.MAX_CODE_POINT && !Character.isISOControl(code) ? String.copyValueOf(Character.toChars(code)) : " ";
        } catch (RuntimeException error) { return " "; }
    }
}
