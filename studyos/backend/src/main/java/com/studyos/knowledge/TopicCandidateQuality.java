package com.studyos.knowledge;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Deterministic, DB-free quality gate for topic candidates — the structural answer to "should this
 * fragment even be a learnable concept?". Deliberately NOT a giant English blacklist: the primary
 * rules are shape-based (letters, tokens, assessment packaging), and the bounded word lists cover
 * only what is generic in every subject. A candidate that passes here is still routed through
 * {@link TopicRegistry} and reconciliation before it becomes database truth.
 *
 * <p>Two concerns stay separate: {@link #evaluate} decides admission of a candidate as a topic at
 * all, while course-level topic importance is a measured quantity owned by the topic model.
 * Importance never rescues a rejected candidate.
 *
 * <p>VERSION names the extraction policy that produced a topic universe, so benchmark comparisons
 * can say which cleaner ran. Rules use only source/extraction characteristics — never held-out exam
 * knowledge.
 */
public final class TopicCandidateQuality {

    private TopicCandidateQuality() {}

    /** Identifier of the extraction/cleaning policy; recorded in benchmark and backtest snapshots. */
    public static final String VERSION = "TOPIC_EXTRACTION_V2";

    public enum RejectionReason {
        EMPTY, TOO_SHORT, VERB_ONLY, INSTRUCTION_FRAGMENT, POINT_MARKER, QUESTION_METADATA,
        BOILERPLATE, PURE_NUMBER, PURE_SYMBOL, STRUCTURAL_LABEL, LOW_INFORMATION, VALID
    }

    /**
     * @param accepted whether the candidate may proceed to the topic registry
     * @param reason why it was admitted or rejected
     * @param qualityScore explainable 0..1 signal (token count, shape); never a hidden model
     * @param salvaged the cleaned candidate the decision was made on, when cleaning changed it
     */
    public record Decision(boolean accepted, RejectionReason reason, double qualityScore, String salvaged) {}

    // ---------------------------------------------------------------- bounded word lists

    /**
     * Assessment command verbs. A candidate whose first word is one of these is an instruction, not a
     * concept: "Show that Lamport timestamps…", "Calculate the CRC remainder…". Matched on the whole
     * Unicode word, so "Compare-and-swap", "Consideration", "Derivative", "State Machine" and
     * "List comprehension" are never touched. English first; a deliberately small German/Russian set,
     * bounded and tested. Other scripts pass on shape alone.
     */
    private static final Set<String> INSTRUCTION_VERBS = Set.of(
            "show", "prove", "give", "calculate", "compute", "explain", "describe", "define", "discuss",
            "compare", "derive", "evaluate", "analyze", "analyse", "demonstrate", "determine", "identify",
            "choose", "select", "construct", "decompose", "sketch", "draw", "write", "illustrate",
            "outline", "consider", "assume", "suppose", "using", "use", "know", "known", "find",
            // German assessment verbs
            "berechne", "berechnen", "bestimmen", "erkläre", "erklären", "zeigen", "beweisen", "beschreiben",
            "zeichnen", "begründen",
            // Russian assessment verbs (matched on the raw word; ASCII normalization strips Cyrillic)
            "вычислить", "вычислите", "докажите", "доказать", "объясните", "объяснить", "определите",
            "определить", "найдите", "найти", "постройте");

    /**
     * Single-word candidates that carry almost no learnable identity in ANY subject. Bounded on
     * purpose; subject-specific words like "divisor", "fairness" or "encryption" stay admissible.
     */
    private static final Set<String> GENERIC_SINGLE_WORDS = Set.of(
            "thing", "case", "way", "type", "part", "result", "idea", "hint", "important", "enabled",
            "execution", "exit", "naive", "fair", "system", "method", "time", "node", "nodes", "stuff",
            "content", "point", "points", "mark", "marks", "example", "question", "answer", "solution",
            "problem", "exercise", "task", "overview", "summary");

    /** Isolated document scaffolding: matches only when the WHOLE candidate is the label (± number). */
    private static final Pattern STRUCTURAL = Pattern.compile(
            "^(?:chapter|lecture|section|subsection|module|unit|week|day|part|lesson|slide|page|figure|fig|table|eq|equation|listing|algorithm|example|examples|exercise|exercises|problem|problems|homework|assignment|solution|solutions|answer|answers|proof|theorem|lemma|corollary|proposition|definition|definitions|remark|remarks|note|notes|summary|overview|outline|agenda|objectives|goals|introduction|conclusion|conclusions|discussion|references|bibliography|appendix|acknowledgements|contents|index|abstract|questions|review|recap|reading|readings|syllabus|schedule|grading|policy|policies|office hours|learning outcomes|hint|hints|intended meaning|see also|main article|external links|further information|key terms|glossary|foreword|preface"
                    + "|inhaltsverzeichnis|literatur|anhang|übersicht|zusammenfassung|aufgaben|lösung|lösungen|übung|übungen"
                    + "|введение|заключение|литература|содержание|приложение|глава|упражнение|упражнения|решение|решения"
                    + ")(?:\\s+\\d+(?:\\s+\\d+)*)?$");

    /** Question numbering: Q1, Question 4, Problem 3, Task 2, Exercise 7, Aufgabe 5. */
    private static final Pattern QUESTION_METADATA = Pattern.compile(
            "^(?:q\\s*\\d*|question\\s*\\d+|problem\\s*\\d+|task\\s*\\d+|exercise\\s*\\d+|ex\\s*\\d+|prob\\s*\\d+|aufgabe\\s*\\d+|задача\\s*\\d+|задание\\s*\\d+)$");

    /** Standalone point/marks metadata: "20 Pt", "10 marks", "5 credit points", "10 Punkte". */
    private static final Pattern POINT_MARKER = Pattern.compile(
            "^\\d+(?:[.,]\\d+)?\\s*(?:pt|pts|p|points?|marks?|pct|%|percent|credit points|credits?|bonus points|punkte|prozent)$");

    private static final Pattern LETTER = Pattern.compile("\\p{L}");

    /** Parenthesised bare machine tokens: "(0)", "(0x1F)" — code fragments, not concept text. */
    private static final Pattern PAREN_CODE = Pattern.compile("\\s*[\\[(]\\s*(?:0x[0-9a-f]+|\\d+)\\s*[\\])]", Pattern.CASE_INSENSITIVE);

    /** OCR/encoding damage: replacement characters or runs of question marks. */
    private static final Pattern GARBLED = Pattern.compile("[\uFFFD]|\\?\\?+");

    /** Mojibake repair: "One???s Complement" → "One's Complement", only letter?…?letter. */
    private static final Pattern MOJIBAKE_APOSTROPHE = Pattern.compile("(\\p{L})[\\uFFFD?]{1,}(\\p{L})");

    // ---------------------------------------------------------------- evaluation

    public static Decision evaluate(String rawName) {
        if (rawName == null || normalizeWhitespace(rawName).isBlank()) return reject(RejectionReason.EMPTY, .0, null);
        // Damage is judged on the raw name: clean() would trim "withI???" to "withI" and the evidence
        // would vanish. Damage that mojibake repair cannot fix (or a bare code token) disqualifies.
        String repaired = MOJIBAKE_APOSTROPHE.matcher(rawName).replaceAll("$1'$2");
        if (GARBLED.matcher(repaired).find()) return reject(RejectionReason.BOILERPLATE, .1, null);
        if (PAREN_CODE.matcher(repaired).find()) return reject(RejectionReason.BOILERPLATE, .15, null);
        // Standalone packaging ("(20 Pt)", "Q1") reports its true reason even though salvage strips it.
        String rawNormalized = TopicRegistry.normalize(rawName);
        if (POINT_MARKER.matcher(rawNormalized).matches()) return reject(RejectionReason.POINT_MARKER, .05, null);
        if (QUESTION_METADATA.matcher(rawNormalized).matches()) return reject(RejectionReason.QUESTION_METADATA, .05, null);

        String candidate = salvage(rawName);
        boolean changed = candidate != null && !candidate.equals(normalizeWhitespace(rawName));
        String salvaged = changed ? candidate : null;
        if (candidate == null || candidate.isBlank()) return reject(RejectionReason.EMPTY, .0, salvaged);
        if (!LETTER.matcher(candidate).find()) {
            return reject(candidate.matches(".*\\d.*") ? RejectionReason.PURE_NUMBER : RejectionReason.PURE_SYMBOL, .05, salvaged);
        }

        String normalized = TopicRegistry.normalize(candidate);
        String lower = candidate.toLowerCase(Locale.ROOT).trim();
        // Unicode-aware words; hyphens stay inside a token, so "Compare-and-swap" and "SHA-256" are
        // one word each, and Cyrillic tokens survive for the bounded Russian verb list.
        String[] words = lower.split("[^\\p{L}\\p{N}\\-]+");
        String first = words[0];

        if (POINT_MARKER.matcher(normalized).matches()) return reject(RejectionReason.POINT_MARKER, .05, salvaged);
        if (QUESTION_METADATA.matcher(normalized).matches()) return reject(RejectionReason.QUESTION_METADATA, .05, salvaged);
        if (STRUCTURAL.matcher(normalized).matches()) return reject(RejectionReason.STRUCTURAL_LABEL, .1, salvaged);
        if (candidate.length() < 3) return reject(RejectionReason.TOO_SHORT, .1, salvaged);
        if (words.length == 1 && INSTRUCTION_VERBS.contains(first)) return reject(RejectionReason.VERB_ONLY, .1, salvaged);
        if (words.length >= 2 && INSTRUCTION_VERBS.contains(first)) return reject(RejectionReason.INSTRUCTION_FRAGMENT, .2, salvaged);
        // A nine-word "topic" is a captured sentence, not a concept phrase (matches the extractor's
        // long-standing cap, which this gate now owns).
        if (words.length > 8) return reject(RejectionReason.INSTRUCTION_FRAGMENT, .2, salvaged);
        // Generic-word rule is inherently script-specific; other scripts are judged on shape above.
        if (words.length == 1 && GENERIC_SINGLE_WORDS.contains(first)) return reject(RejectionReason.LOW_INFORMATION, .2, salvaged);

        return new Decision(true, RejectionReason.VALID, score(words.length, candidate), salvaged);
    }

    /** Only the salvaged spelling is accepted into the registry, so junk packaging never persists. */
    public static String salvageName(String rawName) {
        Decision decision = evaluate(rawName);
        return decision.accepted() ? decision.salvaged() : null;
    }

    // ---------------------------------------------------------------- extraction-text normalization

    /**
     * Normalizes assessment packaging out of EXTRACTION text before any pattern sees it — the
     * persisted source text is never mutated. Handles question prefixes ("Q3.", "1)", "Question 4:",
     * "Task 2 —", "Aufgabe 5:"), point markers in brackets ("(20 Pt)", "[10 marks]") and trailing
     * bare marks ("… 10 marks"). Numbered prefixes are only stripped when real prose follows, so a
     * line like "802.11 is a Wi-Fi standard" survives untouched.
     */
    public static String stripAssessmentMetadata(String text) {
        if (text == null || text.isBlank()) return text == null ? "" : text;
        String value = text;
        value = value.replaceAll("(?im)^[ \\t]*(?:q\\s*\\d+|[qQ]uestion\\s*\\d+|[pP]roblem\\s*\\d+|[tT]ask\\s*\\d+|[eE]xercise\\s*\\d+|ex\\.?\\s*\\d+|[aA]ufgabe\\s*\\d+|задача\\s*\\d+|задание\\s*\\d+)\\s*[.)\\-–—:]?\\s*", "");
        value = value.replaceAll("(?m)^[ \\t]*\\d+(?:\\.\\d+)*[.)][ \\t]+(?=[A-Z\"'(])", "");
        value = stripPointMarkers(value);
        return value.replaceAll("[ \\t]{2,}", " ");
    }

    /**
     * Strips ONLY point/marks packaging, keeping question numbering intact: heading patterns key on
     * the "3." prefix, and the captured title is what the quality gate then judges. Use for the
     * per-line heading pass; {@link #stripAssessmentMetadata} is the full normalization.
     */
    public static String stripPointMarkers(String text) {
        if (text == null || text.isBlank()) return text == null ? "" : text;
        String value = text;
        value = value.replaceAll("(?i)[ ]?[\\[(]\\s*\\d+(?:[.,]\\d+)?\\s*(?:pt|pts|points?|marks?|credit points|credits?|bonus points|punkte|prozent|%|баллов|балла|балл)\\s*[\\])]", " ");
        value = value.replaceAll("(?im)[ \\t]+\\d+(?:[.,]\\d+)?\\s*(?:marks?|points?|pt|pts|credit points|bonus points|punkte|баллов|балла)\\s*$", "");
        return value.replaceAll("[ \\t]{2,}", " ");
    }

    // ---------------------------------------------------------------- salvage

    /**
     * Best recoverable concept from an already-persisted name: repairs mojibake, strips assessment
     * packaging and code tokens. Deliberately gentler than the extractor's {@code clean()}: digits
     * are never stripped, because "3NF", "2-phase commit" and "802.11" are concepts, not numbering.
     * Returns null only for empty input; whether the salvaged form is admissible is still
     * {@link #evaluate}'s call.
     */
    public static String salvage(String rawName) {
        if (rawName == null) return null;
        String value = MOJIBAKE_APOSTROPHE.matcher(rawName).replaceAll("$1'$2");
        value = stripAssessmentMetadata(value);
        value = PAREN_CODE.matcher(value).replaceAll(" ");
        // A trailing parenthesised unit the bracket regex above could not fully consume.
        value = value.replaceAll("\\s*[\\[(][^\\])]{0,40}?\\b(?:pt|pts|points?|marks?|credit points|credits?|bonus points|punkte)\\s*[\\])]\\s*$", "");
        value = value.replaceAll("^[\\s\\-–—*•·>#=~_.,;:)\\]}\"']+", "").replaceAll("[\\s\\-–—*•·=~_,;:!?…(\\[{\"']+$", "");
        value = value.replaceAll("(?i)^(?:the|a|an)\\s+", "").replaceAll("\\s+", " ").trim();
        if (value.isBlank()) return null;
        return value.length() > 4 && value.equals(value.toUpperCase(Locale.ROOT)) ? titleCase(value) : value;
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

    private static double score(int wordCount, String candidate) {
        double base = wordCount >= 3 ? .8 : wordCount == 2 ? .65 : .45;
        boolean shaped = candidate.matches(".*[A-Z].*");
        return Math.min(.95, base + (shaped ? .1 : 0));
    }

    private static Decision reject(RejectionReason reason, double qualityScore, String salvaged) {
        return new Decision(false, reason, qualityScore, salvaged);
    }

    private static String normalizeWhitespace(String value) { return value == null ? "" : value.replaceAll("\\s+", " ").trim(); }
}
