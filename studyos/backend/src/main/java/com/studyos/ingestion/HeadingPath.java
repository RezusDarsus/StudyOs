package com.studyos.ingestion;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Where in a document's own outline the text currently being chunked sits.
 *
 * <p>A chunk carved out of the middle of a lecture arrives at the retriever with no idea what it is about:
 * "the same construction works for any n" is a useless embedding and an unmatchable lexical row, because the
 * heading three paragraphs above it is what said which construction. Feeding that heading trail in with the
 * chunk is what makes the chunk self-describing.
 *
 * <p>Headings are recognised structurally — numbering, markup, capitalisation, length — and never by their
 * words, so the same detector finds sections in a networking course, a Spanish reader, and a law syllabus.
 */
final class HeadingPath {
    /** Longer than this is a sentence someone wrote, not a heading someone titled. */
    private static final int MAX_HEADING_CHARS = 90;
    private static final int MAX_WORDS = 12;
    /** Two letters, so a bare "1.2.3" or a page number never becomes a section title. */
    private static final int MIN_LETTERS = 2;
    private static final int MAX_DEPTH = 4;

    private static final Pattern MARKUP = Pattern.compile("^(#{1,6})\\s+(\\S.*)$");
    private static final Pattern NUMBERED = Pattern.compile("^(\\d{1,2}(?:\\.\\d{1,3})*)[.)]?\\s+(\\S.*)$");
    private static final Pattern SENTENCE_END = Pattern.compile("[.,;!?]$");

    private final List<Heading> trail = new ArrayList<>();

    /**
     * Reads a block of text for heading lines, updating the trail in the order they appear.
     *
     * @return whether the block was nothing but headings, which is how a caller can tell a title standing on
     *     its own from a title glued to the paragraph it opens
     */
    boolean observe(String block) {
        if (block == null || block.isBlank()) return false;
        boolean onlyHeadings = true;
        for (String line : block.split("\\R")) {
            if (line.isBlank()) continue;
            Heading heading = heading(line);
            if (heading == null) onlyHeadings = false;
            else push(heading);
        }
        return onlyHeadings;
    }

    /** The trail as one line, outermost section first, or empty when the document offers no structure at all. */
    String path() {
        return Heading.path(trail);
    }

    /**
     * The same trail with its levels intact, which is what turns a path into a tree: collapsed to a string,
     * "1 Processes > 1.1 States" and "1 Processes > 2 Threads" are indistinguishable in shape, and only the
     * levels say that the first pair nests while the second pair are siblings.
     */
    List<Heading> trail() {
        return List.copyOf(trail);
    }

    /**
     * A heading at a given level ends every section at that level or deeper, which is what makes the trail a
     * path rather than a log: 3.1 then 3.2 yields "3 … > 3.2 …", not both subsections at once.
     */
    private void push(Heading heading) {
        int level = Math.max(1, Math.min(MAX_DEPTH, heading.level()));
        while (!trail.isEmpty() && trail.get(trail.size() - 1).level() >= level) trail.remove(trail.size() - 1);
        trail.add(new Heading(level, heading.text()));
    }

    /** The heading this line is, or null. Package-private so the recognition rules can be tested on their own. */
    static Heading heading(String rawLine) {
        String line = rawLine == null ? "" : rawLine.strip();
        if (line.isEmpty() || line.length() > MAX_HEADING_CHARS) return null;
        Matcher markup = MARKUP.matcher(line);
        if (markup.matches()) return titled(markup.group(1).length(), markup.group(2));
        Matcher numbered = NUMBERED.matcher(line);
        if (numbered.matches() && starts(numbered.group(2)) && short_(line) && !SENTENCE_END.matcher(line).find()) {
            return titled(numbered.group(1).split("\\.").length, line);
        }
        if (shouted(line) && short_(line) && !SENTENCE_END.matcher(line).find()) return titled(1, line);
        return null;
    }

    private static Heading titled(int level, String text) {
        String clean = text.strip().replaceAll("[:\\s]+$", "");
        return letters(clean) < MIN_LETTERS ? null : new Heading(level, clean);
    }

    /** A numbered line whose text starts lower-case is prose that happened to begin with a figure. */
    private static boolean starts(String text) {
        for (char character : text.toCharArray()) {
            if (Character.isLetter(character)) return Character.isUpperCase(character);
            if (Character.isDigit(character)) return true;
        }
        return false;
    }

    private static boolean short_(String line) {
        return line.split("\\s+").length <= MAX_WORDS;
    }

    /** Capitals carry the heading in documents that number nothing, and a line of prose is never all capitals. */
    private static boolean shouted(String line) {
        long letters = letters(line);
        if (letters < MIN_LETTERS) return false;
        long upper = line.chars().filter(Character::isLetter).filter(Character::isUpperCase).count();
        return upper == letters && line.equals(line.toUpperCase(Locale.ROOT));
    }

    private static long letters(String line) {
        return line.chars().filter(Character::isLetter).count();
    }
}
