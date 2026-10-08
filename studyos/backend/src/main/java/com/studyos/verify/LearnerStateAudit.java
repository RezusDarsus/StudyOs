package com.studyos.verify;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Checks what an answer says about the learner against what the learner is actually recorded to have done.
 *
 * <p>Three failures were measured, and they are one failure. Asked what the learner had recently got wrong, the
 * system repeated a mistake from its <em>own</em> earlier answer and presented it as theirs. Asked what they
 * were weak at, it said there was no personal evidence — and then, one turn later, named topics they
 * "demonstrate strong understanding" of, drawn from course retrieval. Asked about mastery, it produced exact
 * percentages that nothing had measured. In every case the answer was fluent, specific, and about a learner who
 * does not exist.
 *
 * <p>The check is the same one {@link CitationAudit} applies to sources, pointed at the other kind of evidence:
 * a sentence that states something about this learner must carry a {@code [Learner: tag]} handle from the
 * recorded block, and the handle must be one the block really contains. That single requirement covers all
 * three failures without needing to detect any of them specifically — a tutor's own earlier prose has no
 * handle, an empty record issues no handles, and a percentage nobody measured is attached to no reading.
 *
 * <p>Reporting an absence is exempt. "Nothing has been assessed yet" is the correct answer before any attempt
 * exists, and an audit that demanded evidence for it would push the system towards inventing some. So would
 * flagging a target: "aim for 80%" is not a claim about where the learner is.
 *
 * <p>Structural, like the rest of this package. It settles whether a claim is anchored, never whether it is
 * true, and it knows nothing about any subject.
 */
public final class LearnerStateAudit {
    /**
     * A claim about this learner rather than about the subject. Second person plus a measurement word: the
     * course material can state what a topic is, never how one student is doing at it.
     */
    static final Pattern LEARNER_STATE = Pattern.compile("(?i)\\byour\\s+(?:weakest|strongest|weak|strong|mastery|scores?|accuracy|progress|performance|readiness|attempts?|mistakes?|misconceptions?|results?|history)\\b"
            + "|\\byou\\s+(?:scored|averaged|got|missed|failed|struggle[ds]?|answered|have\\s+not\\s+been\\s+assessed|were\\s+assessed|keep\\s+(?:getting|missing))\\b"
            + "|\\b(?:you\\s+are|you're)\\s+(?:weak|weakest|strong|strongest|ready|not\\s+ready|behind|at\\s+risk)\\b"
            + "|\\bbased\\s+on\\s+your\\s+(?:mastery|progress|attempts?|scores?|history|performance|results?)\\b"
            + "|\\b(?:mastery|confidence)\\s+(?:of|is|at)\\s+\\d+\\s*%"
            + "|\\byou\\s+(?:demonstrate|show|have\\s+shown|consistently)\\b"
            + "|\\byour\\s+(?:recent|last|previous|earlier)\\s+(?:answer|attempt|response|mistake|error)\\b");

    /** Hex only, so the block's own instruction naming {@code [Learner: tag]} is not read as a handle. */
    private static final Pattern REFERENCE = Pattern.compile("\\[{1,2}\\s*Learner:\\s*([0-9a-f]{4,64})\\s*\\]{1,2}", Pattern.CASE_INSENSITIVE);
    /**
     * Saying that nothing is recorded. Exempt because it is the one true thing to say when the record is empty,
     * and a check that demanded a citation for it would be pressing the answer to invent a measurement.
     */
    private static final Pattern REPORTS_ABSENCE = Pattern.compile("(?i)\\b(?:not\\s+(?:yet\\s+)?been\\s+assessed|not\\s+yet\\s+assessed|no\\s+(?:recorded|recent|personal|stored|prior)\\s+\\w+|nothing\\s+(?:has\\s+been\\s+)?(?:recorded|assessed|attempted)|no\\s+(?:evidence|attempts?|data|record|results?|scores?|history)\\b|haven'?t\\s+(?:been\\s+assessed|attempted|answered)|have\\s+not\\s+(?:been\\s+assessed|attempted|answered)|isn'?t\\s+enough\\s+evidence|no\\s+way\\s+to\\s+tell)");
    /** A figure the answer is aiming at, not one it is reading off. */
    private static final Pattern TARGET = Pattern.compile("(?i)\\b(?:should|aim|aiming|target|goal|need\\s+to|needs?\\s+to|want\\s+to|get\\s+to|reach|by\\s+the\\s+exam|at\\s+least|above|below|under|over|threshold|ideally|counts?\\s+as|considered)\\b");
    /** A percentage presented as this learner's current standing, which is a reading and must come from one. */
    private static final Pattern REPORTED_FIGURE = Pattern.compile("(?i)\\b(?:your|you)\\b[^.;!?\\n]{0,48}?\\b(?:mastery|scored?|scoring|accuracy|retention|recall|readiness|confidence|average|progress|relevance)\\b[^.;!?\\n]{0,48}?(\\d{1,3}(?:[.,]\\d+)?)\\s*%"
            + "|\\b(?:mastery|score|accuracy|retention|recall|readiness|confidence|average|progress|relevance)\\s+(?:of|is|at|sits\\s+at|stands\\s+at|currently)\\s+(\\d{1,3}(?:[.,]\\d+)?)\\s*%");
    private static final Pattern PERCENTAGE = Pattern.compile("(\\d{1,3}(?:[.,]\\d+)?)\\s*%");

    private LearnerStateAudit() {}

    /** Whether this sentence states something about the learner, as opposed to about the material. */
    static boolean aboutTheLearner(String sentence) { return sentence != null && LEARNER_STATE.matcher(sentence).find(); }

    /**
     * Whether this sentence carries a learner handle at all. Shape only — whether the handle is one the record
     * really issued is settled in {@link #findings}, and the two questions are separate: a sentence that names an
     * attempt is attributing its claim to the right kind of evidence even if that attempt turns out not to exist,
     * so a check about <em>which</em> evidence was cited can rely on this and stay out of the other's way.
     */
    static boolean anchoredToRecord(String sentence) { return sentence != null && REFERENCE.matcher(sentence).find(); }

    /**
     * Every claim this answer makes about the learner that the recorded block does not anchor, and every handle
     * it cites that the block does not contain.
     *
     * @param record the block as {@code LearnerEvidence} rendered it for this turn
     */
    public static List<Finding> findings(String answer, String record) {
        if (answer == null || answer.isBlank()) return List.of();
        List<Finding> findings = new ArrayList<>();
        Set<String> recorded = handles(record);
        Set<String> figures = percentages(record);
        Set<String> reported = new LinkedHashSet<>();
        Matcher cited = REFERENCE.matcher(answer);
        while (cited.find()) {
            String handle = cited.group(1).toLowerCase(Locale.ROOT);
            if (recorded.contains(handle) || !reported.add("handle|" + handle)) continue;
            findings.add(new Finding("unrecorded learner reference", "[Learner: " + handle + "]",
                    recorded.isEmpty() ? "nothing is recorded for this learner, so there is no attempt with that handle" : "the recorded handles for this turn are " + String.join(", ", recorded)));
        }
        for (String sentence : Sentences.of(answer)) {
            if (!aboutTheLearner(sentence) || REPORTS_ABSENCE.matcher(sentence).find()) continue;
            String claim = trim(sentence.replaceAll("\\s+", " ").trim());
            if (!REFERENCE.matcher(sentence).find() && reported.add("unanchored|" + claim)) {
                findings.add(new Finding("learner claim with nothing recorded behind it", claim,
                        recorded.isEmpty() ? "no attempt, score or misconception is on record for this learner, so there is no measurement this could be reporting"
                                : "the learner's recorded attempts are available and this claim cites none of them"));
            }
            String figure = reportedFigure(sentence);
            if (figure != null && !figures.contains(figure) && reported.add("figure|" + claim + "|" + figure)) {
                findings.add(new Finding("figure not in the learner's record", claim,
                        figures.isEmpty() ? "no measured figure is recorded for this learner" : "the recorded figures are " + String.join(", ", figures)));
            }
        }
        return List.copyOf(findings);
    }

    /** The percentage this sentence reports as the learner's own, or null when it reports none. */
    private static String reportedFigure(String sentence) {
        if (TARGET.matcher(sentence).find()) return null;
        Matcher matcher = REPORTED_FIGURE.matcher(sentence);
        if (!matcher.find()) return null;
        String value = matcher.group(1) == null ? matcher.group(2) : matcher.group(1);
        return normalize(value);
    }

    private static Set<String> handles(String record) {
        Set<String> handles = new LinkedHashSet<>();
        Matcher matcher = REFERENCE.matcher(record == null ? "" : record);
        while (matcher.find()) handles.add(matcher.group(1).toLowerCase(Locale.ROOT));
        return handles;
    }

    private static Set<String> percentages(String record) {
        Set<String> figures = new LinkedHashSet<>();
        Matcher matcher = PERCENTAGE.matcher(record == null ? "" : record);
        while (matcher.find()) figures.add(normalize(matcher.group(1)));
        return figures;
    }

    /** Trailing zeros and the decimal comma removed, so 40, 40.0 and "40,0" are one figure. */
    private static String normalize(String figure) {
        String value = figure.replace(',', '.');
        if (value.contains(".")) { value = value.replaceAll("0+$", ""); if (value.endsWith(".")) value = value.substring(0, value.length() - 1); }
        return value;
    }

    private static String trim(String value) { return value.length() <= 160 ? value : value.substring(0, 157) + "..."; }

    /**
     * A note naming each unanchored claim. The answer is left as written, for the same reason the other checks
     * leave it alone: saying which statement has no measurement behind it is always true, while quietly deleting
     * it would remove the reader's only clue that the system was talking about nobody.
     */
    public static String note(List<Finding> findings) {
        if (findings.isEmpty()) return "";
        StringBuilder note = new StringBuilder("**Learner-record check** — " + (findings.size() == 1 ? "this statement about you is not backed" : "these statements about you are not backed")
                + " by anything recorded from your own attempts, so treat " + (findings.size() == 1 ? "it" : "them") + " as unverified:\n");
        for (Finding finding : findings) note.append("- ").append(finding.kind()).append(": \"").append(finding.claim()).append("\" — ").append(finding.detail()).append(".\n");
        return note.toString();
    }

    /**
     * How much of what this answer says about the learner is anchored, as counts so a harness can pool them
     * across turns rather than average per-turn ratios.
     */
    public static Coverage coverage(String answer, String record) {
        if (answer == null || answer.isBlank()) return new Coverage(0, 0, 0, 0);
        Set<String> recorded = handles(record);
        int references = 0, recordedReferences = 0;
        Matcher cited = REFERENCE.matcher(answer);
        while (cited.find()) { references++; if (recorded.contains(cited.group(1).toLowerCase(Locale.ROOT))) recordedReferences++; }
        int claims = 0, anchored = 0;
        for (String sentence : Sentences.of(answer)) {
            if (!aboutTheLearner(sentence) || REPORTS_ABSENCE.matcher(sentence).find()) continue;
            claims++;
            if (REFERENCE.matcher(sentence).find()) anchored++;
        }
        return new Coverage(claims, anchored, references, recordedReferences);
    }

    /** One unanchored claim: what kind of gap it is, what was written, and what the record holds instead. */
    public record Finding(String kind, String claim, String detail) {}

    /**
     * @param learnerClaims sentences asserting something about the learner
     * @param anchoredClaims how many of those carry a recorded handle
     * @param references handles the answer cites
     * @param recordedReferences how many of those the block actually contains
     */
    public record Coverage(int learnerClaims, int anchoredClaims, int references, int recordedReferences) {
        /** Of the handles cited, the share that exist. One when none were cited. */
        public double precision() { return references == 0 ? 1 : (double) recordedReferences / references; }
        /** Of the claims about the learner, the share that are anchored. One when none were made. */
        public double recall() { return learnerClaims == 0 ? 1 : (double) anchoredClaims / learnerClaims; }
    }
}
