package com.studyos.chat;

import java.util.Arrays;
import java.util.Locale;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Whether a piece of learner text mentions a course term, using only the term itself.
 *
 * <p>The terms come from the course's own extracted topics and their aliases, so nothing here needs to know
 * what any subject calls things: a match is a word-boundary occurrence of a term, its singular form, or the
 * acronym its own words spell. Two callers need exactly this, and they must agree, or a chat could resolve a
 * request to one topic while scope resolution resolves it to another.
 */
final class TopicMentions {
    private TopicMentions() {}

    /** Lower-cases and reduces everything that is not a letter or digit to single spaces. */
    static String normalize(String value) {
        return (value == null ? "" : value).toLowerCase(Locale.ROOT).replace('—', ' ').replace('–', ' ')
                .replaceAll("[^\\p{L}\\p{N}]+", " ").replaceAll("\\s+", " ").trim();
    }

    /** True when {@code phrase} occurs in already-normalized {@code text} on word boundaries. */
    static boolean containsPhrase(String text, String phrase) {
        String normalized = normalize(phrase);
        return !normalized.isBlank() && Pattern.compile("(?:^|[^a-z0-9])" + Pattern.quote(normalized) + "(?:$|[^a-z0-9])", Pattern.CASE_INSENSITIVE).matcher(text).find();
    }

    /** True when already-normalized {@code query} mentions {@code term}, its singular, or its acronym. */
    static boolean matches(String query, String term) {
        String normalized = normalize(term);
        if (containsPhrase(query, normalized)) return true;
        if (normalized.endsWith("s") && normalized.length() > 4 && containsPhrase(query, normalized.substring(0, normalized.length() - 1))) return true;
        String[] words = normalized.split(" ");
        if (words.length < 2) return false;
        String acronym = Arrays.stream(words).filter(word -> !word.isBlank()).map(word -> word.substring(0, 1)).collect(Collectors.joining());
        return acronym.length() >= 2 && containsPhrase(query, acronym);
    }
}
