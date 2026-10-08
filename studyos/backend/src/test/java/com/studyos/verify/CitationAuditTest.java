package com.studyos.verify;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class CitationAuditTest {
    /** How the retrieved block reaches the model: one bracket, document name, page range. */
    private static final String EVIDENCE = """
            [Source: lecture-03.pdf; pages 12-18]
            A parity check appends redundant symbols to a message.

            [Source: lecture-03.pdf; pages 40-41]
            Burst errors affect consecutive symbols.

            [Source: seminar-notes.pdf; pages 5-5]
            Worked example of the same construction.
            """;

    @Test void acceptsACitationTheRetrievedEvidenceAttests() {
        assertThat(CitationAudit.findings("Redundant symbols are appended [[Source: lecture-03.pdf; pages 12-18]].", EVIDENCE)).isEmpty();
        assertThat(CitationAudit.findings("Consecutive symbols are affected [[Source: lecture-03.pdf; pages 40]].", EVIDENCE)).isEmpty();
        assertThat(CitationAudit.findings("See the worked example [[Source: seminar-notes.pdf; pages 5]].", EVIDENCE)).isEmpty();
    }

    /** A page inside a document that was retrieved, but not in any retrieved passage of it, is still unchecked. */
    @Test void flagsAPageThatWasNeverRetrievedFromThatDocument() {
        var findings = CitationAudit.findings("The proof is given [[Source: lecture-03.pdf; pages 27-29]].", EVIDENCE);
        assertThat(findings).singleElement().satisfies(finding -> {
            assertThat(finding.kind()).isEqualTo("unretrieved pages");
            assertThat(finding.detail()).contains("12-18", "40-41");
        });
    }

    @Test void flagsADocumentThatWasNeverRetrieved() {
        var findings = CitationAudit.findings("This is standard [[Source: textbook-chapter-9.pdf; pages 3-4]].", EVIDENCE);
        assertThat(findings).singleElement().satisfies(finding -> {
            assertThat(finding.kind()).isEqualTo("unretrieved source");
            assertThat(finding.detail()).contains("lecture-03.pdf", "seminar-notes.pdf");
        });
    }

    /** Some turns retrieve nothing by design, and an answer to one of those has nothing it can cite. */
    @Test void anAnswerWithNoEvidenceBehindItCanCiteNothing() {
        var findings = CitationAudit.findings("Start with the weakest area [[Source: lecture-03.pdf; pages 12-18]].", "");
        assertThat(findings).singleElement().satisfies(finding -> assertThat(finding.detail()).contains("no course evidence was retrieved"));
        assertThat(CitationAudit.findings("Start with the weakest area, then move on.", "")).isEmpty();
    }

    /**
     * The measured failure this exists for: a claim about one student footnoted to course material, which
     * cannot contain it. The claim itself is fine — only the citation attached to it is not.
     */
    @Test void flagsALearnerStateClaimAttributedToCourseMaterial() {
        var findings = CitationAudit.findings("Your weakest topic is the parity construction [[Source: lecture-03.pdf; pages 12-18]].", EVIDENCE);
        assertThat(findings).singleElement().satisfies(finding -> {
            assertThat(finding.kind()).isEqualTo("learner state cited to course material");
            assertThat(finding.detail()).contains("recorded attempts", "lecture-03.pdf");
        });
        assertThat(CitationAudit.findings("Your weakest topic is the parity construction, from your recorded attempts.", EVIDENCE)).isEmpty();
    }

    /**
     * The right way round is not a defect. A sentence that anchors the claim about the learner to a recorded
     * attempt and then points at the material covering it has cited learner evidence for the learner half; the
     * document is attribution for the topic, not a stand-in for a measurement.
     */
    @Test void allowsCourseMaterialBesideARecordedAttempt() {
        assertThat(CitationAudit.findings("You missed the parity construction [Learner: a1b2c3d4], which is covered in [[Source: lecture-03.pdf; pages 12-18]].", EVIDENCE)).isEmpty();
        assertThat(CitationAudit.findings("Your weakest topic is the parity construction [[Source: lecture-03.pdf; pages 12-18]].", EVIDENCE))
                .anyMatch(finding -> finding.kind().equals("learner state cited to course material"));
    }

    @Test void recognizesLearnerStateWordingBeyondTheWordWeakest() {
        for (String claim : java.util.List.of("You scored 40% on this material [[Source: lecture-03.pdf; pages 12]].",
                "You keep getting the boundary case wrong [[Source: lecture-03.pdf; pages 12]].",
                "You are not ready for this section yet [[Source: lecture-03.pdf; pages 12]].",
                "Based on your mastery, start here [[Source: lecture-03.pdf; pages 12]].",
                "Your mastery of it is 30% [[Source: lecture-03.pdf; pages 12]]."))
            assertThat(CitationAudit.findings(claim, EVIDENCE)).as(claim).anyMatch(finding -> finding.kind().contains("learner state"));
    }

    /** A statement about the subject that happens to address the reader is not a claim about their record. */
    @Test void doesNotFlagOrdinaryTutorialWording() {
        assertThat(CitationAudit.findings("You can see that the remainder is zero [[Source: lecture-03.pdf; pages 12-18]].", EVIDENCE)).isEmpty();
        assertThat(CitationAudit.findings("Note that you divide by the generator first [[Source: lecture-03.pdf; pages 40]].", EVIDENCE)).isEmpty();
        assertThat(CitationAudit.findings("If you apply the rule, the parity bit follows [[Source: seminar-notes.pdf; pages 5]].", EVIDENCE)).isEmpty();
    }

    @Test void reportsEachDistinctCitationOnceHoweverOftenItIsRepeated() {
        String answer = "First [[Source: gone.pdf; pages 1]]. Second [[Source: gone.pdf; pages 1]]. Third [[Source: gone.pdf; pages 2]].";
        assertThat(CitationAudit.findings(answer, EVIDENCE)).hasSize(2);
    }

    @Test void matchesDocumentNamesRegardlessOfCaseAndSpacing() {
        assertThat(CitationAudit.findings("Cited [[Source:  LECTURE-03.PDF ; pages 13 ]].", EVIDENCE)).isEmpty();
    }

    @Test void saysNothingWhenThereIsNothingToReport() {
        assertThat(CitationAudit.note(java.util.List.of())).isEmpty();
        assertThat(CitationAudit.findings(null, EVIDENCE)).isEmpty();
        assertThat(CitationAudit.findings("An answer with no citations at all.", EVIDENCE)).isEmpty();
    }

    /** The note names the reference rather than rewriting the answer, exactly as the computation check does. */
    @Test void theNoteNamesEveryUnverifiableReference() {
        var findings = CitationAudit.findings("As shown [[Source: textbook-chapter-9.pdf; pages 3-4]] and [[Source: lecture-03.pdf; pages 27]].", EVIDENCE);
        String note = CitationAudit.note(findings);
        assertThat(note).contains("Citation check", "textbook-chapter-9.pdf", "lecture-03.pdf; pages 27");
        assertThat(note).doesNotContain("pages 12-18\"");
    }

    @Test void everyClaimAttributedToRetrievedPagesScoresPerfectly() {
        var coverage = CitationAudit.coverage("Redundant symbols are appended to a message [[Source: lecture-03.pdf; pages 12-18]].", EVIDENCE);
        assertThat(coverage.citations()).isEqualTo(1);
        assertThat(coverage.attested()).isEqualTo(1);
        assertThat(coverage.subjectClaims()).isEqualTo(1);
        assertThat(coverage.citedClaims()).isEqualTo(1);
        assertThat(coverage.precision()).isEqualTo(1);
        assertThat(coverage.recall()).isEqualTo(1);
    }

    /** Precision and recall fail in opposite directions, and a single number cannot see both at once. */
    @Test void precisionAndRecallMeasureDifferentFailures() {
        String halfCited = "Redundant symbols are appended to a message [[Source: lecture-03.pdf; pages 12-18]]. "
                + "Burst errors affect consecutive symbols of the codeword.";
        var thorough = CitationAudit.coverage(halfCited, EVIDENCE);
        assertThat(thorough.precision()).isEqualTo(1);
        assertThat(thorough.recall()).isEqualTo(.5);

        String allCitedOneWrong = "Redundant symbols are appended to a message [[Source: lecture-03.pdf; pages 12-18]]. "
                + "Burst errors affect consecutive symbols [[Source: textbook-chapter-9.pdf; pages 3]].";
        var eager = CitationAudit.coverage(allCitedOneWrong, EVIDENCE);
        assertThat(eager.recall()).isEqualTo(1);
        assertThat(eager.precision()).isEqualTo(.5);
    }

    /** A claim about the learner's own record is right to be uncited, so it must not count against recall. */
    @Test void aClaimAboutTheLearnerIsNotACitableClaim() {
        var coverage = CitationAudit.coverage("Your weakest area is the parity construction from your recorded attempts.", EVIDENCE);
        assertThat(coverage.subjectClaims()).isZero();
        assertThat(coverage.recall()).isEqualTo(1);
    }

    /** Questions, headings and short fragments assert nothing, so asking them to cite would only manufacture noise. */
    @Test void onlySentencesThatAssertSomethingAreCounted() {
        String answer = """
                ## Parity construction
                Which redundant symbols does a parity check append?
                Short answer.
                """;
        assertThat(CitationAudit.coverage(answer, EVIDENCE).subjectClaims()).isZero();
    }

    /**
     * The standard comes from the pages retrieved for the turn, never from a list of words this system knows.
     * A sentence about something the evidence never mentions is out of the metric's reach, not a recall failure.
     */
    @Test void whatCountsAsAClaimIsSetByTheRetrievedEvidence() {
        String offTopic = "The compiler allocates registers during the optimisation phase of translation.";
        assertThat(CitationAudit.coverage(offTopic, EVIDENCE).subjectClaims()).isZero();
        assertThat(CitationAudit.coverage("A parity check appends redundant symbols to every message.", EVIDENCE).subjectClaims()).isEqualTo(1);
    }

    /** Inflection is not a change of subject: a sentence about one symbol is about the page that lists symbols. */
    @Test void anInflectedTermStillNamesTheSubject() {
        assertThat(CitationAudit.coverage("Each redundant symbol is appended after the original message.", EVIDENCE).subjectClaims()).isEqualTo(1);
    }

    /** Both bracket forms are counted, since evidence is fed in single and cited back double. */
    @Test void coverageCountsEveryCitationHoweverItIsBracketed() {
        var coverage = CitationAudit.coverage("Consecutive symbols are affected [Source: lecture-03.pdf; pages 40] and [[Source: seminar-notes.pdf; pages 5]].", EVIDENCE);
        assertThat(coverage.citations()).isEqualTo(2);
        assertThat(coverage.attested()).isEqualTo(2);
    }

    /** Nothing cited and nothing to cite is not a failure of either kind, so neither figure may report one. */
    @Test void anAnswerWithNothingToAttributeScoresNeitherWay() {
        var coverage = CitationAudit.coverage("Ask again with a topic.", EVIDENCE);
        assertThat(coverage.precision()).isEqualTo(1);
        assertThat(coverage.recall()).isEqualTo(1);
        assertThat(CitationAudit.coverage(null, EVIDENCE).citations()).isZero();
        assertThat(CitationAudit.coverage("A parity check appends redundant symbols to a message.", "").subjectClaims()).isZero();
    }
}
