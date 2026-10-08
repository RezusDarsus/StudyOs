package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.ai.ProviderCallTelemetry;
import com.studyos.verify.CitationAudit;
import com.studyos.verify.LearnerStateAudit;
import com.studyos.verify.ProvenanceAudit;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * What a reply reports about itself, checked at the seam where the audits meet the telemetry record.
 *
 * <p>The audits are tested in their own package against their own findings. What is tested here is the thing that
 * can go wrong only in the joining: a figure the page check found being counted as a figure the grounding check
 * found, a turn that was never examined reporting the same numbers as a turn that came out clean, or the
 * learner-facing half of a finding list being pooled with the half that is only a measurement.
 *
 * <p>Every fixture is in a different subject, since the telemetry has no business knowing which one it is reading.
 */
class ReplyTelemetryTest {
    private static final String PHARMACOLOGY = """
            [Source: pharmacology.pdf; pages 9-10]
            First-pass metabolism reduces the fraction of an oral dose that reaches systemic circulation.
            [Source: pharmacology.pdf; pages 64]
            The oral bioavailability of propranolol is about 26 percent in healthy adults.
            """;

    private static ChatService.ReplyTelemetry telemetry(String answer, String evidence) {
        return ChatService.ReplyTelemetry.of(ProviderCallTelemetry.Snapshot.empty(), 1_200, false, false, 0, 0, List.of(),
                evidence == null ? null : CitationAudit.coverage(answer, evidence),
                evidence == null ? List.of() : ProvenanceAudit.findings(answer, evidence),
                evidence == null ? null : ProvenanceAudit.coverage(answer, evidence),
                List.of(), null, List.of(), answer, false, null);
    }

    /**
     * The distinction the whole {@code -1} convention exists for. A generated-exercise turn cites a separately
     * resolved scope and is never audited against a retrieval block, so reporting zero misattributed figures for
     * it would let an unexamined turn count towards page-perfect attribution in any run that sums these.
     */
    @Test void aTurnWithNothingToCiteReportsPageAttributionAsUnmeasuredRatherThanClean() {
        var unchecked = telemetry("Here are three exercises on renal clearance.", null);
        assertThat(unchecked.misattributedFigures()).isEqualTo(-1);
        assertThat(unchecked.claimsTracedElsewhere()).isEqualTo(-1);
        assertThat(unchecked.pageCheckedClaims()).isEqualTo(-1);
        assertThat(unchecked.pageTracedClaims()).isEqualTo(-1);
        assertThat(unchecked.pageAttributionChecked()).isFalse();
    }

    /** Audited and clean is a different reading from never audited, and zero is how it says so. */
    @Test void anAuditedTurnThatAttributedEverythingCorrectlyReportsZeroes() {
        var clean = telemetry("The oral bioavailability of propranolol is about 26 percent in healthy adults [[Source: pharmacology.pdf; pages 64]].", PHARMACOLOGY);
        assertThat(clean.misattributedFigures()).isZero();
        assertThat(clean.claimsTracedElsewhere()).isZero();
        assertThat(clean.pageCheckedClaims()).isEqualTo(1);
        assertThat(clean.pageTracedClaims()).isEqualTo(1);
        assertThat(clean.pageAttributionChecked()).isTrue();
        assertThat(clean.pageTraceability()).isEqualTo(1);
    }

    /** A real misattribution has to arrive as a count, not as a note the harness would have to parse back out. */
    @Test void aFigureCitedToTheWrongPageIsCountedAndLowersTraceability() {
        var wrongPage = telemetry("The oral bioavailability of propranolol is about 26 percent in healthy adults [[Source: pharmacology.pdf; pages 9-10]].", PHARMACOLOGY);
        assertThat(wrongPage.misattributedFigures()).isEqualTo(1);
        assertThat(wrongPage.pageCheckedClaims()).isEqualTo(1);
        assertThat(wrongPage.pageTracedClaims()).isZero();
        assertThat(wrongPage.pageTraceability()).isZero();
    }

    /**
     * The two halves are counted apart because they are used apart: one is printed for the learner, the other only
     * measured. Pooling them would make an answer that paraphrased its own source look like one that sent the
     * reader to a page missing the number.
     */
    @Test void theLearnerFacingAndMeasurementOnlyFindingsAreCountedSeparately() {
        String archaeology = """
                [Source: dig-report.pdf; pages 3]
                The trench was opened along the northern edge of the enclosure.
                [Source: dig-report.pdf; pages 51-52]
                Radiocarbon determinations place the deposition sequence within the earlier neolithic occupation horizon.
                """;
        String answer = "Radiocarbon determinations place the deposition sequence within the earlier neolithic occupation horizon [[Source: dig-report.pdf; pages 3]].";
        var telemetry = telemetry(answer, archaeology);
        assertThat(telemetry.misattributedFigures()).isZero();
        assertThat(telemetry.claimsTracedElsewhere()).isEqualTo(1);
        assertThat(telemetry.pageTracedClaims()).isZero();
        assertThat(telemetry.pageCheckedClaims()).isEqualTo(1);
    }

    /**
     * A turn whose citations were checked but held nothing checkable scores one, the same as a turn with nothing
     * wrong. That is why the ratio is never read without the flag: it says "no evidence of misattribution", which
     * is not the same claim as "attribution verified". The sentence below carries no figure and no word long
     * enough to be a term of any subject, so there is nothing a structural check could weigh.
     */
    @Test void anAuditedTurnWithNoCheckableClaimReadsAsCheckedAndUnproblematic() {
        var thin = telemetry("It is the same in this case, so the rule does hold [[Source: pharmacology.pdf; pages 9-10]].", PHARMACOLOGY);
        assertThat(thin.pageAttributionChecked()).isTrue();
        assertThat(thin.pageCheckedClaims()).isZero();
        assertThat(thin.pageTraceability()).isEqualTo(1);
    }

    /** The other audits' figures must not move when the page check reports something, or one defect counts twice. */
    @Test void thePageCheckDoesNotDisturbTheCitationOrLearnerFigures() {
        var wrongPage = telemetry("The oral bioavailability of propranolol is about 26 percent in healthy adults [[Source: pharmacology.pdf; pages 9-10]].", PHARMACOLOGY);
        assertThat(wrongPage.citations()).isEqualTo(1);
        assertThat(wrongPage.attestedCitations()).isEqualTo(1);
        assertThat(wrongPage.citationPrecision()).isEqualTo(1);
        assertThat(wrongPage.ungroundedClaims()).isZero();
        assertThat(wrongPage.learnerClaims()).isZero();
        assertThat(wrongPage.questionsAsked()).isEqualTo(-1);
        assertThat(wrongPage.predictionVerifierCalls()).isEqualTo(-1);
    }

    /** Learner evidence is still audited on the same turn, and its counts stay in their own fields. */
    @Test void learnerFiguresAreReportedBesideThePageFiguresNotFoldedIntoThem() {
        String answer = "Your mastery of first-pass metabolism is 41% [[Source: pharmacology.pdf; pages 9-10]].";
        var learnerFindings = LearnerStateAudit.findings(answer, "");
        var telemetry = ChatService.ReplyTelemetry.of(ProviderCallTelemetry.Snapshot.empty(), 900, false, false, 0,
                CitationAudit.findings(answer, PHARMACOLOGY).size(), List.of(), CitationAudit.coverage(answer, PHARMACOLOGY),
                ProvenanceAudit.findings(answer, PHARMACOLOGY), ProvenanceAudit.coverage(answer, PHARMACOLOGY),
                learnerFindings, LearnerStateAudit.coverage(answer, ""), List.of(), answer, false, null);
        assertThat(telemetry.unanchoredLearnerClaims()).isEqualTo(1);
        assertThat(telemetry.learnerFiguresNotRecorded()).isEqualTo(1);
        assertThat(telemetry.learnerRecall()).isZero();
        // A sentence about the learner is not a claim about the material, so the page check has nothing to weigh in on.
        assertThat(telemetry.pageAttributionChecked()).isTrue();
        assertThat(telemetry.misattributedFigures()).isZero();
    }
}
