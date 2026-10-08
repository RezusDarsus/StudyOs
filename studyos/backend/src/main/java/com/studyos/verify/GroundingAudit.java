package com.studyos.verify;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Checks each cited claim against the evidence the answer was written from, claim by claim rather than answer
 * by answer.
 *
 * <p>{@link CitationAudit} settles whether a citation points at something that was actually retrieved. It
 * cannot settle the next question: whether the sentence attached to it says what that page says. A citation to
 * a real page, carrying a figure the page never states, passes every check the reference-level audit makes.
 *
 * <p>What can be decided without a model, and is decided here, is whether the specifics a cited sentence
 * asserts occur in the evidence at all. Two kinds, held to different standards because they deserve different
 * standards:
 * <ul>
 *   <li>A <em>figure</em> — a quantity, a modulus, a year, a count — attributed to a source that does not
 *       contain it. Precise enough to tell the learner about: numbers are not paraphrasable, so a figure absent
 *       from the evidence was either derived (which the computation audit governs and which this check skips
 *       when the sentence shows its arithmetic) or invented.</li>
 *   <li><em>Wording</em> the evidence never uses. Reported as a signal, not to the learner: an answer is
 *       supposed to explain in its own words, so unfamiliar wording is weak evidence of anything on its own,
 *       and it is only worth counting when several distinctive terms in one cited sentence are all absent.</li>
 * </ul>
 *
 * <p>Structural and subject-general, like the audits beside it. Inflection is allowed for by prefix agreement
 * rather than a stemmer, so no language is privileged, and what cannot be decided — whether a page that uses
 * the same words actually supports the claim — is left undecided rather than guessed.
 */
public final class GroundingAudit {
    /** {@code [Source: doc; pages 3-4]} in either bracket form, matching how evidence is shown and cited back. */
    private static final Pattern CITATION = Pattern.compile("\\[{1,2}\\s*Source:\\s*[^;\\]]+?\\s*;\\s*pages?\\s*[^\\]]+?\\s*\\]{1,2}", Pattern.CASE_INSENSITIVE);
    /** A figure worth checking: two digits or more, or anything with a decimal part. Single digits are everywhere. */
    private static final Pattern FIGURE = Pattern.compile("(?<![\\w.,])(\\d+[.,]\\d+|\\d{2,})(?![\\w.,]*\\d)");
    /** Arithmetic in view means the sentence derived its numbers, and deriving them is a different audit's business. */
    private static final Pattern ARITHMETIC = Pattern.compile("[=+×÷*/^]|\\b(?:mod|xor)\\b|--?>|≡|⊕", Pattern.CASE_INSENSITIVE);
    private static final Pattern WORD = Pattern.compile("\\p{L}{6,}");
    /** Below this, absent wording is one paraphrase; at it, a cited sentence is describing something else. */
    private static final int UNSUPPORTED_WORDS = 3;
    private static final int MIN_PREFIX_CHARS = 5;

    private GroundingAudit() {}

    /**
     * Every cited sentence whose specifics the evidence does not contain. An answer with no citations, or a turn
     * with no evidence, yields nothing: there is no claim-to-source pairing to check, and
     * {@link CitationAudit} is what reports a citation with no evidence behind it.
     */
    public static List<Finding> findings(String answer, String evidence) {
        if (answer == null || answer.isBlank() || evidence == null || evidence.isBlank()) return List.of();
        List<String> evidenceTokens = tokens(evidence);
        Set<String> evidenceFigures = figures(evidence);
        List<Finding> findings = new ArrayList<>();
        Set<String> reported = new LinkedHashSet<>();
        for (String sentence : sentences(answer)) {
            if (!CITATION.matcher(sentence).find()) continue;
            String claim = CITATION.matcher(sentence).replaceAll(" ").replaceAll("\\s+", " ").trim();
            if (claim.isEmpty()) continue;
            List<String> missingFigures = missingFigures(claim, evidenceFigures);
            if (!missingFigures.isEmpty() && reported.add("figure|" + claim)) {
                findings.add(new Finding("figure not in the evidence", trim(claim),
                        "the retrieved pages do not contain " + join(missingFigures), true));
            }
            List<String> missingWords = missingWords(claim, evidenceTokens);
            if (missingWords.size() >= UNSUPPORTED_WORDS && reported.add("wording|" + claim)) {
                findings.add(new Finding("wording not in the evidence", trim(claim),
                        "the retrieved pages do not use " + join(missingWords), false));
            }
        }
        return List.copyOf(findings);
    }

    /**
     * A note for the learner covering only what this check can establish. Wording findings are deliberately
     * absent: they are a measurement of this answer, useful to whoever is auditing the system, and telling a
     * learner their explanation used an unfamiliar word would be noise dressed as a warning.
     */
    public static String note(List<Finding> findings) {
        List<Finding> reportable = findings.stream().filter(Finding::reportable).toList();
        if (reportable.isEmpty()) return "";
        StringBuilder note = new StringBuilder("**Grounding check** — " + (reportable.size() == 1 ? "this figure is" : "these figures are")
                + " attributed to the sources but do not appear in the retrieved pages, so treat "
                + (reportable.size() == 1 ? "it" : "them") + " as unverified:\n");
        for (Finding finding : reportable) note.append("- \"").append(finding.claim()).append("\" — ").append(finding.detail()).append(".\n");
        return note.toString();
    }

    /** Figures the claim asserts that the evidence does not state, or none when the claim derives its own. */
    private static List<String> missingFigures(String claim, Set<String> evidenceFigures) {
        if (ARITHMETIC.matcher(claim).find()) return List.of();
        List<String> missing = new ArrayList<>();
        Matcher matcher = FIGURE.matcher(claim);
        while (matcher.find()) {
            String figure = normalizeFigure(matcher.group(1));
            if (!evidenceFigures.contains(figure) && !missing.contains(matcher.group(1))) missing.add(matcher.group(1));
        }
        return missing;
    }

    /** Distinctive words the claim uses that nothing in the evidence uses, allowing for inflection. */
    private static List<String> missingWords(String claim, List<String> evidenceTokens) {
        List<String> missing = new ArrayList<>();
        Matcher matcher = WORD.matcher(claim.toLowerCase(Locale.ROOT));
        while (matcher.find()) {
            String word = matcher.group();
            if (missing.contains(word)) continue;
            if (evidenceTokens.stream().noneMatch(token -> matches(word, token))) missing.add(word);
        }
        return missing;
    }

    /**
     * Splits on sentence punctuation while ignoring anything bracketed, so a citation's own period and
     * semicolon cannot cut a claim away from the reference it carries.
     */
    static List<String> sentences(String answer) {
        return Sentences.of(answer);
    }

    /** Figures the evidence states, with the citation lines removed so a page number cannot attest a claim. */
    private static Set<String> figures(String evidence) {
        Set<String> figures = new LinkedHashSet<>();
        Matcher matcher = FIGURE.matcher(CITATION.matcher(evidence).replaceAll(" "));
        while (matcher.find()) figures.add(normalizeFigure(matcher.group(1)));
        return figures;
    }

    /** A decimal comma and a decimal point are the same figure, and trailing zeros do not make a new one. */
    private static String normalizeFigure(String figure) {
        String value = figure.replace(',', '.');
        if (!value.contains(".")) return value.replaceFirst("^0+(?=\\d)", "");
        String trimmed = value.replaceAll("0+$", "").replaceAll("\\.$", "");
        return trimmed.replaceFirst("^0+(?=\\d)", "");
    }

    private static List<String> tokens(String text) {
        List<String> tokens = new ArrayList<>();
        for (String token : text.toLowerCase(Locale.ROOT).split("[^\\p{L}\\p{N}]+")) if (!token.isEmpty()) tokens.add(token);
        return tokens;
    }

    /** Inflection without a stemmer: a shared prefix long enough to be a root rather than a coincidence. */
    private static boolean matches(String word, String token) {
        if (word.equals(token)) return true;
        int shorter = Math.min(word.length(), token.length());
        return shorter >= MIN_PREFIX_CHARS && word.regionMatches(0, token, 0, shorter);
    }

    private static String join(List<String> values) {
        List<String> quoted = values.stream().map(value -> "\"" + value + "\"").toList();
        if (quoted.size() == 1) return quoted.get(0);
        return String.join(", ", quoted.subList(0, quoted.size() - 1)) + " or " + quoted.get(quoted.size() - 1);
    }

    private static String trim(String value) { return value.length() <= 160 ? value : value.substring(0, 157) + "..."; }

    /**
     * One cited claim whose specifics the evidence does not contain.
     *
     * @param reportable whether this is precise enough to tell the learner about, as opposed to a measurement
     *     worth recording about the answer
     */
    public record Finding(String kind, String claim, String detail, boolean reportable) {}
}
