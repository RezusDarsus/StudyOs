package com.studyos.verify;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Decides, for each thing an answer asserted, which supplied passage it came from — or that none did.
 *
 * <p>The audits beside this class each answer one question about an answer and then the answer is written to
 * {@code messages} and the finding is gone. This one produces the durable record instead: a claim, its class, and
 * the chunks behind it, in a form that can be stored and queried later. The three classes are the three ways a
 * sentence of a tutor's answer can relate to the material the tutor was given:
 *
 * <ul>
 *   <li><b>SOURCE</b> — it cites a passage that was supplied for this turn, and the citation resolves: the
 *       document name matches and the pages overlap. The chunk ids behind that passage are the claim's evidence.
 *   <li><b>DERIVED</b> — nothing it cites resolves to a supplied passage, but it is written in the vocabulary of
 *       one. That is what a synthesis across passages looks like, and what a paraphrase that forgot its reference
 *       looks like; both are grounded in the material and neither is quoting it.
 *   <li><b>EXTERNAL</b> — neither. The sentence has the distinctive vocabulary to be judged and none of it
 *       occurs in anything the model was shown, so it came from the model's own knowledge. This is the class the
 *       record exists to count.
 * </ul>
 *
 * <p>Two things are deliberately <em>not</em> classified, and both are counted so nothing is silently dropped. A
 * claim about the learner is a measurement against their recorded attempts, which is a different provenance
 * question with a different audit ({@link LearnerStateAudit}); calling it EXTERNAL because the lecture notes do
 * not contain it would be exactly backwards. And a claim with too little distinctive vocabulary to place — "this
 * means the result is always the same" — is unjudged rather than external, because asserting that a sentence came
 * from outside the material on the strength of no evidence is the same defect the class is meant to detect.
 *
 * <p>{@code cited} is recorded independently of the class. A claim that carries a reference which resolves to
 * nothing supplied comes out {@code cited} and EXTERNAL, which is the signature of a fabricated citation — the
 * defect {@link CitationAudit} reports to the reader, made durable enough to count across a course.
 *
 * <p>Pure, deterministic, and subject-general. No database, no provider, no clock, and no vocabulary of its own:
 * every term it judges against comes from the passages that were actually supplied, so the same code places a
 * claim about cyclic codes, one about the Treaty of Versailles, and one about renal physiology. A chunk id
 * reaches this class only by having been in the block the caller supplied, which is the whole reason the caller
 * passes passages rather than the model passing ids.
 */
public final class ClaimProvenance {
    /** Both bracket forms: evidence is supplied as {@code [Source: …]} and cited back as {@code [[Source: …]]}. */
    private static final Pattern CITATION = Pattern.compile("\\[{1,2}\\s*Source:\\s*([^;\\]]+?)\\s*;\\s*pages?\\s*([^\\]]+?)\\s*\\]{1,2}", Pattern.CASE_INSENSITIVE);
    private static final Pattern PAGES = Pattern.compile("(\\d+)\\s*(?:[-–—]\\s*(\\d+))?");
    /** Long enough to be a term of the subject rather than grammar, which is why no stopword list is needed. */
    private static final Pattern TERM = Pattern.compile("\\p{L}{6,}");
    /** The opening letters every {@link #TERM} has, which is what stands in for a stemmer here. */
    private static final int STEM_CHARS = 6;
    /** Shorter than this is a fragment, a heading, or a lead-in to a list, and placing it would be noise. */
    private static final int MIN_CLAIM_WORDS = 6;
    /** Below this a claim has too little distinctive vocabulary for where its terms occur to mean anything. */
    private static final int MIN_TERMS_TO_JUDGE = 3;
    /**
     * How many of a claim's distinctive terms a passage must share before the claim counts as written from it. One
     * long word in common is coincidence — two independent subjects both say "different" and "understanding" —
     * and this is the same margin {@link ProvenanceAudit} requires before it will say where a claim belongs.
     */
    private static final int MIN_SHARED_TERMS = 2;
    /**
     * How many passages one DERIVED claim may be linked to. A synthesis draws on a few passages; linking it to
     * every passage that shares two words would make the evidence table say the answer rested on everything.
     */
    private static final int MAX_DERIVED_LINKS = 3;
    /** What a support figure is when there was nothing measurable to take it over. Never a real share. */
    public static final double UNMEASURED = -1;

    private ClaimProvenance() {}

    /**
     * The claims of {@code answer} against the passages that were supplied to write it.
     *
     * @param supplied the passages the caller put in the prompt, in the order it put them there. Empty means the
     *     caller has nothing to check against — a turn whose profile retrieves nothing, or one whose evidence was
     *     resolved somewhere else — and the result is then explicitly unmeasured rather than an answer full of
     *     EXTERNAL claims, which would be a number about evidence that was never examined.
     */
    public static Ledger of(String answer, List<SuppliedPassage> supplied) {
        List<SuppliedPassage> passages = supplied == null ? List.of() : supplied.stream().filter(passage -> passage != null).toList();
        if (passages.isEmpty()) return Ledger.unmeasured();
        List<Claim> claims = new ArrayList<>();
        int aboutLearner = 0;
        int unjudged = 0;
        List<Set<String>> vocabularies = passages.stream().map(passage -> terms(passage.content())).toList();
        for (String sentence : Sentences.of(answer)) {
            if (!assertsSomething(sentence)) continue;
            // A statement about the learner is evidence-backed too, just not by this evidence. It is counted here
            // and classified nowhere, because the recorded-attempt block is what it has to be checked against.
            if (LearnerStateAudit.aboutTheLearner(sentence)) { aboutLearner++; continue; }
            String text = normalizeWhitespace(sentence);
            List<EvidenceLink> cited = citedLinks(sentence, passages);
            boolean carriesCitation = CITATION.matcher(sentence).find();
            if (!cited.isEmpty()) { claims.add(new Claim(claims.size(), text, Origin.SOURCE, carriesCitation, support(sentence, vocabularies), cited)); continue; }
            Set<String> claimTerms = terms(withoutCitations(sentence));
            if (claimTerms.size() < MIN_TERMS_TO_JUDGE) { unjudged++; continue; }
            List<EvidenceLink> overlap = overlapLinks(claimTerms, passages, vocabularies);
            claims.add(new Claim(claims.size(), text, overlap.isEmpty() ? Origin.EXTERNAL : Origin.DERIVED, carriesCitation, support(sentence, vocabularies), overlap));
        }
        int chunks = (int) passages.stream().flatMap(passage -> passage.chunkIds().stream()).distinct().count();
        return new Ledger(List.copyOf(claims), unjudged, aboutLearner, passages.size(), chunks);
    }

    /**
     * Whether this sentence asserts something at all. Questions, bare references, headings and one-word list
     * items are excluded: they are not claims, and recording them would dilute every count taken over the table.
     *
     * <p>Deliberately not {@link CitationAudit}'s subject-claim test, which additionally requires the sentence to
     * share vocabulary with the retrieved pages. That test exists to decide what an answer owed a citation for,
     * so excluding sentences with no evidence vocabulary is right there and wrong here — those sentences are the
     * EXTERNAL case, and a filter that dropped them would report every answer as fully grounded.
     */
    private static boolean assertsSomething(String sentence) {
        String prose = withoutCitations(sentence).replaceAll("[*_`#>|]", " ").trim();
        if (prose.isEmpty() || prose.endsWith("?")) return false;
        return prose.split("\\s+").length >= MIN_CLAIM_WORDS;
    }

    /** The supplied passages this sentence's own references resolve to: name matches, pages overlap. */
    private static List<EvidenceLink> citedLinks(String sentence, List<SuppliedPassage> passages) {
        List<EvidenceLink> links = new ArrayList<>();
        Matcher matcher = CITATION.matcher(sentence);
        while (matcher.find()) {
            String document = normalize(matcher.group(1));
            PageRange range = parse(matcher.group(2));
            for (SuppliedPassage passage : passages) {
                if (!normalize(passage.documentName()).equals(document)) continue;
                // A citation with no readable page number resolves on the document alone: the reference is to
                // something supplied, and inventing a page range to reject it against would be worse.
                if (range != null && !(range.start() <= passage.pageEnd() && passage.pageStart() <= range.end())) continue;
                add(links, passage, LinkType.CITED);
            }
        }
        return links;
    }

    /** The passages whose own vocabulary this claim is written in, the most-shared first, capped. */
    private static List<EvidenceLink> overlapLinks(Set<String> claimTerms, List<SuppliedPassage> passages, List<Set<String>> vocabularies) {
        record Scored(int shared, int index) {}
        List<Scored> scored = new ArrayList<>();
        for (int index = 0; index < passages.size(); index++) {
            int shared = 0;
            for (String term : claimTerms) if (vocabularies.get(index).contains(term)) shared++;
            if (shared >= MIN_SHARED_TERMS) scored.add(new Scored(shared, index));
        }
        // Most overlap first, and supplied order breaks a tie: the passages arrive best-ranked first, so a tie
        // resolves to the passage retrieval thought more relevant rather than to whichever the map yielded.
        List<EvidenceLink> links = new ArrayList<>();
        scored.stream().sorted(java.util.Comparator.comparingInt(Scored::shared).reversed().thenComparingInt(Scored::index))
                .limit(MAX_DERIVED_LINKS).forEach(entry -> add(links, passages.get(entry.index()), LinkType.OVERLAP));
        return links;
    }

    /**
     * The share of a claim's distinctive terms that occur anywhere in the supplied evidence, or {@code -1} when
     * the claim has too few of them to measure. Not a floor of zero: a claim with nothing to count and a claim
     * whose every term is absent are different situations, and one number reporting both as zero would make an
     * unmeasurable sentence read as a groundless one.
     */
    private static double support(String sentence, List<Set<String>> vocabularies) {
        Set<String> claimTerms = terms(withoutCitations(sentence));
        if (claimTerms.size() < MIN_TERMS_TO_JUDGE) return UNMEASURED;
        int found = 0;
        for (String term : claimTerms) for (Set<String> vocabulary : vocabularies) if (vocabulary.contains(term)) { found++; break; }
        return (double) found / claimTerms.size();
    }

    private static void add(List<EvidenceLink> links, SuppliedPassage passage, LinkType type) {
        for (UUID chunkId : passage.chunkIds()) {
            if (links.stream().anyMatch(link -> chunkId.equals(link.chunkId()))) continue;
            links.add(new EvidenceLink(chunkId, passage.documentId(), passage.documentName(), passage.sectionPath(), passage.pageStart(), passage.pageEnd(), type));
        }
    }

    /** The distinctive words of a piece of text, stemmed by prefix so a plural still matches its singular. */
    private static Set<String> terms(String text) {
        Set<String> terms = new LinkedHashSet<>();
        Matcher matcher = TERM.matcher(text == null ? "" : text.toLowerCase(Locale.ROOT));
        while (matcher.find()) terms.add(matcher.group().substring(0, STEM_CHARS));
        return terms;
    }

    private static String withoutCitations(String sentence) { return CITATION.matcher(sentence == null ? "" : sentence).replaceAll(" "); }
    private static String normalizeWhitespace(String value) { return value.replaceAll("\\s+", " ").trim(); }
    private static String normalize(String document) { return document == null ? "" : document.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").trim(); }

    private static PageRange parse(String pages) {
        Matcher matcher = PAGES.matcher(pages == null ? "" : pages);
        if (!matcher.find()) return null;
        try {
            int start = Integer.parseInt(matcher.group(1));
            int end = matcher.group(2) == null ? start : Integer.parseInt(matcher.group(2));
            return end < start ? new PageRange(end, start) : new PageRange(start, end);
        } catch (NumberFormatException ignored) { return null; }
    }

    public enum Origin { SOURCE, DERIVED, EXTERNAL }
    /** How a chunk came to be behind a claim: the claim cited its passage, or the claim is written in its words. */
    public enum LinkType { CITED, OVERLAP }

    /**
     * One passage as it was put into the prompt.
     *
     * @param chunkIds the chunks this passage was assembled from. These are the ids the record stores, and they
     *     are the caller's own, which is what makes the stored provenance a fact about what was supplied rather
     *     than a repetition of what a model claimed to have read.
     */
    public record SuppliedPassage(UUID documentId, String documentName, String sectionPath, int pageStart, int pageEnd, String content, List<UUID> chunkIds) {
        public SuppliedPassage { documentName = documentName == null ? "" : documentName; sectionPath = sectionPath == null ? "" : sectionPath; content = content == null ? "" : content; chunkIds = chunkIds == null ? List.of() : List.copyOf(chunkIds); }
    }

    public record EvidenceLink(UUID chunkId, UUID documentId, String documentName, String sectionPath, int pageStart, int pageEnd, LinkType linkType) {}

    /**
     * @param support the share of this claim's distinctive terms found in the supplied evidence, or
     *     {@link #UNMEASURED}. A SOURCE claim carries it too: a resolving citation says where the claim points,
     *     not how much of the claim the passage actually says.
     */
    public record Claim(int ordinal, String text, Origin origin, boolean cited, double support, List<EvidenceLink> evidence) {
        public Claim { evidence = evidence == null ? List.of() : List.copyOf(evidence); }
    }

    /**
     * What one answer's provenance came to.
     *
     * @param measured false when no evidence was supplied to check against. The counts are then meaningless and
     *     must be stored as absent rather than as zero — an unmeasured turn recorded as "0 external claims" is
     *     indistinguishable from a perfectly grounded one, and the aggregate over a course would flatter itself.
     */
    public record Ledger(List<Claim> claims, int unjudged, int aboutLearner, int passagesSupplied, int chunksSupplied, boolean measured) {
        public Ledger(List<Claim> claims, int unjudged, int aboutLearner, int passagesSupplied, int chunksSupplied) { this(claims, unjudged, aboutLearner, passagesSupplied, chunksSupplied, true); }
        public Ledger { claims = claims == null ? List.of() : List.copyOf(claims); }
        static Ledger unmeasured() { return new Ledger(List.of(), 0, 0, 0, 0, false); }
        public long count(Origin origin) { return claims.stream().filter(claim -> claim.origin() == origin).count(); }
        /** Everything placed in one of the three classes. Sentences left unjudged or about the learner are not in it. */
        public int classified() { return claims.size(); }
    }

    private record PageRange(int start, int end) {}
}
