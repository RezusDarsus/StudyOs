package com.studyos.verify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class Gf2PolynomialTest {
    /** The worked case from the benchmark: the answer claimed 00101 where mod-2 division gives 01110. */
    @Test void computesAMod2RemainderIndependentlyOfAnyClaimAboutIt() {
        assertThat(Gf2Polynomial.remainder("1101011011" + "0000", "10011")).hasSize(4);
        assertThat(Gf2Polynomial.remainder("110101" + "00000", "110101")).isEqualTo("00000");
    }

    @Test void aRemainderIsAsWideAsTheDivisorLessOneBit() {
        assertThat(Gf2Polynomial.remainder("1010101", "1011")).hasSize(3);
        assertThat(Gf2Polynomial.remainder("1", "10011")).isEqualTo("0001");
    }

    /** Appending the remainder makes the message divisible — the property every mod-2 remainder must satisfy. */
    @Test void appendingTheRemainderMakesTheDividendDivisible() {
        for (String message : new String[]{"1101011011", "100000001", "1", "111111111111", "1000101110110101"})
            for (String divisor : new String[]{"10011", "1011", "11", "100000111"}) {
                String padded = message + "0".repeat(divisor.length() - 1);
                String remainder = Gf2Polynomial.remainder(padded, divisor);
                assertThat(Gf2Polynomial.remainder(Gf2Polynomial.xor(padded, remainder), divisor))
                        .as("%s / %s", message, divisor).isEqualTo("0".repeat(divisor.length() - 1));
            }
    }

    @Test void countsSetBitsExactly() {
        assertThat(Gf2Polynomial.onesIn("110101")).isEqualTo(4);
        assertThat(Gf2Polynomial.onesIn("0000")).isZero();
        assertThat(Gf2Polynomial.onesIn("1")).isEqualTo(1);
    }

    @Test void exclusiveOrPadsTheShorterOperandRatherThanTruncatingTheLonger() {
        assertThat(Gf2Polynomial.xor("1101", "1011")).isEqualTo("0110");
        assertThat(Gf2Polynomial.xor("1", "10011")).isEqualTo("10010");
    }

    @Test void rejectsInputThatIsNotABinaryLiteral() {
        assertThatThrownBy(() -> Gf2Polynomial.remainder("12", "10")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Gf2Polynomial.remainder("101", "000")).isInstanceOf(IllegalArgumentException.class);
        assertThat(Gf2Polynomial.isBinary("")).isFalse();
        assertThat(Gf2Polynomial.isBinary("0110")).isTrue();
    }
}
