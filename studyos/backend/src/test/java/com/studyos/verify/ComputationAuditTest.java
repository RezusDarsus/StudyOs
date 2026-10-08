package com.studyos.verify;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The cases here are the shapes the benchmark actually got wrong, plus the ones a checker must leave alone.
 * The second group matters as much as the first: a checker that flags a deliberate counter-example, or reads
 * binary as base ten, would replace one kind of wrong answer with another.
 */
class ComputationAuditTest {
    @Test void catchesABitCountThatDoesNotMatchTheLiteralItDescribes() {
        var findings = ComputationAudit.findings("The generator 110101 has three 1-bits, so the polynomial has degree 5.");
        assertThat(findings).hasSize(1);
        assertThat(findings.get(0).kind()).isEqualTo("bit count");
        assertThat(findings.get(0).claimed()).isEqualTo("3");
        assertThat(findings.get(0).computed()).contains("4");
    }

    @Test void readsACountWrittenAsADigitOrAsAWord() {
        assertThat(ComputationAudit.findings("1011 contains 2 ones.")).hasSize(1);
        assertThat(ComputationAudit.findings("1011 contains three ones.")).isEmpty();
        assertThat(ComputationAudit.findings("The number of set bits in 11110000 is five.")).hasSize(1);
        assertThat(ComputationAudit.findings("The Hamming weight of 11110000 is four.")).isEmpty();
    }

    @Test void catchesAMod2RemainderThatWasNotWhatDivisionGives() {
        var findings = ComputationAudit.findings("Working mod 2, the remainder of 11010110110000 divided by 10011 is 00101.");
        assertThat(findings).hasSize(1);
        assertThat(findings.get(0).kind()).isEqualTo("mod-2 remainder");
        assertThat(findings.get(0).computed()).isEqualTo(Gf2Polynomial.remainder("11010110110000", "10011").replaceFirst("^0+(?=.)", ""));
    }

    @Test void acceptsACorrectMod2RemainderWhateverItsWidth() {
        String correct = Gf2Polynomial.remainder("11010110110000", "10011");
        assertThat(ComputationAudit.findings("Using XOR, 11010110110000 divided by 10011 leaves remainder " + correct + ".")).isEmpty();
        assertThat(ComputationAudit.findings("Using XOR, 11010110110000 divided by 10011 leaves remainder " + correct.replaceFirst("^0+(?=.)", "") + ".")).isEmpty();
    }

    /** Every step of a long division is an exclusive-or, which makes each one independently checkable. */
    @Test void checksEachExclusiveOrStepOfADerivation() {
        assertThat(ComputationAudit.findings("Step 1: 1101 XOR 1011 = 0110. Step 2: 1100 XOR 1010 = 0111.")).hasSize(1);
        assertThat(ComputationAudit.findings("Step 2: 1100 ⊕ 1010 = 0110.")).isEmpty();
    }

    @Test void catchesOrdinaryArithmeticInAnySubject() {
        assertThat(ComputationAudit.findings("Titrating 25 mL needs 3 + 4 = 8 aliquots.")).hasSize(1);
        assertThat(ComputationAudit.findings("So 144 / 12 = 11 moles remain.")).hasSize(1);
        assertThat(ComputationAudit.findings("With 17 mod 5 = 2 left over.")).isEmpty();
        assertThat(ComputationAudit.findings("Since 2^10 = 1024 states are reachable.")).isEmpty();
    }

    /** Base is never guessed: an expression that is valid binary and valid decimal is left alone. */
    @Test void doesNotDecideWhichBaseAnAmbiguousExpressionWasWrittenIn() {
        assertThat(ComputationAudit.findings("Adding gives 10 + 11 = 101.")).isEmpty();
        assertThat(ComputationAudit.findings("In binary arithmetic 1101 + 1011 = 11000.")).isEmpty();
        assertThat(ComputationAudit.findings("Here 1101 ^ 1011 = 0110 as usual.")).isEmpty();
    }

    /** A wrong equation the answer is pointing at is the answer working correctly. */
    @Test void leavesDeliberateCounterExamplesAlone() {
        assertThat(ComputationAudit.findings("A common mistake is to write 3 + 4 = 8.")).isEmpty();
        assertThat(ComputationAudit.findings("It is incorrect to say 110101 has three 1-bits.")).isEmpty();
        assertThat(ComputationAudit.findings("Note that 3 + 4 ≠ 8 here.")).isEmpty();
        assertThat(ComputationAudit.findings("Students often think 1011 contains 2 ones, which is the wrong count.")).isEmpty();
    }

    @Test void saysNothingWhenThereIsNothingToCheck() {
        assertThat(ComputationAudit.findings(null)).isEmpty();
        assertThat(ComputationAudit.findings("   ")).isEmpty();
        assertThat(ComputationAudit.findings("Cyclic codes detect all burst errors shorter than the check length.")).isEmpty();
        assertThat(ComputationAudit.note(java.util.List.of())).isEmpty();
    }

    @Test void theNoteNamesTheClaimAndWhatArithmeticGivesInstead() {
        String note = ComputationAudit.note(ComputationAudit.findings("The generator 110101 has three 1-bits."));
        assertThat(note).contains("Computation check").contains("bit count").contains("110101 has three 1-bits").contains("not 3");
    }

    /**
     * The reason the arithmetic is evaluated rather than pattern-matched. A mistake in a derivation is the
     * common case — the operands are themselves computed — and no rule for one operator between two numbers
     * can reach it.
     */
    @Test void recomputesAWholeDerivationAndNotJustALoneSum() {
        var findings = ComputationAudit.findings("So (15 - 1) / 2 = 8 codewords are correctable.");
        assertThat(findings).hasSize(1);
        assertThat(findings.get(0).kind()).isEqualTo("arithmetic");
        assertThat(findings.get(0).claim()).isEqualTo("(15 - 1) / 2 = 8");
        assertThat(findings.get(0).computed()).isEqualTo("7");
        assertThat(ComputationAudit.findings("So (15 - 1) / 2 = 7 codewords are correctable.")).isEmpty();
    }

    @Test void honoursPrecedenceAndNestingAsWritten() {
        assertThat(ComputationAudit.findings("The rate is 2 * (3 + 4) = 15 per second.")).hasSize(1);
        assertThat(ComputationAudit.findings("The rate is 2 * (3 + 4) = 14 per second.")).isEmpty();
        assertThat(ComputationAudit.findings("Each of 2 + 3 * 4 = 20 slots is used.")).hasSize(1);
        assertThat(ComputationAudit.findings("Each of 2 + 3 * 4 = 14 slots is used.")).isEmpty();
    }

    /** Two mistakes in one clause are two findings, because a reader fixing one still has the other. */
    @Test void reportsEveryContradictedStepInAClause() {
        var findings = ComputationAudit.findings("First 6 * 7 = 43, and then 43 - 1 = 41 remain");
        assertThat(findings).hasSize(2);
        assertThat(findings).extracting(ComputationAudit.Finding::computed).containsExactly("42", "42");
    }

    /**
     * A rounded quotient is what a person writes. Reporting 0.33 for a third as contradicted would teach a
     * reader that the check cries wolf, and then the real findings go unread too.
     */
    @Test void acceptsAResultRoundedToThePlacesTheAnswerWrote() {
        assertThat(ComputationAudit.findings("That averages 10 / 3 = 3.33 per node.")).isEmpty();
        assertThat(ComputationAudit.findings("That averages 10 / 3 = 3.3 per node.")).isEmpty();
        assertThat(ComputationAudit.findings("That averages 10 / 3 = 3 per node.")).isEmpty();
        assertThat(ComputationAudit.findings("That averages 10 / 3 = 3.5 per node.")).hasSize(1);
        assertThat(ComputationAudit.findings("Exactly 0.1 + 0.2 = 0.3 of the mass.")).isEmpty();
    }

    /**
     * An equation with an unknown in it is not arithmetic, and the fragment before the equals sign is not the
     * claim. "2x + 3 = 7" is true; an audit that read the tail as a signed three would announce the answer had
     * claimed 3 was 7, which is a checker inventing an error where the answer was right.
     */
    @Test void leavesEquationsWithUnknownsUndecided() {
        assertThat(ComputationAudit.findings("Solving 2x + 3 = 7 gives x = 2.")).isEmpty();
        assertThat(ComputationAudit.findings("The generator x^3 + x + 1 = 1011 in bit form.")).isEmpty();
        assertThat(ComputationAudit.findings("Rearranging, n - k + 1 = 6 for this code.")).isEmpty();
    }

    /** Restating a result is not a second claim, and a chain gives the audit no left side it can trust. */
    @Test void doesNotReadARestatedResultAsAnotherSum() {
        assertThat(ComputationAudit.findings("So 3 + 4 = 7 = 8 overall.")).hasSize(0);
        assertThat(ComputationAudit.findings("So 3 + 4 = 8 = 8 overall.")).hasSize(1);
    }

    /**
     * The generality claim, made checkable. Nothing above this point mentions a subject, but the shapes that were
     * tested came from one course, and a checker is only as general as the notations it can read. These are the
     * same arithmetic written the way other subjects write it.
     */
    @Test void checksTheSameArithmeticInSubjectsThatAreNotThisOne() {
        assertThat(ComputationAudit.findings("Titrating to the endpoint took 25.0 mL + 12.5 mL = 37.5 mL of base.")).isEmpty();
        var chemistry = ComputationAudit.findings("Titrating to the endpoint took 25.0 mL + 12.5 mL = 36.5 mL of base.");
        assertThat(chemistry).hasSize(1);
        assertThat(chemistry.get(0).computed()).isEqualTo("37.5 mL");

        var finance = ComputationAudit.findings("The deposit earns 1200 * 0.04 = 46 euros in the first year.");
        assertThat(finance).hasSize(1);
        assertThat(finance.get(0).computed()).isEqualTo("48");

        var physics = ComputationAudit.findings("Over that stretch the change is 90 km - 35 km = 65 km.");
        assertThat(physics).hasSize(1);
        assertThat(physics.get(0).computed()).isEqualTo("55 km");

        var statistics = ComputationAudit.findings("The mean of the four scores is (12 + 15 + 18 + 19) / 4 = 17.");
        assertThat(statistics).hasSize(1);
        assertThat(statistics.get(0).computed()).isEqualTo("16");
    }

    /**
     * Collecting like terms is adding like quantities, and the unit rule gets both for one price. The unknown
     * cases beside them are the reason the rule demands a unit on <em>every</em> quantity: a run that mixes a
     * quantity with a bare number is an equation to solve, not a sum to check.
     */
    @Test void addsLikeTermsAndRefusesToTouchAnEquationWithAnUnknown() {
        assertThat(ComputationAudit.findings("Collecting terms, 2x + 3x = 5x.")).isEmpty();
        assertThat(ComputationAudit.findings("Collecting terms, 2x + 3x = 6x.")).hasSize(1);
        assertThat(ComputationAudit.findings("From 2x + 3 = 7x we get x = 0.6.")).isEmpty();
        assertThat(ComputationAudit.findings("Adding 5 g to 300 mL = 305 anything is not a quantity.")).isEmpty();
        assertThat(ComputationAudit.findings("The reaction produced 5 g and we still need 3 g more = 9 g total.")).isEmpty();
    }

    /**
     * A proportion of a quantity, which is how most subjects write the calculation this course writes as a
     * remainder — percent yield, interest, a share of a cohort, a mark out of a total.
     */
    @Test void checksAProportionOfAQuantityWhicheverWayItIsWritten() {
        assertThat(ComputationAudit.findings("We need 50% of 80 = 40 samples.")).isEmpty();
        var wrong = ComputationAudit.findings("We need 50% of 80 = 45 samples.");
        assertThat(wrong).hasSize(1);
        assertThat(wrong.get(0).kind()).isEqualTo("percentage");
        assertThat(wrong.get(0).computed()).isEqualTo("40");

        assertThat(ComputationAudit.findings("The yield is 15% of 240 g, which is 36 g.")).isEmpty();
        assertThat(ComputationAudit.findings("The yield is 15% of 240 g, which is 30 g.")).hasSize(1);
        assertThat(ComputationAudit.findings("So 36 represents 15 percent of 240 marks.")).isEmpty();
        assertThat(ComputationAudit.findings("So 30 represents 15 percent of 240 marks.")).hasSize(1);
        assertThat(ComputationAudit.findings("A third of the cohort, 33.33% of 90, is 30 students.")).isEmpty();
    }

    /** A percentage the answer never resolves to a figure is not a claim about a figure. */
    @Test void leavesAProportionWithNothingToCompareItToAlone() {
        assertThat(ComputationAudit.findings("Aim for 80% of the past-paper questions before Friday.")).isEmpty();
        assertThat(ComputationAudit.findings("Recall sits at 40% of what it was, which is why review is due.")).isEmpty();
        assertThat(ComputationAudit.findings("A common error is writing 50% of 80 = 45 instead of 40.")).isEmpty();
    }
}
