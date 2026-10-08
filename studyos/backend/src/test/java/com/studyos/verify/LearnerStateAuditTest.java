package com.studyos.verify;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The cases here are the three learner-memory failures the benchmark produced, plus the answers a checker must
 * leave alone. The second group is the harder constraint: an audit that demanded evidence for "nothing has been
 * assessed yet" would be pushing the system to invent a measurement, which is the defect itself.
 */
class LearnerStateAuditTest {
    /** Shaped exactly as the evidence block is rendered, heading included, so the heading is tested too. */
    private static final String RECORD = """
            Recorded learner evidence — the only record of this learner's own work. Every claim about what they know must carry the [Learner: tag] of a line below.
            Graded attempts, most recent first:
            [Learner: a3f19c2b] 2026-08-14 · Cyclic redundancy check · scored 40% · INCORRECT · error REMAINDER_MISCOUNT · learner wrote: "the remainder is 00101"
            [Learner: 77e0b415] 2026-08-12 · Sliding window · scored 90% · CORRECT · learner wrote: "the window is four frames"
            Measured topics (each figure is the average over the attempts above):
            [Learner: a3f19c2b] Cyclic redundancy check · mastery 40% · 2 recorded attempts · last assessed 2026-08-14
            """;

    private static final String NOTHING_RECORDED = """
            Recorded learner evidence — the only record of this learner's own work. Every claim about what they know must carry the [Learner: tag] of a line below.
            (no recorded attempts, scores or misconceptions for this learner)
            """;

    @Test void aClaimCarryingARecordedHandleIsAccepted() {
        assertThat(LearnerStateAudit.findings("Your last attempt on the cyclic redundancy check scored 40% [Learner: a3f19c2b].", RECORD)).isEmpty();
    }

    /**
     * The measured failure: told there was no personal evidence, the next answer named topics the learner
     * "demonstrates strong understanding" of, taken from course retrieval rather than from anything they did.
     */
    @Test void aClaimAboutTheLearnerWithNothingBehindItIsReported() {
        var findings = LearnerStateAudit.findings("You demonstrate strong understanding of leader election and spanning trees.", RECORD);
        assertThat(findings).hasSize(1);
        assertThat(findings.get(0).kind()).isEqualTo("learner claim with nothing recorded behind it");
        assertThat(findings.get(0).detail()).contains("cites none of them");
    }

    /** Nothing recorded is a different explanation from nothing cited, and the reader is owed the right one. */
    @Test void anEmptyRecordSaysThatNothingWasEverMeasured() {
        var findings = LearnerStateAudit.findings("Your strongest topics are the cyclic redundancy check and sliding windows.", NOTHING_RECORDED);
        assertThat(findings).hasSize(1);
        assertThat(findings.get(0).detail()).contains("no attempt, score or misconception is on record");
    }

    /**
     * The catastrophic case: the system's own wrong answer came back one turn later as the learner's recent
     * mistake. It needs no rule of its own — the tutor's earlier prose was never issued a handle.
     */
    @Test void theTutorsOwnEarlierMistakeCannotBecomeTheLearners() {
        var findings = LearnerStateAudit.findings("Your recent mistake was saying that 110101 has three 1-bits.", RECORD);
        assertThat(findings).hasSize(1);
        assertThat(findings.get(0).claim()).contains("110101");
        assertThat(LearnerStateAudit.findings("Your recent mistake was writing the remainder as 00101 [Learner: a3f19c2b].", RECORD)).isEmpty();
    }

    @Test void aHandleTheRecordDoesNotContainIsReported() {
        var findings = LearnerStateAudit.findings("Your weakest topic is flow control [Learner: deadbeef].", RECORD);
        assertThat(findings).hasSize(1);
        assertThat(findings.get(0).kind()).isEqualTo("unrecorded learner reference");
        assertThat(findings.get(0).detail()).contains("a3f19c2b");
    }

    /** Exact percentages nobody measured were the most persuasive of the failures, and the easiest to settle. */
    @Test void aFigureTheRecordDoesNotStateIsReported() {
        var findings = LearnerStateAudit.findings("Your mastery in cyclic redundancy check is 42% [Learner: a3f19c2b].", RECORD);
        assertThat(findings).hasSize(1);
        assertThat(findings.get(0).kind()).isEqualTo("figure not in the learner's record");
        assertThat(findings.get(0).detail()).contains("40");
        assertThat(LearnerStateAudit.findings("Your mastery in cyclic redundancy check is 40% [Learner: a3f19c2b].", RECORD)).isEmpty();
    }

    /** A figure the answer is aiming at is not a figure it is reading off. */
    @Test void aTargetIsNotAReading() {
        assertThat(LearnerStateAudit.findings("Your mastery should reach 80% before the exam [Learner: a3f19c2b].", RECORD)).isEmpty();
        assertThat(LearnerStateAudit.findings("Your mastery is at least 30% by now [Learner: a3f19c2b].", RECORD)).isEmpty();
    }

    /** Before anything has been assessed, saying so is the only correct answer available. */
    @Test void reportingThatNothingIsRecordedNeedsNoEvidence() {
        assertThat(LearnerStateAudit.findings("You have not been assessed on sliding windows yet.", NOTHING_RECORDED)).isEmpty();
        assertThat(LearnerStateAudit.findings("There is no recorded evidence of your performance on this topic.", NOTHING_RECORDED)).isEmpty();
        assertThat(LearnerStateAudit.findings("Nothing has been recorded for you yet, so your weakest topic cannot be determined.", NOTHING_RECORDED)).isEmpty();
    }

    @Test void statementsAboutTheSubjectAreNotClaimsAboutTheLearner() {
        assertThat(LearnerStateAudit.findings("A cyclic code detects every burst error shorter than the check length.", NOTHING_RECORDED)).isEmpty();
        assertThat(LearnerStateAudit.findings("The remainder of the division is what gets appended to the frame.", RECORD)).isEmpty();
    }

    @Test void saysNothingWhenThereIsNothingToCheck() {
        assertThat(LearnerStateAudit.findings(null, RECORD)).isEmpty();
        assertThat(LearnerStateAudit.findings("   ", RECORD)).isEmpty();
        assertThat(LearnerStateAudit.note(java.util.List.of())).isEmpty();
    }

    /** A repeated claim is one finding: the same warning twice reads as two problems. */
    @Test void aRepeatedClaimIsReportedOnce() {
        var findings = LearnerStateAudit.findings("You demonstrate strong understanding of routing. You demonstrate strong understanding of routing.", RECORD);
        assertThat(findings).hasSize(1);
    }

    @Test void theNoteNamesTheClaimAndWhyItIsUnverified() {
        String note = LearnerStateAudit.note(LearnerStateAudit.findings("Your weakest topic is flow control.", NOTHING_RECORDED));
        assertThat(note).contains("Learner-record check").contains("flow control").contains("no attempt, score or misconception is on record");
    }

    /** Anchoring and accuracy fail in opposite directions, so one number cannot stand for both. */
    @Test void coverageMeasuresAnchoringAndAccuracySeparately() {
        var accurate = LearnerStateAudit.coverage("Your weakest topic is the cyclic redundancy check [Learner: a3f19c2b]. Your strongest is sliding windows.", RECORD);
        assertThat(accurate.learnerClaims()).isEqualTo(2);
        assertThat(accurate.anchoredClaims()).isEqualTo(1);
        assertThat(accurate.recall()).isEqualTo(.5);
        assertThat(accurate.precision()).isEqualTo(1);

        var anchored = LearnerStateAudit.coverage("Your weakest topic is the cyclic redundancy check [Learner: a3f19c2b]. Your strongest is sliding windows [Learner: deadbeef].", RECORD);
        assertThat(anchored.recall()).isEqualTo(1);
        assertThat(anchored.references()).isEqualTo(2);
        assertThat(anchored.recordedReferences()).isEqualTo(1);
        assertThat(anchored.precision()).isEqualTo(.5);
    }

    @Test void nothingToAttributeScoresNeitherWay() {
        var empty = LearnerStateAudit.coverage("A cyclic code detects burst errors shorter than the check length.", RECORD);
        assertThat(empty.learnerClaims()).isZero();
        assertThat(empty.precision()).isEqualTo(1);
        assertThat(empty.recall()).isEqualTo(1);
        assertThat(LearnerStateAudit.coverage(null, RECORD).learnerClaims()).isZero();
    }

    /**
     * The same audit on a record from another subject entirely. Nothing here knows what a topic is about: a claim
     * about the learner is recognised from how it addresses them and from whether it carries a handle the record
     * issued, and both of those are the same in every course. This is the test that fails if anyone ever tries to
     * make the check smarter by teaching it vocabulary.
     */
    @Test void worksTheSameWayForASubjectItHasNeverSeen() {
        String pharmacology = """
                Recorded learner evidence — the only record of this learner's own work. Every claim about what they know must carry the [Learner: tag] of a line below.
                Graded attempts, most recent first:
                [Learner: 5c1d0a92] 2026-08-18 · Beta-blocker contraindications · scored 55% · INCORRECT · learner wrote: "propranolol is safe in asthma"
                Measured topics (each figure is the average over the attempts above):
                [Learner: 5c1d0a92] Beta-blocker contraindications · mastery 55% · 3 recorded attempts · last assessed 2026-08-18
                """;
        assertThat(LearnerStateAudit.findings("Your mastery of beta-blocker contraindications is 55% [Learner: 5c1d0a92].", pharmacology)).isEmpty();
        assertThat(LearnerStateAudit.findings("Your weakest area is loop diuretics.", pharmacology)).hasSize(1);
        assertThat(LearnerStateAudit.findings("Your mastery of beta-blocker contraindications is 70% [Learner: 5c1d0a92].", pharmacology))
                .singleElement().extracting(LearnerStateAudit.Finding::kind).isEqualTo("figure not in the learner's record");
        assertThat(LearnerStateAudit.findings("A non-selective beta-blocker can precipitate bronchospasm.", pharmacology)).isEmpty();
    }
}
