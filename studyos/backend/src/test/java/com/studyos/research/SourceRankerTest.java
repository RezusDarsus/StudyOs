package com.studyos.research;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ranker is a retrieval-quality heuristic, and these tests pin exactly what it may claim:
 * recognised references outrank unknown domains on equal relevance, relevance lifts a candidate,
 * and a thin page does not outrank a substantial one purely by being a popular domain.
 */
class SourceRankerTest {

    private final SourceRanker ranker = new SourceRanker();

    @Test
    void recognisedReferencesOutrankUnknownDomains() {
        double wikipedia = ranker.score("https://en.wikipedia.org/wiki/Elasticity", "Elasticity", "Elasticity " + body(500), "elasticity economics").total();
        double unknown = ranker.score("https://totally-not-spam.example.com/elasticity", "Elasticity", "Elasticity " + body(500), "elasticity economics").total();
        assertTrue(wikipedia > unknown, "wikipedia " + wikipedia + " should outrank an unknown domain " + unknown);
    }

    @Test
    void academicAndStandardsHostsOutrankGenericOnes() {
        double university = ranker.score("https://cs.stanford.edu/people/notes.pdf", "Elasticity", body(500), "elasticity").authority();
        double blog = ranker.score("https://medium.com/elasticity-post", "Elasticity", body(500), "elasticity").authority();
        assertTrue(university > blog);
        double standards = ranker.score("https://www.ietf.org/rfc/rfc793.txt", "RFC 793", body(500), "transmission control protocol").authority();
        assertTrue(standards > blog);
    }

    @Test
    void relevanceLiftsACandidateWithinTheSameDomain() {
        String query = "isolation levels anomalies";
        double onTopic = ranker.score("https://en.wikipedia.org/wiki/Isolation_level", "Isolation level anomalies", body(500) + " isolation anomalies", query).relevance();
        double offTopic = ranker.score("https://en.wikipedia.org/wiki/Coffee", "Coffee", body(500), query).relevance();
        assertTrue(onTopic > offTopic);
    }

    @Test
    void thinContentIsPenalisedWhateverTheDomain() {
        double thin = ranker.score("https://en.wikipedia.org/wiki/Elasticity", "Elasticity", "short", "elasticity").depth();
        double solid = ranker.score("https://en.wikipedia.org/wiki/Elasticity", "Elasticity", body(1200), "elasticity").depth();
        assertTrue(solid > thin);
    }

    @Test
    void scoresStayInTheUnitRange() {
        SourceRanker.Score score = ranker.score("https://example.com/", "", body(200), "");
        assertTrue(score.total() >= 0 && score.total() <= 1);
        assertTrue(score.authority() >= 0 && score.authority() <= 1);
        assertTrue(score.relevance() >= 0 && score.relevance() <= 1);
        assertTrue(score.depth() >= 0 && score.depth() <= 1);
    }

    @Test
    void theSameCandidateAlwaysScoresTheSame() {
        var first = ranker.score("https://en.wikipedia.org/wiki/Transcription", "Transcription", body(800), "transcription biology");
        var second = ranker.score("https://en.wikipedia.org/wiki/Transcription", "Transcription", body(800), "transcription biology");
        assertEquals(first, second);
    }

    private static String body(int words) {
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < words; i++) result.append("word ");
        return result.toString();
    }
}
