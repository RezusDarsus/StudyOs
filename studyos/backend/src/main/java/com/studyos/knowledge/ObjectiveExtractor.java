package com.studyos.knowledge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finds learning objectives written in a document, and reads the cognitive demand off the verb each one leads
 * with. Structure and phrasing only — nothing here knows what subject the objectives are about, exactly as
 * {@link TopicSignalExtractor} does not.
 *
 * <p>The verb lists are pedagogical vocabulary, not course vocabulary: "define", "compare" and "prove" describe
 * what the learner is being asked to do with whatever the material happens to contain. They are the same lists
 * whether the course is coding theory or contract law, which is what separates them from a subject lexicon —
 * a subject's terms have to come from the retrieved material and do, everywhere in StudyOS.
 *
 * <p>An objective whose verb is not in those lists keeps a null level rather than a guessed one. Assessment
 * generation aims at a level, and a wrong level aims the whole question wrongly; no level at all lets the caller
 * fall back to the ladder, which knows where this learner actually is.
 */
public final class ObjectiveExtractor {
    private ObjectiveExtractor() {}

    /** How the statement was recognised, which is worth keeping: the cues are not equally strong. */
    public enum Cue {
        /** "…will be able to X" — the document states the objective outright. */
        STATED_OUTCOME,
        /** A list item under an "Objectives"/"Learning outcomes" heading. */
        OBJECTIVES_LIST,
        /** Not recognised here at all: a source that already knows it holds objectives handed this one over. */
        DECLARED
    }

    /** @param cognitiveLevel a {@link com.studyos.adaptive.CognitiveLevel} rank 1..6, or null when unrecognised. */
    public record Objective(String statement, Integer cognitiveLevel, Cue cue) {}

    private static final int MIN_WORDS = 3;
    private static final int MAX_WORDS = 40;
    private static final int MAX_LIST_ITEMS = 12;

    /** "you will be able to", "students should be able to", "be able to" — the phrase, however it is introduced. */
    private static final Pattern ABLE_TO = Pattern.compile("(?i)\\b(?:be|being)\\s+able\\s+to\\s+(.+)$");
    /** The other common phrasing: the outcome stated directly of the reader. */
    private static final Pattern WILL_VERB = Pattern.compile("(?i)\\b(?:you|students?|learners?|the\\s+reader|we)\\s+(?:will|shall|should|must|can)\\s+(?:be\\s+expected\\s+to\\s+|then\\s+|now\\s+)?((?:learn|understand|know|master)\\b.+)$");
    private static final Pattern OBJECTIVES_HEADING = Pattern.compile("(?i)^\\s*(?:\\d+(?:\\.\\d+)*[.)]?\\s*)?(?:#{1,6}\\s*)?(?:\\*\\*)?(?:learning\\s+|course\\s+|module\\s+|unit\\s+|lecture\\s+|chapter\\s+|session\\s+)?(?:objectives?|outcomes?|goals?|aims?)(?:\\s+of\\s+this\\s+\\w+)?(?:\\*\\*)?\\s*[:.\\-–—]?\\s*$");
    private static final Pattern LIST_ITEM = Pattern.compile("^\\s*(?:[-*•·–—>]|\\(?[a-z0-9]{1,3}[.)])\\s+(\\S.*)$");
    private static final Pattern SENTENCE_END = Pattern.compile("(?<=[.!?])\\s+");

    /**
     * Verb to cognitive rank. One map rather than six lists so a verb cannot end up in two places, and so the
     * lookup is the same cost whatever the phrasing. Both spellings are present where English has two.
     */
    private static final Map<String, Integer> LEVELS = new LinkedHashMap<>();
    static {
        put(1, "define", "state", "list", "name", "recall", "identify", "label", "recognise", "recognize", "quote", "match", "memorise", "memorize", "enumerate", "reproduce");
        put(2, "explain", "describe", "summarise", "summarize", "interpret", "paraphrase", "illustrate", "classify", "distinguish", "discuss", "outline", "clarify", "restate", "report");
        put(3, "apply", "use", "compute", "calculate", "solve", "implement", "execute", "perform", "demonstrate", "convert", "translate", "determine", "estimate", "simulate", "operate");
        put(4, "analyse", "analyze", "compare", "contrast", "differentiate", "examine", "investigate", "deduce", "justify", "trace", "decompose", "diagnose", "test", "verify", "explore");
        put(5, "combine", "integrate", "relate", "derive", "generalise", "generalize", "synthesise", "synthesize", "model", "plan", "extend", "adapt", "reconcile", "connect");
        put(6, "design", "create", "prove", "evaluate", "critique", "judge", "assess", "defend", "formulate", "optimise", "optimize", "construct", "develop", "propose", "invent", "argue", "compose");
    }
    private static void put(int level, String... verbs) { for (String verb : verbs) LEVELS.put(verb, level); }

    /** Every objective this text states, in the order it states them, deduplicated by wording. */
    public static List<Objective> extract(String text) {
        String content = text == null ? "" : text;
        if (content.isBlank()) return List.of();
        Map<String, Objective> found = new LinkedHashMap<>();
        String[] lines = content.split("\\R");
        for (int index = 0; index < lines.length; index++) {
            if (OBJECTIVES_HEADING.matcher(lines[index]).matches()) index = collectList(found, lines, index + 1) - 1;
            else for (String sentence : SENTENCE_END.split(lines[index])) add(found, sentence, Cue.STATED_OUTCOME);
        }
        return List.copyOf(found.values());
    }

    /**
     * A statement from a source that has already declared it an objective — a syllabus's own objectives list, a
     * generated lesson's objective — put into the same form as an extracted one, or null when it is not a
     * statement at all. Returned rather than stored so one objective written two ways in two sources is stored
     * once.
     *
     * <p>Unlike an extracted list item this is not required to lead with a recognised verb. The instructor calling
     * it an objective is what makes it one; StudyOS is in no position to overrule that because the verb is
     * unfamiliar. What it is still required to be is a statement — too short or too long to be one and it is
     * rejected, because a syllabus's objectives array also collects headings and whole paragraphs.
     */
    public static String declared(String raw) { return clause(raw, Cue.DECLARED); }

    /**
     * One statement's level, exposed so a caller with objectives from elsewhere — a syllabus, a generated lesson
     * — can classify them the same way. Only the opening words are looked at: an objective leads with what the
     * learner must do, and a verb further in belongs to the thing being done to ("explain how to compute X" is
     * an explanation).
     */
    public static Integer level(String statement) {
        String[] words = TopicRegistry.normalize(statement).split(" ");
        for (int index = 0; index < Math.min(4, words.length); index++) {
            Integer level = lookup(words[index]);
            if (level != null) return level;
        }
        return null;
    }

    /**
     * A list under an objectives heading, stopping at the first line that is not one of its items. A blank line
     * inside a list is skipped rather than treated as the end, because a PDF's extracted text puts one between
     * every bullet often enough that stopping there would find one objective out of eight.
     */
    private static int collectList(Map<String, Objective> found, String[] lines, int start) {
        int items = 0;
        int index = start;
        int blanks = 0;
        while (index < lines.length && items < MAX_LIST_ITEMS) {
            String line = lines[index];
            if (line.isBlank()) { if (++blanks > 1) break; index++; continue; }
            Matcher item = LIST_ITEM.matcher(line);
            if (!item.find()) break;
            blanks = 0;
            if (add(found, item.group(1), Cue.OBJECTIVES_LIST)) items++;
            index++;
        }
        return Math.max(index, start);
    }

    private static boolean add(Map<String, Objective> found, String raw, Cue cue) {
        String clause = clause(raw, cue);
        if (clause == null) return false;
        String key = TopicRegistry.normalize(clause);
        if (key.isBlank() || found.containsKey(key)) return false;
        found.put(key, new Objective(clause, level(clause), cue));
        return true;
    }

    /**
     * The objective itself, without the sentence that introduced it. "By the end of this chapter you will be able
     * to decode a cyclic code" is stored as "Decode a cyclic code." — one form whatever the phrasing around it,
     * so the same objective stated two ways in two documents is stored once.
     */
    private static String clause(String raw, Cue cue) {
        String line = raw == null ? "" : raw.replaceAll("[\\s\\u00a0]+", " ").trim();
        if (line.isEmpty()) return null;
        Matcher able = ABLE_TO.matcher(line);
        Matcher will = WILL_VERB.matcher(line);
        String body = able.find() ? able.group(1) : will.find() ? will.group(1) : cue == Cue.STATED_OUTCOME ? null : line;
        if (body == null) return null;
        String cleaned = body.replaceAll("^[\\s:;,\\-–—*•·]+", "").replaceAll("(?i)^(?:to|then|also|correctly|properly)\\s+", "").replaceAll("[\\s;,]+$", "").trim();
        cleaned = cleaned.replaceAll("[.!?]+$", "").trim();
        if (cleaned.isEmpty()) return null;
        int words = cleaned.split("\\s+").length;
        if (words < MIN_WORDS || words > MAX_WORDS) return null;
        // A list item under an objectives heading has to look like something to do, or every table of contents
        // entry under a heading called "Goals" becomes an objective. A stated outcome has already proved itself.
        if (cue == Cue.OBJECTIVES_LIST && level(cleaned) == null) return null;
        return Character.toUpperCase(cleaned.charAt(0)) + cleaned.substring(1) + ".";
    }

    /**
     * The verb's level, trying the regular English endings an objective might inflect it with, so
     * "defines"/"defining"/"defined" all reach "define" and "explaining" reaches "explain". Both the
     * consonant-ending and the dropped-e forms are tried because the two conjugation classes are not
     * distinguishable from the surface form.
     */
    private static Integer lookup(String word) {
        if (word.isBlank()) return null;
        Integer direct = LEVELS.get(word);
        if (direct != null) return direct;
        for (String candidate : derivations(word)) {
            Integer level = LEVELS.get(candidate);
            if (level != null) return level;
        }
        return null;
    }

    private static List<String> derivations(String word) {
        List<String> candidates = new ArrayList<>();
        if (word.endsWith("ing") && word.length() > 5) { String base = word.substring(0, word.length() - 3); candidates.add(base); candidates.add(base + "e"); }
        if (word.endsWith("ed") && word.length() > 4) { String base = word.substring(0, word.length() - 2); candidates.add(base); candidates.add(base + "e"); }
        if (word.endsWith("es") && word.length() > 4) candidates.add(word.substring(0, word.length() - 2));
        if (word.endsWith("s") && word.length() > 4) candidates.add(word.substring(0, word.length() - 1));
        return candidates;
    }
}
