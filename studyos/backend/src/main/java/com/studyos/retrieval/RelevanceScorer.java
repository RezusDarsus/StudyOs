package com.studyos.retrieval;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Scores how well a passage answers a query, using only the passage, the query, and the other candidates.
 *
 * <p>The reranker this replaces counted how many query words appeared somewhere in a chunk. That treats every
 * word as equally informative, so a chunk matching only the words shared by the entire course outranked one
 * matching the single word that distinguished the question — and it counted a word once however often it
 * occurred, and not at all if it appeared as a plural.
 *
 * <p>Four signals, each in [0,1] so the weights mean what they look like:
 * <ul>
 *   <li>BM25 over the candidate set, so a term's weight comes from how rare it is <em>here</em>. This is also
 *       what removes the need for a stopword list: a word present in every candidate earns no weight by
 *       arithmetic, which works identically for a course in German, Spanish, or English.</li>
 *   <li>Coverage, because BM25 can be won by one term repeated many times while another candidate matches
 *       every term once, and the second is usually the answer.</li>
 *   <li>Proximity, because terms that occur near each other are more likely to be discussed together than
 *       merely present in the same long passage.</li>
 *   <li>The retrieval score itself, which carries what the dense half of the search understood and no amount
 *       of term matching can recover.</li>
 * </ul>
 *
 * <p>Deliberately free of any vocabulary: no stopwords, no synonyms, no subject terms. Morphology is
 * approximated by prefix agreement between long tokens, which is the most a stemmer-free ranker can honestly
 * claim and behaves the same in every language.
 */
public final class RelevanceScorer {
    private static final double K1 = 1.2, B = .75;
    /** Two characters, so a symbol or an index letter still counts, but single punctuation does not. */
    private static final int MIN_TERM_CHARS = 2;
    /** Shorter than this, a shared prefix is coincidence rather than a shared root. */
    private static final int MIN_PREFIX_CHARS = 4;
    /** Beyond this many tokens apart, two matched terms are in the same passage but not in the same discussion. */
    private static final int PROXIMITY_SPAN = 220;
    private static final double RETRIEVAL_WEIGHT = .35, BM25_WEIGHT = .40, COVERAGE_WEIGHT = .15, PROXIMITY_WEIGHT = .10;

    private RelevanceScorer() {}

    /** Query terms, lower-cased, de-duplicated, in the order written. */
    public static List<String> terms(String query) {
        return List.copyOf(new LinkedHashSet<>(tokens(query).stream().filter(term -> term.length() >= MIN_TERM_CHARS).toList()));
    }

    /** Every token, including the short ones, since document length is measured in all of them. */
    static List<String> tokens(String text) {
        if (text == null || text.isBlank()) return List.of();
        List<String> tokens = new ArrayList<>();
        for (String token : text.toLowerCase(Locale.ROOT).split("[^\\p{L}\\p{N}]+")) if (!token.isEmpty()) tokens.add(token);
        return tokens;
    }

    /**
     * Indices into {@code documents}, best first. Ties keep their original order, and a query no candidate
     * matches at all leaves the order exactly as retrieval produced it rather than shuffling on noise.
     */
    public static List<Integer> rank(String query, List<String> documents, List<Double> retrievalScores) {
        List<Double> scores = scores(query, documents, retrievalScores);
        List<Integer> order = new ArrayList<>();
        for (int index = 0; index < documents.size(); index++) order.add(index);
        if (scores.isEmpty()) return List.copyOf(order);
        return order.stream().sorted(Comparator.comparingDouble((Integer index) -> scores.get(index)).reversed()).toList();
    }

    /**
     * The combined score of each document, or an empty list when nothing can be discriminated — no query
     * terms, no documents, or not one term matched anywhere.
     */
    public static List<Double> scores(String query, List<String> documents, List<Double> retrievalScores) {
        if (documents == null || documents.isEmpty()) return List.of();
        List<String> terms = terms(query);
        if (terms.isEmpty()) return List.of();
        List<List<String>> tokenized = documents.stream().map(RelevanceScorer::tokens).toList();
        double averageLength = tokenized.stream().mapToInt(List::size).average().orElse(0);
        Map<String, Double> idf = idf(terms, tokenized);
        List<Match> matches = tokenized.stream().map(document -> match(terms, document)).toList();
        if (matches.stream().allMatch(match -> match.matched().isEmpty())) return List.of();
        List<Double> bm25 = new ArrayList<>(documents.size());
        List<Double> coverage = new ArrayList<>(documents.size());
        List<Double> proximity = new ArrayList<>(documents.size());
        for (int index = 0; index < documents.size(); index++) {
            Match match = matches.get(index);
            bm25.add(bm25(match, idf, tokenized.get(index).size(), averageLength));
            coverage.add((double) match.matched().size() / terms.size());
            proximity.add(proximity(match));
        }
        List<Double> retrieval = normalize(retrievalScores == null || retrievalScores.size() != documents.size()
                ? documents.stream().map(document -> 0d).toList() : retrievalScores);
        List<Double> normalizedBm25 = normalize(bm25);
        List<Double> combined = new ArrayList<>(documents.size());
        for (int index = 0; index < documents.size(); index++) {
            combined.add(RETRIEVAL_WEIGHT * retrieval.get(index) + BM25_WEIGHT * normalizedBm25.get(index)
                    + COVERAGE_WEIGHT * coverage.get(index) + PROXIMITY_WEIGHT * proximity.get(index));
        }
        return List.copyOf(combined);
    }

    /** Probabilistic IDF over the candidates, floored at zero so a term in every candidate cannot count against one. */
    private static Map<String, Double> idf(List<String> terms, List<List<String>> documents) {
        Map<String, Double> idf = new LinkedHashMap<>();
        int total = documents.size();
        for (String term : terms) {
            long containing = documents.stream().filter(document -> document.stream().anyMatch(token -> matches(term, token))).count();
            idf.put(term, Math.max(0, Math.log(1 + (total - containing + .5) / (containing + .5))));
        }
        return idf;
    }

    /** Where each query term occurs in one document, and how often. */
    private static Match match(List<String> terms, List<String> document) {
        Map<String, Integer> frequency = new LinkedHashMap<>();
        List<int[]> positions = new ArrayList<>();
        for (int termIndex = 0; termIndex < terms.size(); termIndex++) {
            String term = terms.get(termIndex);
            int count = 0;
            for (int position = 0; position < document.size(); position++) {
                if (!matches(term, document.get(position))) continue;
                count++;
                positions.add(new int[] {position, termIndex});
            }
            if (count > 0) frequency.put(term, count);
        }
        positions.sort(Comparator.comparingInt(entry -> entry[0]));
        return new Match(frequency, positions);
    }

    private static double bm25(Match match, Map<String, Double> idf, int length, double averageLength) {
        double score = 0;
        double normalization = averageLength <= 0 ? 1 : 1 - B + B * length / averageLength;
        for (Map.Entry<String, Integer> entry : match.frequency().entrySet()) {
            double frequency = entry.getValue();
            score += idf.getOrDefault(entry.getKey(), 0d) * frequency * (K1 + 1) / (frequency + K1 * normalization);
        }
        return score;
    }

    /**
     * One when every matched term sits in one sentence, zero when the tightest window holding them all is
     * further apart than a passage's worth of tokens. A single matched term has no distance to measure and
     * scores zero rather than a spurious one.
     */
    private static double proximity(Match match) {
        int distinct = match.matched().size();
        if (distinct < 2) return 0;
        int window = smallestWindow(match.positions(), distinct);
        if (window < 0) return 0;
        return Math.max(0, 1 - (double) window / PROXIMITY_SPAN);
    }

    /** Classic shrinking window over the merged positions: the shortest span containing all {@code distinct} terms. */
    private static int smallestWindow(List<int[]> positions, int distinct) {
        Map<Integer, Integer> seen = new LinkedHashMap<>();
        int best = -1;
        int start = 0;
        for (int end = 0; end < positions.size(); end++) {
            seen.merge(positions.get(end)[1], 1, Integer::sum);
            while (seen.size() == distinct) {
                int span = positions.get(end)[0] - positions.get(start)[0];
                if (best < 0 || span < best) best = span;
                int leaving = positions.get(start)[1];
                if (seen.merge(leaving, -1, Integer::sum) <= 0) seen.remove(leaving);
                start++;
            }
        }
        return best;
    }

    /**
     * A query term matches a token outright, or when one is a prefix of the other and the shorter is long
     * enough for the agreement to mean something. That is inflection handled without a stemmer, and so without
     * committing the ranker to a language.
     */
    static boolean matches(String term, String token) {
        if (term.equals(token)) return true;
        int shorter = Math.min(term.length(), token.length());
        if (shorter < MIN_PREFIX_CHARS) return false;
        return term.regionMatches(0, token, 0, shorter);
    }

    /**
     * To [0,1] across the candidates, by scale rather than by spread. Stretching the smallest value to zero and
     * the largest to one would turn a difference of a thousandth — two passages of nearly identical wording that
     * happen to differ in length — into the difference between no weight and full weight, and that manufactured
     * gap then outweighs every other signal. Dividing by the largest keeps a near-tie a near-tie. Negatives are
     * shifted rather than clipped, since a cosine score may legitimately be one.
     */
    private static List<Double> normalize(List<Double> values) {
        double minimum = values.stream().mapToDouble(Double::doubleValue).min().orElse(0);
        double shift = minimum < 0 ? -minimum : 0;
        double maximum = values.stream().mapToDouble(Double::doubleValue).max().orElse(0) + shift;
        return values.stream().map(value -> maximum <= 1e-12 ? 0d : (value + shift) / maximum).toList();
    }

    private record Match(Map<String, Integer> frequency, List<int[]> positions) {
        java.util.Set<String> matched() { return frequency.keySet(); }
    }
}
