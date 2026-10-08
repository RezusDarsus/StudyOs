package com.studyos.verify;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Per-page attribution: does the page a sentence names actually hold what the sentence attributes to it.
 *
 * <p>The pair of failures this exists for both pass every other check. A figure cited to page 5 that lives on
 * page 20 has a real reference and a retrieved figure, so the reference audit and the grounding audit are both
 * satisfied while the learner turns to a page that does not contain the number.
 *
 * <p>Every case here is written in a different subject, and two are in another language, because the check must
 * not know what it is reading. Vocabulary comes from the retrieved passages; nothing is matched against a list.
 */
class ProvenanceAuditTest {
    /** History. The figure is retrieved, but from a different page than the one the sentence sends you to. */
    @Test void reportsAFigureAttributedToThePageThatDoesNotHoldIt() {
        String evidence = """
                [Source: revolutions.pdf; pages 4-5]
                The estates general assembled at Versailles in the spring, after the financial crisis deepened.
                [Source: revolutions.pdf; pages 20-21]
                The convention abolished the monarchy in 1792 and proclaimed the republic that September.
                """;
        String answer = "The convention abolished the monarchy in 1792 and proclaimed the republic [[Source: revolutions.pdf; pages 4-5]].";
        var findings = ProvenanceAudit.findings(answer, evidence);
        assertThat(findings).hasSize(1);
        assertThat(findings.getFirst().kind()).isEqualTo("figure is on a page the claim does not cite");
        assertThat(findings.getFirst().detail()).contains("\"1792\"", "revolutions.pdf pages 20-21", "not on the cited revolutions.pdf pages 4-5");
        assertThat(findings.getFirst().reportable()).isTrue();
        assertThat(ProvenanceAudit.note(findings)).contains("**Page check**", "1792", "pages 20-21");
        // The same sentence's vocabulary also sits on pages 20-21, but the figure says so more precisely, and one
        // defect reported twice would inflate every count built on these findings.
        assertThat(findings).noneMatch(finding -> finding.kind().startsWith("claim traced"));
    }

    /** Chemistry. The cited page holds the figure, so there is nothing to report and nothing to warn about. */
    @Test void saysNothingWhenTheCitedPageHoldsTheFigure() {
        String evidence = """
                [Source: thermo.pdf; pages 7-8]
                The standard enthalpy of formation of water is -285.8 kJ per mole under standard conditions.
                [Source: thermo.pdf; pages 30]
                Entropy of vaporisation is tabulated for 118 substances in the appendix.
                """;
        String answer = "The standard enthalpy of formation of water is -285.8 kJ per mole [[Source: thermo.pdf; pages 7-8]].";
        assertThat(ProvenanceAudit.findings(answer, evidence)).isEmpty();
        assertThat(ProvenanceAudit.coverage(answer, evidence).tracedClaims()).isEqualTo(1);
        assertThat(ProvenanceAudit.coverage(answer, evidence).traceability()).isEqualTo(1);
    }

    /**
     * A figure nowhere in the evidence is the grounding audit's finding, not this one. Reporting it here would
     * tell the learner to use a page that does not exist.
     */
    @Test void leavesAFigureThatWasNeverRetrievedToTheGroundingCheck() {
        String evidence = """
                [Source: mechanics.pdf; pages 3]
                A pendulum's period depends on its length and the gravitational acceleration.
                [Source: mechanics.pdf; pages 9]
                Damping reduces amplitude exponentially with time.
                """;
        String answer = "A pendulum of that length has a period of 42 seconds [[Source: mechanics.pdf; pages 3]].";
        assertThat(ProvenanceAudit.findings(answer, evidence)).isEmpty();
        assertThat(GroundingAudit.findings(answer, evidence)).anyMatch(finding -> finding.kind().equals("figure not in the evidence"));
    }

    /** A sentence showing its arithmetic derived its numbers, and deriving them is the computation audit's business. */
    @Test void skipsClaimsThatShowTheirOwnArithmetic() {
        String evidence = """
                [Source: algebra.pdf; pages 2]
                A geometric series with ratio one half converges to twice its first term.
                [Source: algebra.pdf; pages 40]
                Worked example: the partial sums reach 1023 after ten terms.
                """;
        String answer = "Summing gives 512 + 256 + 255 = 1023 for the tenth partial sum [[Source: algebra.pdf; pages 2]].";
        assertThat(ProvenanceAudit.findings(answer, evidence)).noneMatch(finding -> finding.kind().startsWith("figure"));
    }

    /**
     * Linguistics, in German. The cited page shares one incidental long word with the claim while another
     * retrieved page uses nearly all of its vocabulary, so the attribution landed on the wrong page — decided
     * with no dictionary, no stopword list and no language detection.
     */
    @Test void reportsAClaimWhoseTermsBelongToAnotherPage() {
        String evidence = """
                [Source: sprachwissenschaft.pdf; pages 11]
                Die Silbenstruktur beschreibt Anlaut, Reim und Koda innerhalb einer Silbe.
                [Source: sprachwissenschaft.pdf; pages 60-61]
                Die Vokalharmonie verlangt Übereinstimmung der Vokalmerkmale innerhalb eines Wortes und wirkt morphologisch.
                """;
        String answer = "Die Vokalharmonie verlangt Übereinstimmung der Vokalmerkmale morphologisch innerhalb eines Wortes [[Source: sprachwissenschaft.pdf; pages 11]].";
        var findings = ProvenanceAudit.findings(answer, evidence);
        assertThat(findings).hasSize(1);
        assertThat(findings.getFirst().kind()).isEqualTo("claim traced to a page it does not cite");
        assertThat(findings.getFirst().detail()).contains("sprachwissenschaft.pdf pages 60-61", "distinctive terms");
        // A measurement, not a warning: an answer is supposed to paraphrase, so this never reaches the learner.
        assertThat(findings.getFirst().reportable()).isFalse();
        assertThat(ProvenanceAudit.note(findings)).isEmpty();
        assertThat(ProvenanceAudit.coverage(answer, evidence).tracedClaims()).isZero();
        assertThat(ProvenanceAudit.coverage(answer, evidence).checkedClaims()).isEqualTo(1);
    }

    /** One shared term is enough. Paraphrase is what answers are for, and it must never look like misattribution. */
    @Test void oneSharedTermIsEnoughToLeaveAParaphraseAlone() {
        String evidence = """
                [Source: ecology.pdf; pages 14]
                Keystone predation maintains diversity by suppressing competitively dominant prey species.
                [Source: ecology.pdf; pages 88]
                Nutrient cycling in estuaries depends on microbial decomposition rates.
                """;
        String answer = "Removing a keystone predator lets the dominant competitor take over, collapsing local variety [[Source: ecology.pdf; pages 14]].";
        assertThat(ProvenanceAudit.findings(answer, evidence)).isEmpty();
    }

    /** A cited document nobody retrieved is a fabricated reference, which the citation audit reports. */
    @Test void leavesAnUnretrievedSourceToTheCitationCheck() {
        String evidence = """
                [Source: statistics.pdf; pages 5]
                The central limit theorem describes the distribution of sample means for large samples.
                """;
        String answer = "The variance of the sample mean shrinks with the sample size [[Source: nowhere.pdf; pages 3]].";
        assertThat(ProvenanceAudit.findings(answer, evidence)).isEmpty();
        assertThat(CitationAudit.findings(answer, evidence)).anyMatch(finding -> finding.kind().equals("unretrieved source"));
    }

    /** A claim with nothing distinctive and no figure is unmeasurable, and must count as neither traced nor not. */
    @Test void aClaimWithNothingToCheckIsNotCountedAtAll() {
        String evidence = """
                [Source: notes.pdf; pages 2]
                Der Satz gilt auch dann, wenn die Folge nicht monoton ist.
                [Source: notes.pdf; pages 30]
                Ein Gegenbeispiel findet sich im Anhang.
                """;
        String answer = "This is the case here as well, so it does hold [[Source: notes.pdf; pages 2]].";
        var coverage = ProvenanceAudit.coverage(answer, evidence);
        assertThat(coverage.checkedClaims()).isZero();
        assertThat(coverage.tracedClaims()).isZero();
        assertThat(coverage.traceability()).isEqualTo(1);
    }

    /** Counting, not averaging: a harness pools these across turns, so both halves have to be exact. */
    @Test void countsCheckedAndTracedClaimsSeparately() {
        String evidence = """
                [Source: networks.pdf; pages 3-4]
                A cyclic redundancy check appends a remainder computed over the message polynomial.
                [Source: networks.pdf; pages 50]
                The standard generator polynomial for Ethernet is 32 bits wide and detects all bursts up to 32 bits.
                """;
        String answer = """
                A cyclic redundancy check appends a remainder computed over the message polynomial [[Source: networks.pdf; pages 3-4]].
                The Ethernet generator polynomial is 32 bits wide [[Source: networks.pdf; pages 3-4]].
                """;
        var coverage = ProvenanceAudit.coverage(answer, evidence);
        assertThat(coverage.checkedClaims()).isEqualTo(2);
        assertThat(coverage.tracedClaims()).isEqualTo(1);
        assertThat(coverage.misplacedFigures()).isEqualTo(1);
        assertThat(coverage.traceability()).isEqualTo(.5);
    }

    /** A sentence citing two pages is checked against both, so summarising across them is not a defect. */
    @Test void aMultiCitationSentenceIsCheckedAgainstEveryPageItNames() {
        String evidence = """
                [Source: os.pdf; pages 6]
                Paging divides the address space into fixed-size frames.
                [Source: os.pdf; pages 41]
                A translation lookaside buffer caches 64 recent page-table entries.
                """;
        String answer = "Paging uses fixed-size frames and the lookaside buffer caches 64 recent entries [[Source: os.pdf; pages 6]] [[Source: os.pdf; pages 41]].";
        assertThat(ProvenanceAudit.findings(answer, evidence)).isEmpty();
        assertThat(ProvenanceAudit.coverage(answer, evidence).tracedClaims()).isEqualTo(1);
    }

    /** A cited range overlapping a retrieved one is the same pages; page ranges are not string-matched. */
    @Test void anOverlappingPageRangeCountsAsTheCitedPage() {
        String evidence = """
                [Source: law.pdf; pages 12-18]
                Consideration must move from the promisee for a simple contract to be enforceable.
                """;
        String answer = "Consideration must move from the promisee for a simple contract to be enforceable [[Source: law.pdf; pages 14]].";
        assertThat(ProvenanceAudit.findings(answer, evidence)).isEmpty();
        assertThat(ProvenanceAudit.coverage(answer, evidence).tracedClaims()).isEqualTo(1);
    }

    @Test void anAnswerWithNoCitationsOrNoEvidenceHasNothingToPair() {
        String evidence = "[Source: anything.pdf; pages 1]\nSome retrieved text about a subject.\n";
        assertThat(ProvenanceAudit.findings("A claim with no reference attached at all.", evidence)).isEmpty();
        assertThat(ProvenanceAudit.findings("A claim [[Source: anything.pdf; pages 1]].", null)).isEmpty();
        assertThat(ProvenanceAudit.findings(null, evidence)).isEmpty();
        assertThat(ProvenanceAudit.coverage("", evidence).checkedClaims()).isZero();
        assertThat(ProvenanceAudit.note(java.util.List.of())).isEmpty();
    }

    /** Two turns of the same shape in unrelated subjects must produce the same verdict, or the check has a bias. */
    @Test void theSameShapeOfErrorIsFoundInAnySubject() {
        String music = """
                [Source: harmony.pdf; pages 8]
                A perfect cadence resolves from the dominant to the tonic chord.
                [Source: harmony.pdf; pages 44]
                The chorale collection contains 371 harmonisations attributed to Bach.
                """;
        String biology = """
                [Source: genetics.pdf; pages 8]
                Meiosis halves the chromosome number through two successive divisions.
                [Source: genetics.pdf; pages 44]
                The reference assembly annotates 371 pseudogenes on this chromosome.
                """;
        var musicFindings = ProvenanceAudit.findings("The collection contains 371 harmonisations [[Source: harmony.pdf; pages 8]].", music);
        var biologyFindings = ProvenanceAudit.findings("The assembly annotates 371 pseudogenes [[Source: genetics.pdf; pages 8]].", biology);
        assertThat(musicFindings).hasSameSizeAs(biologyFindings);
        assertThat(musicFindings.getFirst().kind()).isEqualTo(biologyFindings.getFirst().kind());
    }
}
