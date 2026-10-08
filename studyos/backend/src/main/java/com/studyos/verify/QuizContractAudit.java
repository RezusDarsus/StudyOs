package com.studyos.verify;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Checks that a turn which asked to be tested was answered by asking rather than by telling.
 *
 * <p>Routing a quiz request correctly is only the first half. In the measured run six of the eight quiz turns
 * still failed after being labelled: some returned a lecture on the topic with no question in them at all, and
 * one printed the whole quiz with every correct answer visible beside it. A quiz whose answers are on the page
 * is not a quiz, and neither is an explanation — in both cases the learner has been given the thing they asked
 * to be measured on.
 *
 * <p>Three things are decidable here without a model, and only these three:
 * <ul>
 *   <li><em>An answer revealed.</em> Either a section labelled as a key — "Answers", "Solutions", "Expected
 *       response" — or a sentence that states the answer in place. This is the defect the learner must never
 *       see, so it drives removal rather than a warning: see {@link #withoutRevealedAnswers(String)}.</li>
 *   <li><em>Nothing asked.</em> An answer with no numbered items and no question in it did not test anybody,
 *       whatever heading it carries.</li>
 *   <li><em>The wrong number of questions.</em> "Three questions" means three, and "one at a time" means one;
 *       both were asked for and neither was honoured.</li>
 * </ul>
 *
 * <p>Structural and subject-general, like the audits beside it. Nothing here knows what a subject is: a key is
 * recognised from how an answer labels one and a question from the fact that it asks something, and both are
 * the same in a chemistry course and a law one. The labels are listed in several languages and read with
 * accents stripped, for the same reason the router's request verbs are — a Spanish quiz that reveals its
 * answers under "Respuestas" is the identical defect.
 */
public final class QuizContractAudit {
    /**
     * A line that is nothing but a key's label. Anchored to the whole line so that the invitation a quiz closes
     * with — "Answer in your own words and I will mark them" — cannot be read as one: that line says more than
     * the label, which is exactly what distinguishes asking for an answer from supplying one.
     *
     * <p>An unqualified label has to be plural. A worksheet writes "Answer:" as the blank the learner fills in,
     * and deleting the rest of a quiz because one question offered a place to write would be the audit doing
     * more damage than the defect. A singular label counts only when something else in it says key — "Answer
     * key", "Expected answer", "Model answer" — because none of those is a blank.
     */
    private static final Pattern KEY_HEADING = Pattern.compile(
            "^\\s*(?:#{1,6}\\s*)?[*_>\\s]*(?:answer\\s*keys?|solution\\s*keys?|marking\\s+scheme|correction"
            + "|(?:expected|model|official|worked)\\s+(?:answers?|responses?|solutions?)"
            + "|answers|solutions|losungen|musterlosungen|antworten|respuestas|soluciones|risposte|soluzioni|reponses|corrige|respostas|solucoes)"
            + "[*_:\\s]*$", Pattern.CASE_INSENSITIVE);

    /**
     * The answer stated in place rather than under a heading. Every alternative names the answer as such: a
     * question is free to contain a figure, an equation or a worked premise, and reading those as a reveal would
     * flag the questions themselves. A label followed by nothing but blanks is a field for the learner to fill,
     * not a disclosure, which is why the second alternative demands something substantive after the colon.
     */
    private static final Pattern REVEAL = Pattern.compile(
            "\\b(?:correct|right|expected|model|official)\\s+(?:answer|solution|response)s?\\b"
            + "|\\b(?:answer|solution)s?\\s*[:=]\\s*(?![_\\-.\\s]*$)[^_\\s]"
            + "|\\bthe\\s+answers?\\s+(?:is|are|was|were|would\\s+be|will\\s+be|becomes?)\\b"
            + "|\\bthe\\s+solution\\s+(?:is|was|would\\s+be)\\b"
            + "|\\brespuesta\\s+correcta\\b|\\brichtige\\s+antwort\\b|\\brisposta\\s+corretta\\b|\\breponse\\s+correcte\\b"
            + "|\\bresposta\\s+correta\\b", Pattern.CASE_INSENSITIVE);

    /**
     * An item's own number, at the start of its line. "Question 3", "3." and "3)" are one thing written three
     * ways, and the optional noun is there so a bare ordinal counts too — a model that numbers its items and
     * never writes the word "question" has still asked three questions.
     */
    private static final Pattern ORDINAL = Pattern.compile(
            "^\\s*(?:#{1,6}\\s*)?[*_>\\s]*(?:(?:question|q|item|frage|pregunta|domanda|questao|quesito)\\s*)?(\\d{1,2})\\s*[.):\\-\\u2014]",
            Pattern.CASE_INSENSITIVE);
    /** The same, for a heading that names the item without punctuating after the number: "## Question 2". */
    private static final Pattern NAMED_ORDINAL = Pattern.compile(
            "^\\s*(?:#{1,6}\\s*)?[*_>\\s]*(?:question|frage|pregunta|domanda|questao|quesito)\\s*(\\d{1,2})\\b",
            Pattern.CASE_INSENSITIVE);

    private QuizContractAudit() {}

    /**
     * Everything this answer does that a quiz must not, given how many questions were asked for. A
     * {@code requestedCount} of zero or less means the request named no number, so the count is not checked —
     * the system's own default is not something the learner can be held to have asked for.
     */
    public static List<Finding> findings(String answer, int requestedCount) {
        if (answer == null || answer.isBlank()) return List.of();
        List<Finding> findings = new ArrayList<>();
        Set<String> reported = new LinkedHashSet<>();
        for (String line : answer.split("\\R")) {
            if (KEY_HEADING.matcher(strip(line)).matches() && reported.add("key|" + strip(line).trim()))
                findings.add(new Finding("answer key section", trim(line.trim()),
                        "a quiz the learner has not attempted must carry no key"));
        }
        for (String sentence : Sentences.of(answer)) {
            Matcher reveal = REVEAL.matcher(strip(sentence));
            if (reveal.find() && reported.add("reveal|" + strip(sentence).trim()))
                findings.add(new Finding("answer revealed", trim(sentence.trim()),
                        "it states the answer instead of leaving it to the learner"));
        }
        int asked = questionsAsked(answer);
        if (asked == 0) findings.add(new Finding("nothing asked", trim(firstLine(answer)),
                "the turn asked to be tested and this reply asks nothing"));
        else if (requestedCount > 0 && asked != requestedCount)
            findings.add(new Finding("question count", asked + " asked",
                    "the learner asked for " + requestedCount));
        return List.copyOf(findings);
    }

    /**
     * How many questions this answer actually asks. Numbered items are counted first and only as an unbroken run
     * from one, so a stray figure at the start of a line cannot inflate the count and a repeated number cannot
     * either. An answer that numbers nothing is counted by its questions, which is what a single-question quiz
     * looks like when the model sees no reason to label it "Question 1".
     */
    public static int questionsAsked(String answer) {
        if (answer == null || answer.isBlank()) return 0;
        TreeSet<Integer> ordinals = new TreeSet<>();
        for (String line : answer.split("\\R")) {
            Matcher named = NAMED_ORDINAL.matcher(line);
            Matcher plain = ORDINAL.matcher(line);
            if (named.find()) ordinals.add(Integer.parseInt(named.group(1)));
            else if (plain.find()) ordinals.add(Integer.parseInt(plain.group(1)));
        }
        int run = 0;
        for (int expected = 1; ordinals.contains(expected); expected++) run = expected;
        if (run > 0) return run;
        int questions = 0;
        for (String sentence : Sentences.of(answer)) if (sentence.trim().endsWith("?")) questions++;
        return questions;
    }

    /**
     * The same answer with everything that discloses an answer taken out: a key section and every line under it
     * to the next heading, and any remaining sentence that states an answer in place.
     *
     * <p>Removal rather than a warning, which is the opposite of how every other audit in this package ends. A
     * note saying "this quiz shows you its answers" would be a warning printed underneath the answers, and the
     * learner has already read them by then. Nothing is lost by cutting: a key belongs to the marking turn that
     * comes after an attempt, not to the turn that sets the questions.
     */
    public static String withoutRevealedAnswers(String answer) {
        if (answer == null || answer.isBlank()) return answer;
        List<String> kept = new ArrayList<>();
        boolean inKey = false;
        for (String line : answer.split("\\R", -1)) {
            String bare = strip(line);
            if (KEY_HEADING.matcher(bare).matches()) { inKey = true; continue; }
            // A key's own entries are numbered, so an item number cannot end one. What ends it is a heading, or a
            // line that asks something — a key does not ask, so a question below one belongs to the quiz again.
            if (inKey && (line.trim().startsWith("#") || line.trim().endsWith("?"))) inKey = false;
            if (inKey) continue;
            if (REVEAL.matcher(bare).find()) { String remainder = withoutRevealingSentences(line); if (remainder.isBlank()) continue; kept.add(remainder); }
            else kept.add(line);
        }
        return String.join("\n", kept).replaceAll("\n{3,}", "\n\n").trim();
    }

    /** A revealing sentence removed from the line it shares with the question it belongs to. */
    private static String withoutRevealingSentences(String line) {
        StringBuilder kept = new StringBuilder();
        for (String sentence : Sentences.of(line)) if (!REVEAL.matcher(strip(sentence)).find()) kept.append(sentence);
        return kept.toString().trim();
    }

    /** Accents removed so a label spelled the way its language spells it still reads as that label. */
    private static String strip(String value) {
        return Normalizer.normalize(value, Normalizer.Form.NFD).replaceAll("\\p{M}+", "").toLowerCase(Locale.ROOT);
    }

    private static String firstLine(String answer) {
        for (String line : answer.split("\\R")) if (!line.isBlank()) return line.trim();
        return answer.trim();
    }

    private static String trim(String value) { return value.length() <= 160 ? value : value.substring(0, 157) + "..."; }

    /** One way this reply failed to be a quiz. */
    public record Finding(String kind, String claim, String detail) {}
}
