package com.studyos.knowledge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finds candidate topic names in a passage using only structural and linguistic signals — headings,
 * definition wording, emphasis, and repetition. Nothing here knows what subject is being studied, so
 * the same code surfaces "Cell Membrane" from a biology reader and "Consideration" from a contract-law
 * one. Any list of concepts belongs to the student's uploaded material, never to this class.
 */
public final class TopicSignalExtractor {
    private TopicSignalExtractor() {}

    /** How a candidate was noticed, weakest evidence last. */
    public enum Signal {
        DEFINITION(.74), HEADING(.62), EMPHASIS(.55), REPEATED_TERM(.5);
        private final double confidence;
        Signal(double confidence) { this.confidence = confidence; }
        public double confidence() { return confidence; }
    }

    public record Candidate(String name, Signal signal, double confidence) {}

    private static final int DEFAULT_LIMIT = 8;

    /** Function words. Present in every English course text regardless of subject. */
    private static final Set<String> STOPWORDS = Set.of("a", "an", "the", "this", "that", "these", "those", "it", "its", "we", "you", "they",
            "he", "she", "i", "there", "here", "if", "then", "else", "when", "while", "which", "who", "whom", "whose", "what", "and", "or",
            "but", "nor", "so", "for", "to", "of", "in", "on", "at", "by", "with", "from", "into", "onto", "over", "under", "as", "is",
            "are", "was", "were", "be", "been", "being", "do", "does", "did", "has", "have", "had", "can", "could", "may", "might",
            "must", "shall", "should", "will", "would", "not", "no", "any", "all", "some", "each", "every", "more", "most", "less",
            "than", "such", "very", "also", "only", "just", "about", "between", "because", "however", "therefore", "thus", "hence");

    /** Words that label the structure of a document rather than something to learn: now owned by
     *  {@link TopicCandidateQuality#evaluate}, which this class defers to for all admission. */
    private static final Pattern MARKDOWN_HEADING = Pattern.compile("^\\s{0,3}#{1,6}\\s+(\\S.*)$");
    private static final Pattern LABELLED_HEADING = Pattern.compile("(?i)^\\s*(?:chapter|lecture|section|module|unit|week|part|lesson|topic)\\s+\\d+(?:\\.\\d+)*\\s*[-–—:.)]\\s*(\\S.*)$");
    private static final Pattern NUMBERED_HEADING = Pattern.compile("^\\s*\\d+(?:\\.\\d+)*[.)]?\\s+([A-Za-z][^.!?]{2,89})$");
    private static final Pattern UPPERCASE_HEADING = Pattern.compile("^\\s*([A-Z][A-Z0-9&/'’()\\-]*(?:[ \\t]+[A-Z0-9&/'’()\\-]+){0,7})\\s*$");
    private static final Pattern GLOSSARY_LINE = Pattern.compile("^\\s*([A-Z][\\w'’\\- ]{2,60}?)\\s*[—–:]\\s+\\S");

    private static final List<Pattern> DEFINITIONS = List.of(
            Pattern.compile("(?i)\\bdefinition\\s*\\d*(?:\\.\\d+)*\\s*[:.\\-–—]?\\s*\\(?([A-Za-z][\\w'’\\- ]{2,60}?)\\)?\\s*[:.\\-–—(]"),
            Pattern.compile("(?i)\\b([A-Za-z][\\w'’\\- ]{2,60}?)\\s+(?:is|are)\\s+defined\\s+(?:as|to\\s+be)\\b"),
            Pattern.compile("(?i)\\b([A-Za-z][\\w'’\\- ]{2,60}?)\\s+refers\\s+to\\b"),
            Pattern.compile("(?i)\\b([A-Za-z][\\w'’\\- ]{2,60}?)\\s+(?:means|denotes|describes)\\s+(?:a|an|the|how|that|when)\\b"),
            Pattern.compile("(?i)\\b(?:is|are)\\s+(?:called|known\\s+as|termed|referred\\s+to\\s+as)\\s+(?:a|an|the)?\\s*([A-Za-z][\\w'’\\- ]{2,60}?)\\s*[.,;:)]"),
            Pattern.compile("(?i)\\bwe\\s+(?:call|denote|define|name)\\s+(?:this|it|these|them)?\\s*(?:a|an|the)?\\s*([A-Za-z][\\w'’\\- ]{2,60}?)\\s*[.,;:)]"),
            Pattern.compile("(?i)^\\s*(?:an?|the)\\s+([a-z][\\w'’\\- ]{2,60}?)\\s+(?:is|are)\\s+(?:a|an|the)\\b"),
            // "CRC is a cyclic redundancy check…", "Lamport clocks are logical clocks…": the classic
            // copula definition. Capital-initial subject biases toward concept mentions, not prose.
            Pattern.compile("(?m)^\\s*([A-Z][\\w'’\\- ]{1,60}?)\\s+(?:is|are)\\s+(?:a|an|the)\\b"));

    private static final List<Pattern> EMPHASIS = List.of(
            Pattern.compile("\\*\\*([^*\\n]{3,60})\\*\\*"),
            Pattern.compile("__([^_\\n]{3,60})__"),
            Pattern.compile("\\\\(?:textbf|textit|emph|underline)\\{([^}\\n]{3,60})\\}"));

    private static final Pattern TITLE_CASE_RUN = Pattern.compile("\\b[A-Z][a-zA-Z’']+(?:[ \\-](?:of|for|in|and|the|to)?[ ]?[A-Z][a-zA-Z’']+){1,4}\\b");

    public static List<Candidate> extract(String text) { return extract(text, DEFAULT_LIMIT); }

    /** The strongest distinct candidates in this passage, best evidence first. */
    public static List<Candidate> extract(String text, int limit) {
        List<Candidate> all = collect(text, limit, true);
        return all.size() <= Math.max(1, limit) ? all : List.copyOf(all.subList(0, Math.max(1, limit)));
    }

    /**
     * Every raw candidate, admission deferred to the caller. Used by the extraction funnel so a
     * rejection lands in the quality audit with its reason instead of vanishing inside the signal
     * extractor.
     */
    public static List<Candidate> collectUngated(String text, int limit) {
        List<Candidate> all = collect(text, Integer.MAX_VALUE, false);
        return all.size() <= Math.max(1, limit) ? all : List.copyOf(all.subList(0, Math.max(1, limit)));
    }

    private static List<Candidate> collect(String text, int limit, boolean gated) {
        String content = text == null ? "" : text;
        if (content.isBlank()) return List.of();
        Map<String, Candidate> found = new LinkedHashMap<>();
        for (String line : content.split("\\R")) {
            // Point packaging ("(20 Pt)") is stripped from the extraction view only; question
            // numbering stays so the heading patterns still see "3. Title" and the quality gate
            // judges the captured title. The persisted source text is never mutated.
            String normalisedLine = TopicCandidateQuality.stripPointMarkers(line);
            addMatch(found, MARKDOWN_HEADING.matcher(normalisedLine), Signal.HEADING, gated);
            addMatch(found, LABELLED_HEADING.matcher(normalisedLine), Signal.HEADING, gated);
            addMatch(found, NUMBERED_HEADING.matcher(normalisedLine), Signal.HEADING, gated);
            addMatch(found, GLOSSARY_LINE.matcher(normalisedLine), Signal.DEFINITION, gated);
            if (normalisedLine.trim().length() >= 5) addMatch(found, UPPERCASE_HEADING.matcher(normalisedLine), Signal.HEADING, gated);
        }
        String normalisedContent = TopicCandidateQuality.stripAssessmentMetadata(content);
        for (Pattern pattern : DEFINITIONS) addAll(found, pattern.matcher(normalisedContent), Signal.DEFINITION, gated);
        for (Pattern pattern : EMPHASIS) addAll(found, pattern.matcher(normalisedContent), Signal.EMPHASIS, gated);
        addRepeated(found, normalisedContent, gated);
        List<Candidate> result = new ArrayList<>(found.values());
        result.sort((left, right) -> Double.compare(right.confidence(), left.confidence()));
        return result;
    }

    private static void addMatch(Map<String, Candidate> found, Matcher matcher, Signal signal, boolean gated) {
        if (matcher.find()) add(found, matcher.group(1), signal, gated);
    }

    private static void addAll(Map<String, Candidate> found, Matcher matcher, Signal signal, boolean gated) {
        while (matcher.find()) add(found, matcher.group(1), signal, gated);
    }

    /** A phrase the passage keeps coming back to is worth proposing even without other markers. */
    private static void addRepeated(Map<String, Candidate> found, String content, boolean gated) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        Map<String, String> display = new LinkedHashMap<>();
        Matcher matcher = TITLE_CASE_RUN.matcher(content);
        while (matcher.find()) {
            String name = clean(matcher.group());
            String key = TopicRegistry.normalize(name);
            if (gated && !acceptable(name)) continue;
            counts.merge(key, 1, Integer::sum);
            display.putIfAbsent(key, name);
        }
        counts.forEach((key, count) -> { if (count >= 2) add(found, display.get(key), Signal.REPEATED_TERM, gated); });
    }

    private static void add(Map<String, Candidate> found, String raw, Signal signal, boolean gated) {
        String name = clean(raw);
        if (gated && !acceptable(name)) return;
        String key = TopicRegistry.normalize(name);
        Candidate existing = found.get(key);
        if (existing == null) { found.put(key, new Candidate(name, signal, signal.confidence())); return; }
        double corroborated = Math.min(.9, Math.max(existing.confidence(), signal.confidence()) + .08);
        Signal strongest = signal.confidence() > existing.signal().confidence() ? signal : existing.signal();
        found.put(key, new Candidate(existing.name(), strongest, corroborated));
    }

    /** Trims the packaging a phrase arrives in: bullets, numbering, punctuation, articles, dangling function words. */
    static String clean(String raw) {
        String value = raw == null ? "" : raw.replace('\u00a0', ' ').replaceAll("\\s+", " ").trim();
        value = value.replaceAll("^[\\s\\-–—*•·>#=~_.,;:)\\]}\"'0-9]+", "").replaceAll("[\\s\\-–—*•·=~_.,;:!?…(\\[{\"']+$", "");
        value = value.replaceAll("(?i)^(?:the|a|an)\\s+", "").replaceAll("\\s+", " ").trim();
        List<String> words = new ArrayList<>(List.of(value.isBlank() ? new String[0] : value.split(" ")));
        while (!words.isEmpty() && stripLeading(words.getFirst())) words.removeFirst();
        while (!words.isEmpty() && stripTrailing(words.getLast())) words.removeLast();
        String cleaned = String.join(" ", words);
        return cleaned.length() > 4 && cleaned.equals(cleaned.toUpperCase(Locale.ROOT)) ? titleCase(cleaned) : cleaned;
    }

    private static boolean stripLeading(String word) {
        return STOPWORDS.contains(word.toLowerCase(Locale.ROOT));
    }

    /**
     * A trailing word only falls away if it is a function word — unless it is a single capital letter,
     * which in headings and titles is far more often a roman numeral or an initial than a stray "I":
     * a history course's "World War I" would otherwise be filed as "World War".
     */
    private static boolean stripTrailing(String word) {
        if (word.length() == 1 && Character.isUpperCase(word.charAt(0))) return false;
        return STOPWORDS.contains(word.toLowerCase(Locale.ROOT));
    }

    /**
     * Structural admission is delegated to {@link TopicCandidateQuality}: the extractor proposes from
     * signals, the quality core decides what may be a topic at all. One funnel, one vocabulary of
     * rejection reasons.
     */
    static boolean acceptable(String name) {
        return TopicCandidateQuality.evaluate(name).accepted();
    }

    private static String titleCase(String value) {
        StringBuilder result = new StringBuilder();
        for (String word : value.split(" ")) {
            if (word.isBlank()) continue;
            if (!result.isEmpty()) result.append(' ');
            result.append(word.charAt(0)).append(word.substring(1).toLowerCase(Locale.ROOT));
        }
        return result.toString();
    }
}
