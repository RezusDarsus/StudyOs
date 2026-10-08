package com.studyos.verify;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ClaimProvenanceTest {
    private static final UUID DOCUMENT = UUID.randomUUID();
    private static final UUID CYCLIC_CHUNK = UUID.randomUUID();
    private static final UUID THREAD_CHUNK = UUID.randomUUID();

    /** The passage a claim cites is the passage recorded behind it, by the chunk ids that were supplied. */
    @Test void aClaimCitingSuppliedEvidenceIsSourcedToThatPassagesChunks() {
        var ledger = ClaimProvenance.of("A cyclic code is closed under cyclic rotation of its codewords [[Source: Coding.pdf; pages 4-6]].", List.of(cyclic()));
        assertThat(ledger.claims()).hasSize(1);
        assertThat(ledger.claims().get(0).origin()).isEqualTo(ClaimProvenance.Origin.SOURCE);
        assertThat(ledger.claims().get(0).evidence()).extracting(ClaimProvenance.EvidenceLink::chunkId).containsExactly(CYCLIC_CHUNK);
        assertThat(ledger.claims().get(0).evidence()).extracting(ClaimProvenance.EvidenceLink::linkType).containsExactly(ClaimProvenance.LinkType.CITED);
    }

    /**
     * The failure this exists for: a chunk id must be a fact about what StudyOS supplied. A citation naming a
     * document that was not retrieved for the turn resolves to nothing, so no chunk is recorded behind the claim —
     * and the claim's own vocabulary then decides its class, which here is nothing the model was shown.
     */
    @Test void aCitationToSomethingNeverSuppliedRecordsNoEvidenceAtAll() {
        var ledger = ClaimProvenance.of("Beam search decoding keeps the highest scoring hypotheses at every step [[Source: Invented.pdf; pages 1-2]].", List.of(cyclic()));
        assertThat(ledger.claims()).hasSize(1);
        assertThat(ledger.claims().get(0).evidence()).isEmpty();
        assertThat(ledger.claims().get(0).origin()).isEqualTo(ClaimProvenance.Origin.EXTERNAL);
        // Cited and external at once is the fingerprint of a fabricated reference, which is why the two are stored
        // separately: one column says the answer pointed somewhere, the other that nothing was there.
        assertThat(ledger.claims().get(0).cited()).isTrue();
    }

    /** A citation to a page of a supplied document that was not the supplied page resolves to nothing. */
    @Test void aCitationToPagesOutsideWhatWasSuppliedDoesNotResolve() {
        var ledger = ClaimProvenance.of("The generator polynomial of a cyclic code divides x^n minus one [[Source: Coding.pdf; pages 40-42]].", List.of(cyclic()));
        assertThat(ledger.claims().get(0).evidence()).extracting(ClaimProvenance.EvidenceLink::linkType).doesNotContain(ClaimProvenance.LinkType.CITED);
        // Written in the supplied passage's own words, so it is grounded in the material even with a bad reference —
        // and the chunk behind it is recorded as an overlap, which is what it is, rather than as something cited.
        assertThat(ledger.claims().get(0).origin()).isEqualTo(ClaimProvenance.Origin.DERIVED);
        assertThat(ledger.claims().get(0).evidence()).extracting(ClaimProvenance.EvidenceLink::linkType).containsExactly(ClaimProvenance.LinkType.OVERLAP);
    }

    /** An uncited claim written in a supplied passage's vocabulary is derived from it, and says which one. */
    @Test void anUncitedClaimInTheEvidencesOwnVocabularyIsDerivedFromIt() {
        var ledger = ClaimProvenance.of("Rotating a codeword of a cyclic code produces another codeword of the same code.", List.of(cyclic(), threads()));
        assertThat(ledger.claims()).hasSize(1);
        assertThat(ledger.claims().get(0).origin()).isEqualTo(ClaimProvenance.Origin.DERIVED);
        assertThat(ledger.claims().get(0).cited()).isFalse();
        assertThat(ledger.claims().get(0).evidence()).extracting(ClaimProvenance.EvidenceLink::chunkId).containsExactly(CYCLIC_CHUNK);
        assertThat(ledger.claims().get(0).evidence()).extracting(ClaimProvenance.EvidenceLink::linkType).containsExactly(ClaimProvenance.LinkType.OVERLAP);
    }

    /**
     * The class the record exists for. A claim with plenty of distinctive vocabulary, none of it in anything the
     * model was shown, came from the model rather than from the course — and nothing in the answer says so.
     */
    @Test void aClaimUsingNoneOfTheSuppliedVocabularyIsExternal() {
        var ledger = ClaimProvenance.of("Mitochondria generate adenosine triphosphate through oxidative phosphorylation across the inner membrane.", List.of(cyclic()));
        assertThat(ledger.claims()).hasSize(1);
        assertThat(ledger.claims().get(0).origin()).isEqualTo(ClaimProvenance.Origin.EXTERNAL);
        assertThat(ledger.claims().get(0).evidence()).isEmpty();
    }

    /**
     * One shared long word is coincidence, not provenance. Two unrelated subjects both say "different" and
     * "structure", and a threshold of one would have reported an invented claim as grounded in the material.
     */
    @Test void oneSharedTermIsNotEnoughToCallAClaimDerived() {
        var ledger = ClaimProvenance.of("Riemannian manifolds equipped with a metric tensor determine geodesic polynomial curvature everywhere.", List.of(cyclic()));
        assertThat(ledger.claims().get(0).origin()).isEqualTo(ClaimProvenance.Origin.EXTERNAL);
    }

    /**
     * A claim with too little distinctive vocabulary to place is unjudged, not external. Recording a connective
     * sentence as having come from outside the course asserts a measurement that was never taken.
     */
    @Test void aClaimWithTooFewDistinctiveTermsIsUnjudgedRatherThanExternal() {
        var ledger = ClaimProvenance.of("So the same idea holds here as well, for the same reason.", List.of(cyclic()));
        assertThat(ledger.claims()).isEmpty();
        assertThat(ledger.unjudged()).isEqualTo(1);
        assertThat(ledger.measured()).isTrue();
    }

    /**
     * A claim about the learner is checked against their recorded attempts, not against the course material. It is
     * counted here and classified nowhere, because calling it external is exactly backwards — the lecture notes
     * are not supposed to contain how this student is doing.
     */
    @Test void aClaimAboutTheLearnerIsCountedSeparatelyRatherThanClassified() {
        var ledger = ClaimProvenance.of("Your mastery of cyclic codes is 62% and your last attempt was three days ago.", List.of(cyclic()));
        assertThat(ledger.claims()).isEmpty();
        assertThat(ledger.aboutLearner()).isEqualTo(1);
    }

    /**
     * With nothing supplied there is nothing to classify against, and the answer must not be recorded as fully
     * external. An unmeasured turn stored as "every claim came from outside the material" is a number about
     * evidence that was never examined, and it would drag every aggregate taken over the course.
     */
    @Test void noSuppliedEvidenceIsUnmeasuredRatherThanFullyExternal() {
        var ledger = ClaimProvenance.of("Mitochondria generate adenosine triphosphate through oxidative phosphorylation.", List.of());
        assertThat(ledger.measured()).isFalse();
        assertThat(ledger.claims()).isEmpty();
        assertThat(ledger.count(ClaimProvenance.Origin.EXTERNAL)).isZero();
        assertThat(ClaimProvenance.of("Anything at all that asserts something about a subject.", null).measured()).isFalse();
    }

    /** Questions, headings and one-line fragments are not claims, and counting them would dilute every figure. */
    @Test void questionsAndFragmentsAreNotRecordedAsClaims() {
        var ledger = ClaimProvenance.of("## Cyclic codes\nWhat makes a linear code cyclic under rotation of codewords?\nSee below.", List.of(cyclic()));
        assertThat(ledger.claims()).isEmpty();
        assertThat(ledger.unjudged()).isZero();
    }

    /** Each sentence is placed on its own, so one grounded answer and one invented sentence are both visible. */
    @Test void anAnswerIsPlacedSentenceBySentenceRatherThanAsAWhole() {
        var ledger = ClaimProvenance.of("A cyclic code is closed under rotation of its codewords [[Source: Coding.pdf; pages 4-6]]. "
                + "Mitochondria generate adenosine triphosphate through oxidative phosphorylation across membranes.", List.of(cyclic()));
        assertThat(ledger.claims()).extracting(ClaimProvenance.Claim::origin).containsExactly(ClaimProvenance.Origin.SOURCE, ClaimProvenance.Origin.EXTERNAL);
        assertThat(ledger.claims()).extracting(ClaimProvenance.Claim::ordinal).containsExactly(0, 1);
        assertThat(ledger.classified()).isEqualTo(2);
        assertThat(ledger.count(ClaimProvenance.Origin.SOURCE)).isEqualTo(1);
    }

    /** A synthesis is linked to the passages it drew on, most overlap first, and not to everything supplied. */
    @Test void aClaimDrawingOnSeveralPassagesIsLinkedToThemInOrderOfOverlap() {
        var ledger = ClaimProvenance.of("Encoding a codeword and scheduling a thread are both operations described by their own state.", List.of(cyclic(), threads()));
        var claim = ledger.claims().get(0);
        assertThat(claim.origin()).isEqualTo(ClaimProvenance.Origin.DERIVED);
        assertThat(claim.evidence()).extracting(ClaimProvenance.EvidenceLink::chunkId).containsExactly(THREAD_CHUNK);
    }

    /**
     * Support is the share of a claim's own terms found in the evidence. Zero is reachable and is a measurement:
     * a claim about photosynthesis against a passage on cyclic codes shares nothing at all.
     *
     * <p>The invented-but-adjacent case is the one worth reading. "Generate" and "generator" agree on six letters,
     * so the prefix stem this class shares with the audits beside it credits one term by accident — which is
     * exactly why a claim needs <em>two</em> agreeing terms before it counts as written from a passage. One
     * accidental agreement moves the support figure slightly and does not move the class at all.
     */
    @Test void supportIsAShareOfTheClaimsTermsAndZeroIsAMeasurement() {
        var grounded = ClaimProvenance.of("Rotating a codeword of a cyclic code produces another codeword.", List.of(cyclic()));
        assertThat(grounded.claims().get(0).support()).isGreaterThan(0.5);
        var unrelated = ClaimProvenance.of("Photosynthesis converts sunlight into chemical energy inside chloroplast thylakoid membranes.", List.of(cyclic()));
        assertThat(unrelated.claims().get(0).support()).isZero();
        assertThat(unrelated.claims().get(0).origin()).isEqualTo(ClaimProvenance.Origin.EXTERNAL);
        var adjacent = ClaimProvenance.of("Mitochondria generate adenosine triphosphate through oxidative phosphorylation across membranes.", List.of(cyclic()));
        assertThat(adjacent.claims().get(0).support()).isLessThan(0.2).isGreaterThan(0);
        assertThat(adjacent.claims().get(0).origin()).isEqualTo(ClaimProvenance.Origin.EXTERNAL);
    }

    /**
     * A recorded claim whose support could not be measured says so with {@link ClaimProvenance#UNMEASURED} rather
     * than with zero. It cites a supplied passage, so it is SOURCE on the strength of the reference; it has almost
     * no distinctive vocabulary, so how much of it that passage says is a question this cannot answer. Storing that
     * as zero support would make a properly cited sentence read as a groundless one in every average taken.
     */
    @Test void aCitedClaimWithNothingToMeasureCarriesNoSupportFigureRatherThanZero() {
        var ledger = ClaimProvenance.of("As shown there, this is why it works that way [[Source: Coding.pdf; pages 4-6]].", List.of(cyclic()));
        assertThat(ledger.claims()).hasSize(1);
        assertThat(ledger.claims().get(0).origin()).isEqualTo(ClaimProvenance.Origin.SOURCE);
        assertThat(ledger.claims().get(0).support()).isEqualTo(ClaimProvenance.UNMEASURED);
    }

    /** A passage assembled from several chunks records all of them: any of its text could be what the claim used. */
    @Test void everyChunkOfACitedPassageIsRecordedBehindTheClaim() {
        UUID second = UUID.randomUUID();
        var passage = new ClaimProvenance.SuppliedPassage(DOCUMENT, "Coding.pdf", "2 Cyclic codes", 4, 6, "A cyclic code is closed under rotation.", List.of(CYCLIC_CHUNK, second));
        var ledger = ClaimProvenance.of("A cyclic code is closed under cyclic rotation of its codewords [[Source: Coding.pdf; pages 5-5]].", List.of(passage));
        assertThat(ledger.claims().get(0).evidence()).extracting(ClaimProvenance.EvidenceLink::chunkId).containsExactly(CYCLIC_CHUNK, second);
        assertThat(ledger.chunksSupplied()).isEqualTo(2);
    }

    /** The same chunk behind one claim twice is one row: a claim citing a passage twice did not use it twice. */
    @Test void aChunkIsRecordedOncePerClaimHoweverOftenItIsCited() {
        var ledger = ClaimProvenance.of("A cyclic code is closed under rotation [[Source: Coding.pdf; pages 4-4]] of its codewords [[Source: Coding.pdf; pages 6-6]].", List.of(cyclic()));
        assertThat(ledger.claims().get(0).evidence()).hasSize(1);
    }

    /** The recorded provenance carries where the passage sits, so a stored claim can be read back in context. */
    @Test void theSectionAndPagesOfTheSupplyingPassageAreRecordedWithIt() {
        var ledger = ClaimProvenance.of("A cyclic code is closed under cyclic rotation of its codewords [[Source: Coding.pdf; pages 4-6]].", List.of(cyclic()));
        var link = ledger.claims().get(0).evidence().get(0);
        assertThat(link.sectionPath()).isEqualTo("2 Cyclic codes");
        assertThat(link.pageStart()).isEqualTo(4);
        assertThat(link.pageEnd()).isEqualTo(6);
        assertThat(link.documentId()).isEqualTo(DOCUMENT);
    }

    /** Counts describe the whole answer: the header figures plus what was supplied to judge it against. */
    @Test void theLedgerAccountsForWhatWasSuppliedAsWellAsWhatWasClaimed() {
        var ledger = ClaimProvenance.of("A cyclic code is closed under rotation of its codewords [[Source: Coding.pdf; pages 4-6]]. "
                + "So the same idea holds here as well, for the same reason. Your mastery of cyclic codes is 62% so far.", List.of(cyclic(), threads()));
        assertThat(ledger.passagesSupplied()).isEqualTo(2);
        assertThat(ledger.chunksSupplied()).isEqualTo(2);
        assertThat(ledger.classified()).isEqualTo(1);
        assertThat(ledger.unjudged()).isEqualTo(1);
        assertThat(ledger.aboutLearner()).isEqualTo(1);
    }

    /** An empty answer produces no claims rather than an exception, which is what a failed generation looks like. */
    @Test void anEmptyAnswerIsAnsweredRatherThanThrown() {
        assertThat(ClaimProvenance.of("", List.of(cyclic())).claims()).isEmpty();
        assertThat(ClaimProvenance.of(null, List.of(cyclic())).claims()).isEmpty();
        assertThat(ClaimProvenance.of(null, List.of(cyclic())).measured()).isTrue();
    }

    private static ClaimProvenance.SuppliedPassage cyclic() {
        return new ClaimProvenance.SuppliedPassage(DOCUMENT, "Coding.pdf", "2 Cyclic codes", 4, 6,
                "A cyclic code is a linear code closed under cyclic rotation of its codewords. Its generator polynomial divides x^n minus one.",
                List.of(CYCLIC_CHUNK));
    }

    private static ClaimProvenance.SuppliedPassage threads() {
        return new ClaimProvenance.SuppliedPassage(DOCUMENT, "Coding.pdf", "5 Scheduling", 20, 21,
                "A thread is scheduled by the operating system and each thread carries its own described execution state.",
                List.of(THREAD_CHUNK));
    }
}
