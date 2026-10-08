package com.studyos.verify;

/**
 * Division over GF(2), the polynomial arithmetic behind any mod-2 remainder: coefficients are bits, and
 * subtraction is exclusive-or, so there is no borrow. Kept deliberately free of any course vocabulary — this
 * is the arithmetic itself, and any subject that asks for a mod-2 remainder gets the same answer from it.
 */
public final class Gf2Polynomial {
    private Gf2Polynomial() {}

    /**
     * The remainder of {@code dividend} divided by {@code divisor} over GF(2), returned with one fewer bit
     * than the divisor, which is the width every mod-2 remainder has.
     *
     * @throws IllegalArgumentException if either operand is not a binary literal, or the divisor is zero
     */
    public static String remainder(String dividend, String divisor) {
        char[] working = requireBinary(dividend, "dividend").toCharArray();
        String d = requireBinary(divisor, "divisor");
        if (d.indexOf('1') < 0) throw new IllegalArgumentException("A mod-2 divisor must have a leading one");
        d = d.substring(d.indexOf('1'));
        int width = d.length();
        for (int at = 0; at + width <= working.length; at++) {
            if (working[at] != '1') continue;
            for (int offset = 0; offset < width; offset++) working[at + offset] = working[at + offset] == d.charAt(offset) ? '0' : '1';
        }
        int remainderWidth = width - 1;
        StringBuilder result = new StringBuilder();
        for (int i = Math.max(0, working.length - remainderWidth); i < working.length; i++) result.append(working[i]);
        while (result.length() < remainderWidth) result.insert(0, '0');
        return result.toString();
    }

    /** Bitwise exclusive-or of two binary literals, right-aligned and zero-padded to the wider operand. */
    public static String xor(String left, String right) {
        String a = requireBinary(left, "left operand"), b = requireBinary(right, "right operand");
        int width = Math.max(a.length(), b.length());
        a = pad(a, width); b = pad(b, width);
        StringBuilder result = new StringBuilder(width);
        for (int i = 0; i < width; i++) result.append(a.charAt(i) == b.charAt(i) ? '0' : '1');
        return result.toString();
    }

    /** How many bits are set — the Hamming weight of a binary literal. */
    public static int onesIn(String bits) {
        String value = requireBinary(bits, "value");
        int ones = 0;
        for (int i = 0; i < value.length(); i++) if (value.charAt(i) == '1') ones++;
        return ones;
    }

    public static boolean isBinary(String value) { if (value == null || value.isEmpty()) return false; for (int i = 0; i < value.length(); i++) { char c = value.charAt(i); if (c != '0' && c != '1') return false; } return true; }

    private static String pad(String value, int width) { StringBuilder padded = new StringBuilder(value); while (padded.length() < width) padded.insert(0, '0'); return padded.toString(); }
    private static String requireBinary(String value, String role) { if (!isBinary(value)) throw new IllegalArgumentException("The " + role + " must be a binary literal"); return value; }
}
