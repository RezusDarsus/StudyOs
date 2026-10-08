package com.studyos.verify;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Checks each citation against the page it names, rather than against everything the turn retrieved.
 *
 * <p>This is the gap the two audits beside it deliberately leave. {@link CitationAudit} settles whether a
 * reference points at a document and page range that were actually retrieved. {@link GroundingAudit} settles
 * whether the specifics of a cited sentence occur <em>somewhere</em> in the retrieved block. Neither notices the
 * failure in between: a sentence attributing a figure to page 5 when the figure is on page 20 of the same
 * document passes both, because the reference is real and the figure was retrieved. To the reader it is a
 * citation that does not check out — they turn to the cited page and the number is not there.
 *
 * <p>So the unit here is the pair, not the answer: a claim and the specific passages it cites. Two things are
 * decidable that way without a model, and only those two are decided:
 * <ul>
 *   <li>A <em>figure</em> the claim attributes to its cited pages that appears on a different retrieved page
 *       instead. Numbers are not paraphrasable, so this is a statement about where the evidence sits, and it is
 *       worth telling the learner: the page they were sent to does not contain it, and the page that does is
 *       named.</li>
 *   <li>A claim whose distinctive terms are <em>all</em> absent from the pages it cites while another retrieved
 *       passage uses several of them. Reported as a measurement rather than to the learner, for the same reason
 *       {@link GroundingAudit} keeps its wording findings internal: answers are supposed to paraphrase, so
 *       vocabulary is weaker evidence than a number, and the honest use of it is to count how often attribution
 *       lands on the wrong page.</li>
 * </ul>
 *
 * <p>What it will not do is guess. A figure absent from every retrieved page is the grounding audit's finding,
 * not a misattribution; a cited document that was never retrieved is the citation audit's. A claim with no
 * distinctive term and no figure is unmeasurable here and is counted as neither traced nor untraced — an audit
 * that scored what it cannot see would report page-perfect attribution for an answer it never checked.
 *
 * <p>Structural and subject-general. Vocabulary comes from the retrieved passages themselves, inflection is
 * allowed for by prefix agreement rather than a stemmer, and nothing in it knows one subject from another: the
 * same code decides a proof cited to the wrong lemma, a date cited to the wrong chapter, and a formula cited to
 * the wrong slide.
 */
public final class ProvenanceAudit {
    /** Both bracket forms, with the document and pages captured: evidence shows {@code [Source: …]}, answers cite {@code [[Source: …]]}. */
    private static final Pattern CITATION = Pattern.compile("\\[{1,2}\\s*Source:\\s*([^;\\]]+?)\\s*;\\s*pages?\\s*([^\\]]+?)\\s*\\]{1,2}", Pattern.CASE_INSENSITIVE);
    private static final Pattern PAGES = Pattern.compile("(\\d+)\\s*(?:[-–—]\\s*(\\d+))?");
    /** Two digits or a decimal part. Single digits occur on every page and would attest anything. */
    private static final Pattern FIGURE = Pattern.compile("(?<![\\w.,])(\\d+[.,]\\d+|\\d{2,})(?![\\w.,]*\\d)");
    /** Arithmetic in view means the sentence derived its numbers; whether it derived them correctly is another audit. */
    private static final Pattern ARITHMETIC = Pattern.compile("[=+×÷*/^]|\\b(?:mod|xor)\\b|--?>|≡|⊕", Pattern.CASE_INSENSITIVE);
    /** Long enough to be a term of the subject rather than grammar, which is why no stopword list is needed. */
    private static final Pattern TERM = Pattern.compile("\\p{L}{6,}");
    /** Shorter than this is a fragment or a lead-in, and pairing it with a page would be noise. */
    private static final int MIN_CLAIM_WORDS = 6;
    /** Below this a claim has too little distinctive vocabulary for where its terms sit to mean anything. */
    private static final int MIN_TERMS_TO_JUDGE = 3;
    /**
     * How many more of a claim's terms another passage must use before it counts as the better home. A margin
     * rather than "the cited page shares none": an incidental long word shared with the wrong page would
     * otherwise clear a claim, and requiring zero overlap in a paraphrase-heavy answer would be luck either way.
     */
    private static final int MIN_TERM_MARGIN = 2;
    private static final int MIN_PREFIX_CHARS = 5;

    private ProvenanceAudit() {}

    /**
     * Every cited claim in {@code answer} whose specifics sit on a retrieved page other than the one it names.
     * Nothing is returned when there is no pairing to check: no answer, no evidence, or no citations.
     */
    public static List<Finding> findings(String answer, String evidence) {
        if (answer == null || answer.isBlank() || evidence == null || evidence.isBlank()) return List.of();
        List<Passage> passages = passages(evidence);
        if (passages.isEmpty()) return List.of();
        List<Finding> findings = new ArrayList<>();
        Set<String> reported = new LinkedHashSet<>();
        for (String sentence : Sentences.of(answer)) {
            Claim claim = claim(sentence, passages);
            if (claim == null) continue;
            List<Misplaced> misplaced = misplacedFigures(claim, passages);
            for (Misplaced figure : misplaced) {
                if (!reported.add("figure|" + claim.text() + "|" + figure.value())) continue;
                findings.add(new Finding("figure is on a page the claim does not cite", trim(claim.text()),
                        "\"" + figure.value() + "\" appears in " + figure.passage().describe() + ", not on the cited " + claim.describeCited(), true));
            }
            // A misplaced figure already says this sentence belongs to another page, and says it more precisely.
            // Adding the vocabulary finding beside it would report one defect twice to whoever counts findings.
            if (!misplaced.isEmpty()) continue;
            TermMatch terms = misplacedTerms(claim, passages);
            if (terms != null && reported.add("terms|" + claim.text())) {
                findings.add(new Finding("claim traced to a page it does not cite", trim(claim.text()),
                        "the cited " + claim.describeCited() + " uses " + terms.onCited() + " of this claim's " + claim.terms().size()
                                + " distinctive terms (" + join(claim.terms()) + "), while " + terms.passage().describe() + " uses " + terms.elsewhere(), false));
            }
        }
        return List.copyOf(findings);
    }

    /**
     * A note naming each figure that is not on the page it was attributed to. Term findings are left out on
     * purpose: they measure this answer's attribution rather than warn about a fact, and telling a learner that a
     * correctly sourced explanation used its own words would be noise dressed as a warning.
     */
    public static String note(List<Finding> findings) {
        List<Finding> reportable = findings.stream().filter(Finding::reportable).toList();
        if (reportable.isEmpty()) return "";
        StringBuilder note = new StringBuilder("**Page check** — " + (reportable.size() == 1 ? "this figure is" : "these figures are")
                + " attributed to a page that does not contain " + (reportable.size() == 1 ? "it" : "them")
                + ", so use the page named here instead:\n");
        for (Finding finding : reportable) note.append("- \"").append(finding.claim()).append("\" — ").append(finding.detail()).append(".\n");
        return note.toString();
    }

    /**
     * How much of this answer's attribution lands on the page it names, as counts so a harness can pool them
     * across turns instead of averaging per-turn ratios.
     *
     * <p>Only claims this check can actually decide are counted. A cited sentence with no figure and no
     * distinctive term is skipped rather than scored, so the denominator is claims that were checked and the
     * ratio never flatters an answer for being unmeasurable.
     */
    public static Coverage coverage(String answer, String evidence) {
        if (answer == null || answer.isBlank() || evidence == null || evidence.isBlank()) return new Coverage(0, 0, 0);
        List<Passage> passages = passages(evidence);
        if (passages.isEmpty()) return new Coverage(0, 0, 0);
        int checkable = 0, traced = 0, misplacedFigures = 0;
        for (String sentence : Sentences.of(answer)) {
            Claim claim = claim(sentence, passages);
            if (claim == null) continue;
            List<String> claimFigures = figures(claim.text());
            if (claim.terms().isEmpty() && claimFigures.isEmpty()) continue;
            checkable++;
            List<Misplaced> misplaced = misplacedFigures(claim, passages);
            misplacedFigures += misplaced.size();
            List<String> citedFigures = figures(claim.citedText());
            boolean sharesTerm = claim.terms().stream().anyMatch(term -> usesTerm(claim.citedText(), term));
            boolean sharesFigure = claimFigures.stream().anyMatch(figure -> contains(citedFigures, figure));
            boolean elsewhere = !misplaced.isEmpty() || misplacedTerms(claim, passages) != null;
            if ((sharesTerm || sharesFigure) && !elsewhere) traced++;
        }
        return new Coverage(checkable, traced, misplacedFigures);
    }

    /**
     * The claim this sentence makes and the passages it cites, or {@code null} when there is nothing to pair: no
     * citation, too short to assert anything, or a cited document and page range that was never retrieved — the
     * last of those is a fabricated reference, which {@link CitationAudit} reports and this must not double-count.
     */
    private static Claim claim(String sentence, List<Passage> passages) {
        Matcher matcher = CITATION.matcher(sentence);
        List<String> cited = new ArrayList<>();
        List<Passage> citedPassages = new ArrayList<>();
        while (matcher.find()) {
            PageRange range = parse(matcher.group(2).trim());
            String document = normalize(matcher.group(1).trim());
            String label = matcher.group(1).trim() + " pages " + matcher.group(2).trim();
            if (!cited.contains(label)) cited.add(label);
            for (Passage passage : passages)
                if (passage.document().equals(document) && (range == null || passage.range().overlaps(range)) && !citedPassages.contains(passage)) citedPassages.add(passage);
        }
        if (cited.isEmpty() || citedPassages.isEmpty()) return null;
        String text = CITATION.matcher(sentence).replaceAll(" ").replaceAll("[*_`#>]", " ").replaceAll("\\s+", " ").trim();
        if (text.isEmpty() || text.split("\\s+").length < MIN_CLAIM_WORDS) return null;
        StringBuilder citedText = new StringBuilder();
        for (Passage passage : citedPassages) citedText.append(passage.text()).append('\n');
        return new Claim(text, terms(text), cited, citedPassages, citedText.toString());
    }

    /** Figures the claim attributes to its cited pages that a different retrieved passage holds instead. */
    private static List<Misplaced> misplacedFigures(Claim claim, List<Passage> passages) {
        if (ARITHMETIC.matcher(claim.text()).find()) return List.of();
        List<String> onCitedPages = figures(claim.citedText());
        List<Misplaced> misplaced = new ArrayList<>();
        for (String figure : figures(claim.text())) {
            if (contains(onCitedPages, figure)) continue;
            for (Passage passage : passages) {
                if (claim.citedPassages().contains(passage)) continue;
                if (contains(figures(passage.text()), figure)) { misplaced.add(new Misplaced(figure, passage)); break; }
            }
        }
        return misplaced;
    }

    /**
     * The retrieved passage that is a better home for this claim than the pages it cites, or {@code null} when
     * the cited pages are as good a match as anything else retrieved. Comparative on purpose: an answer that
     * paraphrases shares fewer terms with its own source than a copy would, so what identifies misattribution is
     * another page using clearly more of the claim's vocabulary, not the cited page using little of it.
     */
    private static TermMatch misplacedTerms(Claim claim, List<Passage> passages) {
        int total = claim.terms().size();
        if (total < MIN_TERMS_TO_JUDGE) return null;
        int onCited = (int) claim.terms().stream().filter(term -> usesTerm(claim.citedText(), term)).count();
        if (onCited * 3 > total) return null;
        Passage best = null;
        int bestCount = 0;
        for (Passage passage : passages) {
            if (claim.citedPassages().contains(passage)) continue;
            int shared = (int) claim.terms().stream().filter(term -> usesTerm(passage.text(), term)).count();
            if (shared > bestCount) { best = passage; bestCount = shared; }
        }
        return best == null || bestCount < onCited + MIN_TERM_MARGIN ? null : new TermMatch(onCited, bestCount, best);
    }

    /** The evidence block split at its source markers: each passage is one marker and the text under it. */
    private static List<Passage> passages(String evidence) {
        List<Passage> passages = new ArrayList<>();
        Matcher matcher = CITATION.matcher(evidence);
        List<int[]> spans = new ArrayList<>();
        List<String[]> headers = new ArrayList<>();
        while (matcher.find()) { spans.add(new int[] { matcher.start(), matcher.end() }); headers.add(new String[] { matcher.group(1).trim(), matcher.group(2).trim() }); }
        for (int index = 0; index < spans.size(); index++) {
            PageRange range = parse(headers.get(index)[1]);
            if (range == null) continue;
            String text = evidence.substring(spans.get(index)[1], index + 1 < spans.size() ? spans.get(index + 1)[0] : evidence.length());
            passages.add(new Passage(normalize(headers.get(index)[0]), headers.get(index)[0], range, text));
        }
        return passages;
    }

    private static List<String> terms(String text) {
        List<String> terms = new ArrayList<>();
        Matcher matcher = TERM.matcher(text.toLowerCase(Locale.ROOT));
        while (matcher.find()) if (!terms.contains(matcher.group())) terms.add(matcher.group());
        return terms;
    }

    /** Inflection without a stemmer: a shared prefix long enough to be a root rather than a coincidence. */
    private static boolean usesTerm(String text, String term) {
        for (String token : text.toLowerCase(Locale.ROOT).split("[^\\p{L}\\p{N}]+")) {
            if (token.isEmpty()) continue;
            if (token.equals(term)) return true;
            int shorter = Math.min(token.length(), term.length());
            if (shorter >= MIN_PREFIX_CHARS && term.regionMatches(0, token, 0, shorter)) return true;
        }
        return false;
    }

    private static List<String> figures(String text) {
        List<String> figures = new ArrayList<>();
        Matcher matcher = FIGURE.matcher(text);
        while (matcher.find()) { String value = normalizeFigure(matcher.group(1)); if (!figures.contains(value)) figures.add(value); }
        return figures;
    }

    private static boolean contains(List<String> figures, String figure) { return figures.contains(normalizeFigure(figure)); }

    /** A decimal comma and a decimal point are the same figure, and trailing or leading zeros do not make a new one. */
    private static String normalizeFigure(String figure) {
        String value = figure.replace(',', '.');
        if (!value.contains(".")) return value.replaceFirst("^0+(?=\\d)", "");
        return value.replaceAll("0+$", "").replaceAll("\\.$", "").replaceFirst("^0+(?=\\d)", "");
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

    private static String normalize(String document) { return document == null ? "" : document.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").trim(); }
    private static String trim(String value) { return value.length() <= 160 ? value : value.substring(0, 157) + "..."; }

    private static String join(List<String> values) {
        List<String> quoted = values.stream().limit(4).map(value -> "\"" + value + "\"").toList();
        if (quoted.size() == 1) return quoted.get(0);
        return String.join(", ", quoted.subList(0, quoted.size() - 1)) + " or " + quoted.get(quoted.size() - 1);
    }

    /** One claim paired with the passages it cites, kept together because neither half is checkable alone. */
    private record Claim(String text, List<String> terms, List<String> cited, List<Passage> citedPassages, String citedText) {
        private String describeCited() { return cited.size() == 1 ? cited.get(0) : String.join(" and ", cited); }
    }

    /** What was found on a page other than the cited one. */
    private record Misplaced(String value, Passage passage) {}

    /** How a claim's vocabulary is split between the pages it cites and the page that uses more of it. */
    private record TermMatch(int onCited, int elsewhere, Passage passage) {}

    private record Passage(String document, String name, PageRange range, String text) {
        private String describe() { return name + " pages " + (range.start() == range.end() ? String.valueOf(range.start()) : range.start() + "-" + range.end()); }
    }

    private record PageRange(int start, int end) {
        private boolean overlaps(PageRange other) { return start <= other.end() && other.start() <= end; }
    }

    /**
     * One claim whose specifics sit on a page it does not cite.
     *
     * @param reportable whether this is precise enough to tell the learner about, as opposed to a measurement
     *     worth recording about the answer
     */
    public record Finding(String kind, String claim, String detail, boolean reportable) {}

    /**
     * Per-page attribution for one answer, as counts.
     *
     * @param checkedClaims cited sentences carrying a figure or a distinctive term, so this check could decide them
     * @param tracedClaims how many of those are supported by the pages they actually name
     * @param misplacedFigures figures attributed to one page that a different retrieved page holds
     */
    public record Coverage(int checkedClaims, int tracedClaims, int misplacedFigures) {
        /** Of the claims that could be checked, the share whose citation lands on the right page. One when none could. */
        public double traceability() { return checkedClaims == 0 ? 1 : (double) tracedClaims / checkedClaims; }
    }
}
