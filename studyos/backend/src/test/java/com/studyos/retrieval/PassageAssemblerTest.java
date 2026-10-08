package com.studyos.retrieval;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class PassageAssemblerTest {
    private static final UUID DOCUMENT = UUID.randomUUID();
    private static final UUID SECTION_A = UUID.randomUUID();
    private static final UUID SECTION_B = UUID.randomUUID();

    /**
     * The failure this exists for: a chunk is a window, so retrieval hands over prose that starts mid-derivation
     * and stops before the conclusion. The chunk either side is usually the rest of it.
     */
    @Test void aMatchArrivesWithTheChunksEitherSideOfIt() {
        var assembly = PassageAssembler.assemble(List.of(
                neighbour(1, "The generator polynomial divides x^n minus one."),
                match(2, "Therefore every codeword is a multiple of it.", 0.9),
                neighbour(3, "This gives the systematic encoding below.")), 0);
        assertThat(assembly.passages()).hasSize(1);
        assertThat(assembly.passages().get(0).content())
                .contains("divides x^n minus one")
                .contains("every codeword is a multiple")
                .contains("systematic encoding below");
    }

    /** Expansion stops at the section boundary: the next section is about a different thing. */
    @Test void expansionDoesNotCrossIntoTheNextSection() {
        var assembly = PassageAssembler.assemble(List.of(
                match(4, "Cyclic codes are closed under rotation.", 0.9),
                new PassageAssembler.Candidate(UUID.randomUUID(), 5, SECTION_B, "3 Convolutional codes", DOCUMENT, "Coding.pdf", 6, 6, "Convolutional codes use a sliding window.", 0, false)), 0);
        assertThat(assembly.passages()).hasSize(1);
        assertThat(assembly.passages().get(0).content()).doesNotContain("sliding window");
        assertThat(assembly.passages().get(0).sectionPath()).isEqualTo("2 Cyclic codes");
    }

    /** Several hits in one section are one stretch of text, not several pieces of evidence repeating one header. */
    @Test void hitsInOneSectionBecomeOnePassage() {
        var assembly = PassageAssembler.assemble(List.of(
                match(1, "First paragraph of the section.", 0.7),
                match(2, "Second paragraph of the section.", 0.9)), 0);
        assertThat(assembly.passages()).hasSize(1);
        assertThat(assembly.passages().get(0).matchedChunks()).isEqualTo(2);
        assertThat(assembly.passages().get(0).content()).isEqualTo("First paragraph of the section.\n\nSecond paragraph of the section.");
        // The passage ranks by the best hit in it rather than an average that expansion would dilute.
        assertThat(assembly.passages().get(0).score()).isEqualTo(0.9);
    }

    /** Two sections stay two passages even when they are adjacent in the document. */
    @Test void hitsInDifferentSectionsStaySeparatePassages() {
        var assembly = PassageAssembler.assemble(List.of(
                match(1, "Cyclic codes are closed under rotation.", 0.8),
                new PassageAssembler.Candidate(UUID.randomUUID(), 2, SECTION_B, "3 Convolutional codes", DOCUMENT, "Coding.pdf", 6, 6, "Convolutional codes use a sliding window.", 0.9, true)), 0);
        assertThat(assembly.passages()).hasSize(2);
        assertThat(assembly.passages()).extracting(PassageAssembler.Passage::sectionPath).containsExactly("3 Convolutional codes", "2 Cyclic codes");
    }

    /**
     * Two separated hits in one section are two passages. Joining across the gap would present text the model was
     * never given as the continuation of text it was — a fabricated continuity inside real quotations.
     */
    @Test void aGapInTheOrdinalsSplitsThePassageRatherThanBeingJoinedOver() {
        var assembly = PassageAssembler.assemble(List.of(
                match(1, "The encoder multiplies by the generator.", 0.9),
                match(9, "The decoder divides and inspects the remainder.", 0.8)), 0);
        assertThat(assembly.passages()).hasSize(2);
        assertThat(assembly.passages().get(0).content()).isEqualTo("The encoder multiplies by the generator.");
        assertThat(assembly.passages().get(1).content()).isEqualTo("The decoder divides and inspects the remainder.");
    }

    /** A passage's page range covers everything in it, which is exactly what a citation to it may claim. */
    @Test void aPassageSpansThePagesOfEverythingInIt() {
        var assembly = PassageAssembler.assemble(List.of(
                new PassageAssembler.Candidate(UUID.randomUUID(), 1, SECTION_A, "2 Cyclic codes", DOCUMENT, "Coding.pdf", 4, 4, "Opening.", 0, false),
                new PassageAssembler.Candidate(UUID.randomUUID(), 2, SECTION_A, "2 Cyclic codes", DOCUMENT, "Coding.pdf", 4, 5, "Middle.", 0.9, true),
                new PassageAssembler.Candidate(UUID.randomUUID(), 3, SECTION_A, "2 Cyclic codes", DOCUMENT, "Coding.pdf", 5, 6, "End.", 0, false)), 0);
        assertThat(assembly.passages().get(0).pageStart()).isEqualTo(4);
        assertThat(assembly.passages().get(0).pageEnd()).isEqualTo(6);
    }

    /**
     * The budget drops whole passages. Cutting the block with a substring left the last one ending mid-word while
     * its citation still claimed the pages of the part that had been cut away, so an answer could cite a page the
     * model never received.
     */
    @Test void theBudgetDropsWholePassagesRatherThanCuttingOne() {
        String long1 = "A".repeat(400);
        String long2 = "B".repeat(400);
        var assembly = PassageAssembler.assemble(List.of(
                match(1, long1, 0.9),
                new PassageAssembler.Candidate(UUID.randomUUID(), 5, SECTION_B, "3 Convolutional codes", DOCUMENT, "Coding.pdf", 9, 9, long2, 0.5, true)), 500);
        assertThat(assembly.passages()).hasSize(1);
        assertThat(assembly.passages().get(0).content()).isEqualTo(long1);
        assertThat(assembly.droppedToBudget()).isEqualTo(1);
        assertThat(assembly.assembled()).isEqualTo(2);
        assertThat(assembly.charsUsed()).isLessThanOrEqualTo(500);
    }

    /** What was dropped is counted, because evidence found and not shown is not the same as evidence absent. */
    @Test void nothingDroppedIsReportedAsNothingDropped() {
        var assembly = PassageAssembler.assemble(List.of(match(1, "Short enough.", 0.9)), 500);
        assertThat(assembly.droppedToBudget()).isZero();
        assertThat(assembly.assembled()).isEqualTo(1);
    }

    /** A budget smaller than the best passage still yields that passage, cut, rather than no evidence at all. */
    @Test void aBudgetSmallerThanTheBestPassageStillYieldsIt() {
        var assembly = PassageAssembler.assemble(List.of(match(1, "C".repeat(900), 0.9)), 300);
        assertThat(assembly.passages()).hasSize(1);
        assertThat(assembly.passages().get(0).content()).hasSize(300);
    }

    /** Higher-scoring passages are offered first, and ties break deterministically rather than by map order. */
    @Test void passagesAreOfferedBestFirstAndTiesAreDeterministic() {
        var low = new PassageAssembler.Candidate(UUID.randomUUID(), 20, UUID.randomUUID(), "9 Appendix", DOCUMENT, "Coding.pdf", 30, 30, "Appendix note.", 0.2, true);
        var high = match(1, "The main result.", 0.95);
        assertThat(PassageAssembler.assemble(List.of(low, high), 0).passages()).extracting(PassageAssembler.Passage::score).containsExactly(0.95, 0.2);
        assertThat(PassageAssembler.assemble(List.of(high, low), 0).passages()).extracting(PassageAssembler.Passage::score).containsExactly(0.95, 0.2);
    }

    /** Neighbours around nothing are not evidence: only a ranked chunk can make a passage exist. */
    @Test void neighboursWithNoMatchInTheirSectionProduceNoPassage() {
        var assembly = PassageAssembler.assemble(List.of(
                neighbour(1, "Unmatched text."),
                neighbour(2, "More unmatched text.")), 0);
        assertThat(assembly.passages()).isEmpty();
        assertThat(assembly.assembled()).isZero();
    }

    /** A neighbour too far from any match in its own section is dropped rather than padding the passage. */
    @Test void aNeighbourFarFromEveryMatchIsDropped() {
        var assembly = PassageAssembler.assemble(List.of(
                match(1, "The matched passage.", 0.9),
                neighbour(7, "Unrelated text from further down the section.")), 0);
        assertThat(assembly.passages()).hasSize(1);
        assertThat(assembly.passages().get(0).content()).isEqualTo("The matched passage.");
    }

    /** A chunk supplied as both a hit and a neighbour is one chunk, and it is the hit that counts. */
    @Test void aChunkSuppliedTwiceKeepsItsMatchedIdentity() {
        UUID id = UUID.randomUUID();
        var assembly = PassageAssembler.assemble(List.of(
                new PassageAssembler.Candidate(id, 2, SECTION_A, "2 Cyclic codes", DOCUMENT, "Coding.pdf", 5, 5, "The passage.", 0, false),
                new PassageAssembler.Candidate(id, 2, SECTION_A, "2 Cyclic codes", DOCUMENT, "Coding.pdf", 5, 5, "The passage.", 0.9, true)), 0);
        assertThat(assembly.passages()).hasSize(1);
        assertThat(assembly.passages().get(0).matchedChunks()).isEqualTo(1);
        assertThat(assembly.passages().get(0).content()).isEqualTo("The passage.");
        assertThat(assembly.passages().get(0).score()).isEqualTo(0.9);
    }

    /**
     * A document ingested before sections were a tree has no section id, so the document is the widest honest
     * boundary to consolidate within. Those documents must keep working until they are restructured.
     */
    @Test void chunksWithNoSectionConsolidateByDocumentInstead() {
        var assembly = PassageAssembler.assemble(List.of(
                new PassageAssembler.Candidate(UUID.randomUUID(), 1, null, "", DOCUMENT, "Legacy.pdf", 1, 1, "First half.", 0.8, true),
                new PassageAssembler.Candidate(UUID.randomUUID(), 2, null, "", DOCUMENT, "Legacy.pdf", 1, 2, "Second half.", 0.9, true)), 0);
        assertThat(assembly.passages()).hasSize(1);
        assertThat(assembly.passages().get(0).content()).isEqualTo("First half.\n\nSecond half.");
        assertThat(assembly.passages().get(0).sectionPath()).isEmpty();
    }

    /** No candidates is an empty assembly, not an exception, because a query that matches nothing is ordinary. */
    @Test void noCandidatesIsAnsweredRatherThanThrown() {
        assertThat(PassageAssembler.assemble(List.of(), 500).passages()).isEmpty();
        assertThat(PassageAssembler.assemble(null, 500).passages()).isEmpty();
    }

    private static PassageAssembler.Candidate match(int ordinal, String content, double score) {
        return new PassageAssembler.Candidate(UUID.randomUUID(), ordinal, SECTION_A, "2 Cyclic codes", DOCUMENT, "Coding.pdf", ordinal, ordinal, content, score, true);
    }

    private static PassageAssembler.Candidate neighbour(int ordinal, String content) {
        return new PassageAssembler.Candidate(UUID.randomUUID(), ordinal, SECTION_A, "2 Cyclic codes", DOCUMENT, "Coding.pdf", ordinal, ordinal, content, 0, false);
    }
}
