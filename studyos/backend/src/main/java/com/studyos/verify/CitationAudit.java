package com.studyos.verify;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Checks an answer's citations against the evidence the answer was actually written from, and reports the
 * ones that cannot be checked.
 *
 * <p>Two failures were measured, and both look identical to a reader: a citation naming a document that was
 * never retrieved for the turn, and a claim about the learner's own progress footnoted to a lecture PDF. The
 * first is a fabricated reference; the second attributes a measurement to a source that cannot contain it,
 * because how a particular student is doing is recorded in their attempts and nowhere in the course material.
 *
 * <p>Structural, not semantic. It compares document names and page ranges against the retrieved evidence
 * block, so it works the same for every subject and needs no model call. What it cannot decide — whether a
 * cited page really supports the sentence — is left alone rather than guessed at.
 */
public final class CitationAudit {
    /** Both bracket forms: evidence is fed to the model as {@code [Source: …]} and cited back as {@code [[Source: …]]}. */
    private static final Pattern CITATION = Pattern.compile("\\[{1,2}\\s*Source:\\s*([^;\\]]+?)\\s*;\\s*pages?\\s*([^\\]]+?)\\s*\\]{1,2}", Pattern.CASE_INSENSITIVE);
    private static final Pattern PAGES = Pattern.compile("(\\d+)\\s*(?:[-–—]\\s*(\\d+))?");
    /** Shorter than this is a fragment, a label, or a lead-in to a list, and attributing it would be noise. */
    private static final int MIN_CLAIM_WORDS = 6;
    /** Long enough to be a term of the subject rather than grammar, which is why no stopword list is needed. */
    private static final Pattern SUBJECT_WORD = Pattern.compile("\\p{L}{6,}");
    /** The opening letters every {@link #SUBJECT_WORD} has, which is what stands in for a stemmer here. */
    private static final int STEM_CHARS = 6;

    private CitationAudit() {}

    /**
     * Every citation in {@code answer} that the {@code evidence} block does not attest, plus every claim about
     * the learner that is footnoted to a document. Empty evidence with citations present is itself the finding:
     * some turns retrieve nothing by design, and an answer to one of those has nothing to cite.
     */
    public static List<Finding> findings(String answer, String evidence) {
        if (answer == null || answer.isBlank()) return List.of();
        List<Finding> findings = new ArrayList<>();
        Map<String, List<PageRange>> attested = attestedSources(evidence);
        Set<String> reported = new LinkedHashSet<>();
        Matcher matcher = CITATION.matcher(answer);
        while (matcher.find()) {
            String document = matcher.group(1).trim();
            String pages = matcher.group(2).trim();
            String key = normalize(document) + "|" + pages;
            if (!reported.add(key)) continue;
            List<PageRange> ranges = attested.get(normalize(document));
            if (ranges == null) findings.add(new Finding("unretrieved source", document + "; pages " + pages,
                    attested.isEmpty() ? "no course evidence was retrieved for this turn" : "retrieved documents were " + String.join(", ", documentNames(evidence))));
            else if (!overlapsAny(pages, ranges)) findings.add(new Finding("unretrieved pages", document + "; pages " + pages,
                    "pages retrieved from that document were " + describe(ranges)));
        }
        learnerStateFindings(answer, findings);
        return List.copyOf(findings);
    }

    /**
     * Sentences that state something about the learner while pointing at a document. The citation is the
     * defect, not the claim: the same sentence with no citation is a legitimate reading of recorded state.
     *
     * <p>A sentence that also names a recorded attempt is left alone. There the document is not standing in as
     * the provenance of the learner claim — the attempt is — and the reference belongs to the other half of the
     * sentence, which is exactly what "cite learner evidence, then the material" looks like when done right.
     */
    private static void learnerStateFindings(String answer, List<Finding> findings) {
        Set<String> reported = new LinkedHashSet<>();
        for (String sentence : sentences(answer)) {
            if (!LearnerStateAudit.aboutTheLearner(sentence) || LearnerStateAudit.anchoredToRecord(sentence)) continue;
            Matcher cited = CITATION.matcher(sentence);
            if (!cited.find()) continue;
            String claim = sentence.replaceAll("\\s+", " ").trim();
            if (reported.add(claim)) findings.add(new Finding("learner state cited to course material", trim(claim),
                    "how this learner is doing comes from their recorded attempts, which " + cited.group(1).trim() + " cannot contain"));
        }
    }

    /**
     * Splits on sentence punctuation, ignoring anything inside brackets. A citation carries both a period and a
     * semicolon of its own ({@code lecture-03.pdf; pages 12-18}), so a plain sentence split cuts the reference
     * away from the claim it belongs to and the pair stops being visible as one statement.
     */
    private static List<String> sentences(String answer) {
        return Sentences.of(answer);
    }

    /** Document name to the page ranges actually retrieved from it, keyed on the normalized filename. */
    private static Map<String, List<PageRange>> attestedSources(String evidence) {
        Map<String, List<PageRange>> attested = new LinkedHashMap<>();
        if (evidence == null || evidence.isBlank()) return attested;
        Matcher matcher = CITATION.matcher(evidence);
        while (matcher.find()) {
            PageRange range = parse(matcher.group(2).trim());
            if (range != null) attested.computeIfAbsent(normalize(matcher.group(1).trim()), key -> new ArrayList<>()).add(range);
        }
        return attested;
    }

    private static List<String> documentNames(String evidence) {
        Set<String> names = new LinkedHashSet<>();
        Matcher matcher = CITATION.matcher(evidence == null ? "" : evidence);
        while (matcher.find()) names.add(matcher.group(1).trim());
        return List.copyOf(names);
    }

    /** A cited range is attested when it shares at least one page with something retrieved from that document. */
    private static boolean overlapsAny(String pages, List<PageRange> ranges) {
        PageRange cited = parse(pages);
        if (cited == null) return true;
        return ranges.stream().anyMatch(range -> cited.start() <= range.end() && range.start() <= cited.end());
    }

    private static PageRange parse(String pages) {
        Matcher matcher = PAGES.matcher(pages == null ? "" : pages);
        if (!matcher.find()) return null;
        try {
            int start = Integer.parseInt(matcher.group(1));
            int end = matcher.group(2) == null ? start : Integer.parseInt(matcher.group(2));
            return end < start ? new PageRange(end, start) : new PageRange(start, end);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static String describe(List<PageRange> ranges) {
        List<String> values = new ArrayList<>();
        for (PageRange range : ranges) { String value = range.start() == range.end() ? String.valueOf(range.start()) : range.start() + "-" + range.end(); if (!values.contains(value)) values.add(value); }
        return String.join(", ", values);
    }

    private static String normalize(String document) { return document == null ? "" : document.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").trim(); }
    private static String trim(String value) { return value.length() <= 160 ? value : value.substring(0, 157) + "..."; }

    /**
     * A note naming each citation that could not be checked. The answer is left as written, for the same
     * reason the computation check leaves it alone: saying plainly which reference cannot be verified is
     * always true, while silently deleting a citation would leave the claim standing with nothing behind it.
     */
    public static String note(List<Finding> findings) {
        if (findings.isEmpty()) return "";
        StringBuilder note = new StringBuilder("**Citation check** — " + (findings.size() == 1 ? "this reference does" : "these references do") + " not match the evidence used for this answer, so treat "
                + (findings.size() == 1 ? "the claim it supports" : "the claims they support") + " as unverified:\n");
        for (Finding finding : findings) note.append("- ").append(finding.kind()).append(": \"").append(finding.claim()).append("\" — ").append(finding.detail()).append(".\n");
        return note.toString();
    }

    /**
     * How completely and how accurately this answer attributes what it says, as the two figures the citation
     * literature reports separately.
     *
     * <p>Precision and recall fail in opposite directions and one number cannot see both. An answer that cites
     * one sentence out of ten has perfect precision and is mostly unattributed; an answer that staples a
     * reference to every sentence, half of them wrong, has perfect recall and is worse than useless. Reporting
     * them together is what makes "the citations improved" a checkable statement.
     *
     * <p>A <em>subject claim</em> — a sentence that ought to say where it comes from — is identified from the
     * evidence rather than from a list of words: a sentence long enough to assert something, not a question,
     * not a claim about the learner (those come from recorded attempts and are right to be uncited), and using
     * at least one distinctive term that the retrieved pages also use. So the standard an answer is held to is
     * set by what was actually retrieved for the turn, and it is the same standard in every subject.
     */
    public static Coverage coverage(String answer, String evidence) {
        if (answer == null || answer.isBlank()) return new Coverage(0, 0, 0, 0);
        int citations = 0;
        int attestedCitations = 0;
        Map<String, List<PageRange>> attested = attestedSources(evidence);
        Matcher matcher = CITATION.matcher(answer);
        while (matcher.find()) {
            citations++;
            List<PageRange> ranges = attested.get(normalize(matcher.group(1).trim()));
            if (ranges != null && overlapsAny(matcher.group(2).trim(), ranges)) attestedCitations++;
        }
        Set<String> vocabulary = vocabulary(evidence);
        int subjectClaims = 0;
        int citedClaims = 0;
        for (String sentence : sentences(answer)) {
            if (!subjectClaim(sentence, vocabulary)) continue;
            subjectClaims++;
            if (CITATION.matcher(sentence).find()) citedClaims++;
        }
        return new Coverage(citations, attestedCitations, subjectClaims, citedClaims);
    }

    /**
     * Whether this sentence asserts something about the course material. Bare references, questions, headings
     * and one-line prompts are excluded because attributing them would be noise, and sentences about the
     * learner are excluded because the course material is the wrong place to attribute them to.
     */
    private static boolean subjectClaim(String sentence, Set<String> vocabulary) {
        String prose = CITATION.matcher(sentence).replaceAll(" ").replaceAll("[*_`#>]", " ").trim();
        if (prose.isEmpty() || prose.endsWith("?")) return false;
        if (prose.split("\\s+").length < MIN_CLAIM_WORDS) return false;
        if (LearnerStateAudit.aboutTheLearner(sentence)) return false;
        Matcher word = SUBJECT_WORD.matcher(prose.toLowerCase(Locale.ROOT));
        while (word.find()) if (vocabulary.contains(stem(word.group()))) return true;
        return false;
    }

    /** The distinctive words the retrieved pages themselves use, with the citation lines left out. */
    private static Set<String> vocabulary(String evidence) {
        Set<String> vocabulary = new LinkedHashSet<>();
        if (evidence == null || evidence.isBlank()) return vocabulary;
        Matcher matcher = SUBJECT_WORD.matcher(CITATION.matcher(evidence).replaceAll(" ").toLowerCase(Locale.ROOT));
        while (matcher.find()) vocabulary.add(stem(matcher.group()));
        return vocabulary;
    }

    /**
     * Inflection allowed for without a stemmer: the opening letters, which every word matched here has at least
     * {@link #SUBJECT_WORD} many of. An answer writing "symbol" about a page that says "symbols" is talking
     * about that page, and a metric that missed the paraphrase would flatter the answer by not asking it to
     * attribute anything.
     */
    private static String stem(String word) { return word.substring(0, STEM_CHARS); }

    /** One unverifiable citation: what kind of failure it is, what was cited, and what the evidence says instead. */
    public record Finding(String kind, String claim, String detail) {}

    /**
     * Citation precision and recall for one answer, as counts so a harness can aggregate across turns instead of
     * averaging averages.
     *
     * @param citations references the answer makes
     * @param attested how many of those the turn's evidence supports
     * @param subjectClaims sentences that assert something about the retrieved material
     * @param citedClaims how many of those carry a reference
     */
    public record Coverage(int citations, int attested, int subjectClaims, int citedClaims) {
        /** Of the references made, the share that point at something retrieved. One when nothing was cited. */
        public double precision() { return citations == 0 ? 1 : (double) attested / citations; }
        /** Of the claims that needed attributing, the share that carry a reference. One when none did. */
        public double recall() { return subjectClaims == 0 ? 1 : (double) citedClaims / subjectClaims; }
    }

    private record PageRange(int start, int end) {}
}
