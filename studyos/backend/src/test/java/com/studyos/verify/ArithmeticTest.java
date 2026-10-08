package com.studyos.verify;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The evaluator exists so a derivation can be recomputed instead of trusted, which means the cases that matter
 * most are the ones where it must refuse to answer: an undecidable step reported as a contradiction would be a
 * checker inventing errors.
 */
class ArithmeticTest {
    private static String value(String expression) {
        Arithmetic.Value result = Arithmetic.evaluate(Arithmetic.tokens(expression));
        return result == null ? null : result.toString();
    }

    @Test void computesTheOperationsAnAnswerWrites() {
        assertThat(value("3 + 4")).isEqualTo("7");
        assertThat(value("144 / 12")).isEqualTo("12");
        assertThat(value("17 mod 5")).isEqualTo("2");
        assertThat(value("2^10")).isEqualTo("1024");
        assertThat(value("2 ** 8")).isEqualTo("256");
        assertThat(value("6 × 7")).isEqualTo("42");
        assertThat(value("100 ÷ 8")).isEqualTo("12.5");
    }

    @Test void respectsPrecedenceAndParentheses() {
        assertThat(value("2 + 3 * 4")).isEqualTo("14");
        assertThat(value("(2 + 3) * 4")).isEqualTo("20");
        assertThat(value("(15 - 1) / 2")).isEqualTo("7");
        assertThat(value("2 * (3 + (4 - 1))")).isEqualTo("12");
        assertThat(value("-3 + 10")).isEqualTo("7");
    }

    /** Right-associative, because that is what the notation means, whatever a left fold would give. */
    @Test void powersAssociateToTheRight() {
        assertThat(value("2^3^2")).isEqualTo("512");
        assertThat(value("2^-2")).isEqualTo("0.25");
    }

    /**
     * Exact rationals, not doubles. A checker that decided 0.1 + 0.2 was not 0.3 would be reporting the
     * representation of binary floating point as a mistake in the answer.
     */
    @Test void decimalsAreExact() {
        assertThat(value("0.1 + 0.2")).isEqualTo("0.3");
        assertThat(value("1 / 3")).isEqualTo("1/3");
        assertThat(value("0.5 * 0.5")).isEqualTo("0.25");
        assertThat(value("2.5 + 2.5")).isEqualTo("5");
    }

    @Test void refusesWhatItCannotDecide() {
        assertThat(value("1 / 0")).isNull();
        assertThat(value("7 mod 0")).isNull();
        assertThat(value("10 mod 2.5")).isNull();
        assertThat(value("2 ^ 0.5")).isNull();
        assertThat(value("2 ^ 4096")).isNull();
    }

    /** Anything outside the grammar is undecidable, never an error: no names, no calls, no state. */
    @Test void refusesAnythingThatIsNotAnExpression() {
        assertThat(value("2x + 3")).isNull();
        assertThat(value("(2 + 3")).isNull();
        assertThat(value("2 +")).isNull();
        assertThat(value("+ 2")).isEqualTo("2");
        assertThat(value("")).isNull();
        assertThat(value("length(x)")).isNull();
        assertThat(value("3 + 4 = 7")).isNull();
    }

    /** A rounded value is what a person writes; only a difference too large to be rounding is a disagreement. */
    @Test void aRoundedResultCountsAsWritten() {
        Arithmetic.Value third = Arithmetic.evaluate(Arithmetic.tokens("1 / 3"));
        assertThat(third.roundsTo(Arithmetic.number("0.33"), 2)).isTrue();
        assertThat(third.roundsTo(Arithmetic.number("0.3333"), 4)).isTrue();
        assertThat(third.roundsTo(Arithmetic.number("0.34"), 2)).isFalse();
        assertThat(third.roundsTo(Arithmetic.number("0.4"), 1)).isFalse();
        Arithmetic.Value twelve = Arithmetic.evaluate(Arithmetic.tokens("144 / 12"));
        assertThat(twelve.roundsTo(Arithmetic.number("11"), 0)).isFalse();
        assertThat(twelve.roundsTo(Arithmetic.number("12"), 0)).isTrue();
    }

    /** Positions come back with the tokens so a caller can quote the exact text it checked. */
    @Test void tokensCarryWhereTheyWere() {
        var tokens = Arithmetic.tokens("needs 3 + 4");
        assertThat(tokens).hasSize(4);
        assertThat(tokens.get(0).kind()).isEqualTo(Arithmetic.Kind.OTHER);
        assertThat(tokens.get(1).kind()).isEqualTo(Arithmetic.Kind.NUMBER);
        assertThat(tokens.get(1).start()).isEqualTo(6);
        assertThat(Arithmetic.hasOperator(tokens)).isTrue();
        assertThat(Arithmetic.hasOperator(Arithmetic.tokens("just 12 items"))).isFalse();
    }
}
