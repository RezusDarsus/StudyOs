package com.studyos.ingestion;

import java.util.Locale;

/**
 * The short statement of where a chunk came from, indexed and embedded with the chunk but never presented as
 * the chunk's text.
 *
 * <p>Retrieval scores a chunk on what the chunk itself says, so a passage that reads "the same bound applies
 * for any n" scores near zero against a query naming the topic it is about — the words that would have matched
 * are in the heading above it and the document it belongs to. Prepending that context before embedding and
 * before the full-text vector is built is what closes the gap; keeping it out of {@code content} is what stops
 * a manufactured line from being quoted back as source text.
 *
 * <p>The header is only names — the document's and the section's. No boilerplate label words, because every
 * word here lands in the full-text vector of every chunk in the course, and a query containing a label word
 * would then match the whole corpus.
 */
public final class ChunkContext {
    /** Enough for a document name and a section trail, short enough that context cannot crowd out content. */
    static final int MAX_HEADER_CHARS = 180;
    private static final String JOIN = " — ";

    private ChunkContext() {}

    /** What this chunk is part of, as one line, or empty when neither the name nor the outline says anything. */
    public static String header(String documentName, String headingPath) {
        String name = name(documentName);
        String path = collapse(headingPath);
        if (path.isEmpty()) return bound(name);
        if (name.isEmpty() || path.toLowerCase(Locale.ROOT).startsWith(name.toLowerCase(Locale.ROOT))) return bound(path);
        return bound(name + JOIN + path);
    }

    /** The text to embed and to index: the context, then the chunk, exactly as retrieval will have to match it. */
    public static String contextual(String header, String content) {
        String context = header == null ? "" : header.strip();
        String body = content == null ? "" : content;
        return context.isEmpty() ? body : context + "\n\n" + body;
    }

    /**
     * The section trail alone, for showing beside a citation that already names the document. Empty when the
     * header says nothing the citation does not already say.
     */
    public static String section(String header, String documentName) {
        String value = collapse(header);
        String name = name(documentName);
        if (value.isEmpty() || value.equalsIgnoreCase(name)) return "";
        String prefix = name + JOIN;
        return value.regionMatches(true, 0, prefix, 0, prefix.length()) ? value.substring(prefix.length()).strip() : value;
    }

    /**
     * A stored file name is not a title. The extension and the separators that stood in for spaces would enter
     * the index as lexemes of their own and the embedding as noise, so both are normalised away.
     */
    private static String name(String documentName) {
        String value = collapse(documentName).replaceAll("(?i)\\.[a-z0-9]{1,5}$", "");
        return collapse(value.replaceAll("[_]+", " "));
    }

    private static String collapse(String value) {
        return value == null ? "" : value.replaceAll("\\s+", " ").strip();
    }

    /** Truncated on a word boundary, so a runaway heading yields a shorter context rather than a broken one. */
    private static String bound(String value) {
        if (value.length() <= MAX_HEADER_CHARS) return value;
        String cut = value.substring(0, MAX_HEADER_CHARS);
        int lastSpace = cut.lastIndexOf(' ');
        return (lastSpace > MAX_HEADER_CHARS / 2 ? cut.substring(0, lastSpace) : cut).strip();
    }
}
