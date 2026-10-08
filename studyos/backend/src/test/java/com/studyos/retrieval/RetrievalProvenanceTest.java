package com.studyos.retrieval;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The provenance rule for the final selection: in a mixed workspace the learner's own material is
 * primary, and researched web material fills what the uploads do not cover. The preference is a
 * stable partition — ranking inside each class is untouched — and it is a no-op in every mode
 * where there is nothing to prefer over.
 */
class RetrievalProvenanceTest {

    private static HybridRetriever.RetrievedChunk uploaded(double score) {
        return new HybridRetriever.RetrievedChunk(UUID.randomUUID(), "uploaded text", score, 1, 2, UUID.randomUUID(), "Lecture.pdf", "", false);
    }

    private static HybridRetriever.RetrievedChunk external(double score) {
        return new HybridRetriever.RetrievedChunk(UUID.randomUUID(), "web text", score, 1, 2, UUID.randomUUID(), "GraalVM", "", true);
    }

    @Test
    void mixedSelectionsPutUploadedMaterialFirstWithoutTouchingRankOrder() {
        var strong = external(.95);
        var weak = uploaded(.4);
        var mid = uploaded(.6);
        List<HybridRetriever.RetrievedChunk> result = HybridRetriever.preferUploaded(List.of(strong, mid, weak), true);
        assertEquals(List.of(mid, weak, strong), result, "every uploaded passage outranks every external one, in rank order");
    }

    @Test
    void externalEvidenceStillSurfacesWhenUploadsDoNotCoverTheTopic() {
        var first = external(.9);
        var second = external(.5);
        assertEquals(List.of(first, second), HybridRetriever.preferUploaded(List.of(first, second), true),
                "a topic the uploads never mention keeps its external matches");
    }

    @Test
    void uploadedOnlyAndExternalOnlySelectionsAreUnchanged() {
        var a = uploaded(.9);
        var b = uploaded(.5);
        assertEquals(List.of(a, b), HybridRetriever.preferUploaded(List.of(a, b), true));
        var x = external(.9);
        var y = external(.5);
        assertEquals(List.of(x, y), HybridRetriever.preferUploaded(List.of(x, y), true));
    }

    @Test
    void otherModesLeaveRankingExactlyAsItWas() {
        var strong = external(.95);
        var weak = uploaded(.4);
        List<HybridRetriever.RetrievedChunk> result = HybridRetriever.preferUploaded(List.of(strong, weak), false);
        assertEquals(List.of(strong, weak), result, "RESEARCH_ONLY and SOURCE_ONLY rank purely on relevance");
    }

    @Test
    void passageAssemblerCarriesProvenanceThroughToPassages() {
        UUID section = UUID.randomUUID();
        UUID document = UUID.randomUUID();
        var webHit = new PassageAssembler.Candidate(UUID.randomUUID(), 1, section, "s", document, "GraalVM", 1, 1, "web text", .9, true, true);
        var webNeighbour = new PassageAssembler.Candidate(UUID.randomUUID(), 2, section, "s", document, "GraalVM", 1, 2, "more web text", 0, false, true);
        PassageAssembler.Assembly assembly = PassageAssembler.assemble(List.of(webHit, webNeighbour), 0);
        assertEquals(1, assembly.passages().size());
        assertTrue(assembly.passages().get(0).external(), "the passage keeps the external flag of its document");

        UUID ownDocument = UUID.randomUUID();
        var ownHit = new PassageAssembler.Candidate(UUID.randomUUID(), 1, section, "s", ownDocument, "Lecture.pdf", 3, 3, "own text", .9, true);
        var ownNeighbour = new PassageAssembler.Candidate(UUID.randomUUID(), 2, section, "s", ownDocument, "Lecture.pdf", 3, 4, "more own text", 0, false);
        PassageAssembler.Assembly own = PassageAssembler.assemble(List.of(ownHit, ownNeighbour), 0);
        assertFalse(own.passages().get(0).external(), "uploaded material stays unmarked");
    }
}
