package com.studyos.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The extraction quality gate, against every domain the brief demands. These rules must hold for
 * any subject: exam metadata never becomes a topic, instruction verbs never become topics,
 * technical tokens with numbers survive, and non-English phrases are judged on shape alone.
 */
class TopicCandidateQualityTest {

    private boolean valid(String name) { return TopicCandidateQuality.evaluate(name).accepted(); }

    // ---------------------------------------------------------------- the exact junk from the corpus

    @Test
    void pointMarkerPackagingIsRejected() {
        assertThat(valid("Sliding Windows Protocol (20 Pt)")).isTrue();
        assertThat(TopicCandidateQuality.evaluate("(20 Pt)").reason()).isEqualTo(TopicCandidateQuality.RejectionReason.POINT_MARKER);
        assertThat(TopicCandidateQuality.evaluate("(20 credit points)").reason()).isEqualTo(TopicCandidateQuality.RejectionReason.POINT_MARKER);
        assertThat(TopicCandidateQuality.evaluate("10 marks").accepted()).isFalse();
        assertThat(TopicCandidateQuality.evaluate("20%").accepted()).isFalse();
    }

    @Test
    void standaloneInstructionVerbsAreRejected() {
        assertThat(valid("Show")).isFalse();
        assertThat(TopicCandidateQuality.evaluate("Show").reason()).isEqualTo(TopicCandidateQuality.RejectionReason.VERB_ONLY);
        assertThat(valid("Calculate")).isFalse();
        assertThat(valid("Explain")).isFalse();
        assertThat(valid("Prove or disprove")).isFalse();
        assertThat(TopicCandidateQuality.evaluate("Prove or disprove").reason())
                .isEqualTo(TopicCandidateQuality.RejectionReason.INSTRUCTION_FRAGMENT);
    }

    @Test
    void instructionSentencesAreFragmentsEvenWhenLong() {
        assertThat(valid("Show that Lamport timestamps preserve the happens-before relation")).isFalse();
        assertThat(valid("give a recursive construction of multiplexers with inputs and outputs")).isFalse();
        assertThat(valid("decompose into permutations")).isFalse();
    }

    @Test
    void structuralLabelsAndQuestionMetadataAreRejected() {
        assertThat(valid("Q1")).isFalse();
        assertThat(valid("Question 4")).isFalse();
        assertThat(valid("Hint")).isFalse();
        assertThat(valid("Hints")).isFalse();
        assertThat(valid("Further information")).isFalse();
        assertThat(valid("Intended meaning")).isFalse();
        assertThat(valid("References")).isFalse();
    }

    @Test
    void garbledAndCodeFragmentsAreRejected() {
        assertThat(valid("give a recursive construction of multiplexers withI???")).isFalse();
        assertThat(valid("exit(0)")).isFalse();
    }

    @Test
    void lowInformationGenericSinglesAreRejected() {
        assertThat(valid("execution")).isFalse();
        assertThat(valid("enabled")).isFalse();
        assertThat(valid("Idea")).isFalse();
        assertThat(valid("Time")).isFalse();
    }

    // ---------------------------------------------------------------- the concepts that must survive

    @Test
    void realConceptsAcrossDomainsSurvive() {
        assertThat(valid("Lamport timestamps")).isTrue();
        assertThat(valid("happens-before relation")).isTrue();
        assertThat(valid("Lamport clocks")).isTrue();
        assertThat(valid("CRC")).isTrue();
        assertThat(valid("CRC error detection")).isTrue();
        assertThat(valid("derivative")).isTrue();
        assertThat(valid("Newton's second law")).isTrue();
        assertThat(valid("acceleration")).isTrue();
        assertThat(valid("mRNA")).isTrue();
        assertThat(valid("translation")).isTrue();
        assertThat(valid("Treaty of Versailles")).isTrue();
        assertThat(valid("price elasticity of demand")).isTrue();
        assertThat(valid("Fairness")).isTrue();
        assertThat(valid("Leader election in rings")).isTrue();
        assertThat(valid("Definition of fairness")).isTrue();
        assertThat(valid("Invariants of the sliding window protocol")).isTrue();
    }

    @Test
    void technicalTokensWithNumbersSurvive() {
        assertThat(valid("HTTP/2")).isTrue();
        assertThat(valid("IPv6")).isTrue();
        assertThat(valid("SHA-256")).isTrue();
        assertThat(valid("Java 21")).isTrue();
        assertThat(valid("World War II")).isTrue();
        assertThat(valid("World War I")).isTrue();
        assertThat(valid("2-phase commit")).isTrue();
        assertThat(valid("3NF")).isTrue();
        assertThat(valid("TLS 1.3")).isTrue();
    }

    @Test
    void hyphenatedVerbCompoundsAreNotInstructions() {
        assertThat(valid("Compare-and-swap")).isTrue();
        assertThat(TopicCandidateQuality.evaluate("Compare-and-swap").reason())
                .isEqualTo(TopicCandidateQuality.RejectionReason.VALID);
    }

    @Test
    void verbLikeSubstringsInsideConceptsNeverReject() {
        assertThat(valid("Consideration in contract law")).isTrue();
        assertThat(valid("Derivative pricing")).isTrue();
        assertThat(valid("State machines")).isTrue();
        assertThat(valid("List comprehension")).isTrue();
    }

    // ---------------------------------------------------------------- multilingual safety

    @Test
    void germanConceptsPassOnShape() {
        assertThat(valid("Grenznutzen")).isTrue();
        assertThat(valid("Netzwerkschichtenmodell")).isTrue();
        // Bounded German instruction verbs are recognized.
        assertThat(valid("Berechnen Sie den Rest")).isFalse();
    }

    @Test
    void russianInstructionVerbsAreRecognized_andConceptsPassOnShape() {
        assertThat(valid("объясните смысл алгоритма")).isFalse();
        assertThat(TopicCandidateQuality.evaluate("объясните смысл алгоритма").reason())
                .isEqualTo(TopicCandidateQuality.RejectionReason.INSTRUCTION_FRAGMENT);
        // A non-English concept passes: shape rules, not an English lexicon, decide.
        assertThat(valid("инфляция")).isTrue();
        assertThat(valid("განაწილებული სისტემები")).isTrue();
    }

    // ---------------------------------------------------------------- normalization & salvage

    @Test
    void assessmentMetadataIsStrippedFromExtractionTextWithoutTouchingTechnicalTokens() {
        String cleaned = TopicCandidateQuality.stripAssessmentMetadata(
                "Q3. Show that Lamport clocks preserve happens-before. (20 Pt)\n"
                + "1) Calculate the CRC remainder. [10 marks]\n"
                + "802.11 is a Wi-Fi standard.\n"
                + "TLS 1.3 encrypts the channel.\n"
                + "Exercise 7: Explain mRNA.\n"
                + "Aufgabe 5: Berechnen Sie den Rest.");
        assertThat(cleaned).doesNotContain("(20 Pt)").doesNotContain("[10 marks]");
        assertThat(cleaned).doesNotContain("Q3.").doesNotContain("Exercise 7:").doesNotContain("Aufgabe 5:");
        assertThat(cleaned).contains("802.11 is a Wi-Fi standard");
        assertThat(cleaned).contains("TLS 1.3 encrypts the channel");
    }

    @Test
    void salvageRecoversTheConceptFromPackagedNames() {
        assertThat(TopicCandidateQuality.evaluate("Fairness (20 Pt)").salvaged()).isEqualTo("Fairness");
        assertThat(TopicCandidateQuality.evaluate("Leader election in rings (20 credit points)").salvaged())
                .isEqualTo("Leader election in rings");
        assertThat(TopicCandidateQuality.evaluate("One???s Complement").salvaged()).isEqualTo("One's Complement");
        assertThat(valid("One's Complement")).isTrue();
    }

    @Test
    void importanceNeverRescuesGarbage() {
        // Even at maximum hypothetical importance, the decision is structural: reject.
        assertThat(TopicCandidateQuality.evaluate("20 Pt").accepted()).isFalse();
        assertThat(TopicCandidateQuality.evaluate("know").accepted()).isFalse();
    }
}
