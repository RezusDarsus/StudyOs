package com.studyos.retrieval;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

class RelevanceScorerTest {
    private static final List<Double> FLAT = List.of(.5, .5, .5);

    /**
     * The measured failure the old counter produced: a word carried by every candidate decides nothing, and the
     * rare word decides everything. Here every passage mentions the course's subject; only one answers.
     */
    @Test void aTermSharedByEveryCandidateEarnsNoWeight() {
        List<String> candidates = List.of(
                "Codes are studied throughout this course and codes appear in every chapter of the notes.",
                "Codes and the syndrome decoding table for a shortened code, with the syndrome computed per coset.",
                "Codes are introduced here with historical remarks and a bibliography of further reading.");
        assertThat(RelevanceScorer.rank("codes syndrome decoding", candidates, FLAT)).startsWith(1);
    }

    /** Matching every term once beats matching one term repeatedly, which is what coverage is for. */
    @Test void coveringTheWholeQuestionBeatsRepeatingOneWordOfIt() {
        List<String> candidates = List.of(
                "Interleaving interleaving interleaving interleaving interleaving interleaving.",
                "Interleaving spreads a burst error across several codewords before decoding.");
        assertThat(RelevanceScorer.rank("interleaving burst error", candidates, List.of(.5, .5))).startsWith(1);
    }

    /** Terms discussed together beat the same terms merely present in one long passage. */
    @Test void termsNearEachOtherBeatTermsFarApart() {
        String filler = "padding ".repeat(300);
        List<String> candidates = List.of(
                "generator matrix" + filler + "parity check",
                "the generator matrix and the parity check matrix are duals" + filler);
        assertThat(RelevanceScorer.rank("generator parity", candidates, List.of(.5, .5))).startsWith(1);
    }

    /**
     * Inflection, without a stemmer and so without committing the ranker to one language. A shared prefix only
     * counts when it is long enough to be a root rather than a coincidence.
     */
    @Test void inflectionMatchesAndShortCoincidencesDoNot() {
        assertThat(RelevanceScorer.matches("polynomial", "polynomials")).isTrue();
        assertThat(RelevanceScorer.matches("vektorraum", "vektorräume")).isFalse();
        assertThat(RelevanceScorer.matches("for", "form")).isFalse();
        assertThat(RelevanceScorer.matches("code", "coding")).isFalse();
        assertThat(RelevanceScorer.matches("cod", "codeword")).isFalse();
    }

    /**
     * What retrieval already knew has to survive. When no term matches anything — a paraphrased question whose
     * answer shares none of its words — the dense half is the only signal there is, and reordering on noise
     * would throw it away.
     */
    @Test void anUnmatchableQueryLeavesTheRetrievedOrderAlone() {
        List<String> candidates = List.of("alpha beta", "gamma delta", "epsilon zeta");
        assertThat(RelevanceScorer.rank("nothing whatsoever matches", candidates, List.of(.9, .5, .1)))
                .containsExactly(0, 1, 2);
        assertThat(RelevanceScorer.scores("nothing whatsoever matches", candidates, FLAT)).isEmpty();
    }

    /** With the term evidence tied, the retrieval score is what remains to separate the candidates. */
    @Test void theRetrievalScoreBreaksTiesRatherThanBeingDiscarded() {
        List<String> identical = List.of("syndrome decoding", "syndrome decoding", "syndrome decoding");
        assertThat(RelevanceScorer.rank("syndrome decoding", identical, List.of(.1, .9, .5))).containsExactly(1, 2, 0);
    }

    @Test void everyScoreStaysInsideTheUnitRange() {
        List<Double> scores = RelevanceScorer.scores("syndrome decoding table",
                List.of("syndrome decoding table", "unrelated prose", "a table"), List.of(1e9, -3d, 0d));
        assertThat(scores).allSatisfy(score -> assertThat(score).isBetween(0d, 1d));
    }

    @Test void tokensAndTermsAreUnicodeAwareAndDeduplicated() {
        assertThat(RelevanceScorer.terms("Präfix, präfix; über-alles 7")).containsExactly("präfix", "über", "alles");
        assertThat(RelevanceScorer.tokens("a b2 c")).containsExactly("a", "b2", "c");
    }

    @Test void anEmptyOrTermlessQueryDiscriminatesNothing() {
        assertThat(RelevanceScorer.scores("", List.of("anything"), List.of(.5))).isEmpty();
        assertThat(RelevanceScorer.rank("", List.of("a", "b"), List.of(.1, .9))).containsExactly(0, 1);
        assertThat(RelevanceScorer.scores("query", List.of(), List.of())).isEmpty();
    }
}
