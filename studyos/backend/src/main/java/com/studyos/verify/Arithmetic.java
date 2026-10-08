package com.studyos.verify;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Evaluates written arithmetic exactly, so a derivation in an answer can be recomputed instead of trusted.
 *
 * <p>The reason this exists rather than a check per equation shape: a model that states "(15 - 1) / 2 = 8" has
 * made a mistake of exactly the kind {@link ComputationAudit} was built for, but no pattern for
 * <em>operand-operator-operand</em> can see it. Reading the expression and computing it is the only way to
 * cover the derivations answers actually write, which is what program-of-thought does — put the calculation in
 * something that can be executed and execute it, rather than asking a language model to be a calculator.
 *
 * <p>The language is deliberately tiny and total: decimal literals, {@code + - * / ^ mod}, parentheses, unary
 * minus. Nothing here is a general expression evaluator and nothing here executes anything a model wrote — the
 * grammar has no names, no calls, and no state, so the worst an unparseable input can do is be undecidable.
 *
 * <p>Values are exact rationals rather than doubles. {@code 0.1 + 0.2 = 0.3} is true, and a checker that
 * reported it as false because binary floating point disagrees would be worse than no checker at all.
 */
final class Arithmetic {
    /** A literal longer than this is an identifier, a year range, or an accident, not a quantity in a sum. */
    private static final int MAX_LITERAL_DIGITS = 24;
    /** Any intermediate wider than this ends the evaluation: an answer's arithmetic is never this large. */
    private static final int MAX_BITS = 4096;
    private static final int MAX_EXPONENT = 64;
    private static final int MAX_DEPTH = 16;
    private static final BigInteger TEN = BigInteger.TEN;

    private Arithmetic() {}

    enum Kind { NUMBER, OPERATOR, OPEN, CLOSE, OTHER }

    /** One piece of written text, with where it was, so a caller can quote exactly what it checked. */
    record Token(String text, int start, int end, Kind kind) {}

    /**
     * Splits text into the pieces an expression is made of. Anything the language does not have — a word, a
     * unit, a percent sign — comes back as {@link Kind#OTHER}, which is what lets a caller find the arithmetic
     * inside a sentence by dropping tokens from the left until what remains parses.
     */
    static List<Token> tokens(String text) {
        List<Token> tokens = new ArrayList<>();
        if (text == null) return tokens;
        int at = 0;
        while (at < text.length()) {
            char character = text.charAt(at);
            if (Character.isWhitespace(character)) { at++; continue; }
            if (Character.isDigit(character)) {
                int end = at;
                while (end < text.length() && Character.isDigit(text.charAt(end))) end++;
                if (end < text.length() && text.charAt(end) == '.' && end + 1 < text.length() && Character.isDigit(text.charAt(end + 1))) {
                    end++;
                    while (end < text.length() && Character.isDigit(text.charAt(end))) end++;
                }
                tokens.add(new Token(text.substring(at, end), at, end, Kind.NUMBER));
                at = end;
                continue;
            }
            if (Character.isLetter(character)) {
                int end = at;
                while (end < text.length() && Character.isLetter(text.charAt(end))) end++;
                String word = text.substring(at, end).toLowerCase(Locale.ROOT);
                tokens.add(new Token(text.substring(at, end), at, end, word.equals("mod") || word.equals("modulo") ? Kind.OPERATOR : Kind.OTHER));
                at = end;
                continue;
            }
            if (character == '*' && at + 1 < text.length() && text.charAt(at + 1) == '*') { tokens.add(new Token("**", at, at + 2, Kind.OPERATOR)); at += 2; continue; }
            Kind kind = character == '(' ? Kind.OPEN : character == ')' ? Kind.CLOSE : isOperator(character) ? Kind.OPERATOR : Kind.OTHER;
            tokens.add(new Token(String.valueOf(character), at, at + 1, kind));
            at++;
        }
        return tokens;
    }

    private static boolean isOperator(char character) {
        return "+-−*×·/÷^".indexOf(character) >= 0;
    }

    /**
     * What the tokens compute, or {@code null} when they are not one complete expression or a step of it cannot
     * be decided exactly. Undecidable and wrong are kept apart on purpose: a caller that cannot tell them apart
     * would report a division it could not perform as a contradiction.
     */
    static Value evaluate(List<Token> tokens) {
        if (tokens == null || tokens.isEmpty()) return null;
        Cursor cursor = new Cursor(tokens);
        Value value = expression(cursor, 0);
        return value == null || cursor.at != tokens.size() ? null : value;
    }

    /** Whether these tokens contain something to compute, as opposed to a bare quantity restated. */
    static boolean hasOperator(List<Token> tokens) {
        return tokens.stream().anyMatch(token -> token.kind() == Kind.OPERATOR);
    }

    static Value number(String literal) {
        if (literal == null) return null;
        String value = literal.strip();
        boolean negative = value.startsWith("-") || value.startsWith("−");
        if (negative) value = value.substring(1).strip();
        int dot = value.indexOf('.');
        String digits = dot < 0 ? value : value.substring(0, dot) + value.substring(dot + 1);
        if (digits.isEmpty() || digits.length() > MAX_LITERAL_DIGITS || !digits.chars().allMatch(Character::isDigit)) return null;
        BigInteger numerator = new BigInteger(digits);
        BigInteger denominator = dot < 0 ? BigInteger.ONE : TEN.pow(value.length() - dot - 1);
        return Value.of(negative ? numerator.negate() : numerator, denominator);
    }

    private static Value expression(Cursor cursor, int depth) {
        if (depth > MAX_DEPTH) return null;
        Value left = term(cursor, depth);
        while (left != null && cursor.isOperator("+", "-", "−")) {
            String operator = cursor.take().text();
            Value right = term(cursor, depth);
            if (right == null) return null;
            left = operator.equals("+") ? left.add(right) : left.subtract(right);
        }
        return left;
    }

    private static Value term(Cursor cursor, int depth) {
        Value left = unary(cursor, depth);
        while (left != null && cursor.isOperator("*", "×", "·", "/", "÷", "mod", "modulo")) {
            String operator = cursor.take().text().toLowerCase(Locale.ROOT);
            Value right = unary(cursor, depth);
            if (right == null) return null;
            left = switch (operator) {
                case "*", "×", "·" -> left.multiply(right);
                case "/", "÷" -> left.divide(right);
                default -> left.mod(right);
            };
        }
        return left;
    }

    private static Value unary(Cursor cursor, int depth) {
        if (cursor.isOperator("-", "−")) { cursor.take(); Value value = unary(cursor, depth); return value == null ? null : value.negate(); }
        if (cursor.isOperator("+")) { cursor.take(); return unary(cursor, depth); }
        return power(cursor, depth);
    }

    /** Right-associative, as written: 2^3^2 is 2^9. */
    private static Value power(Cursor cursor, int depth) {
        Value base = primary(cursor, depth);
        if (base == null || !cursor.isOperator("^", "**")) return base;
        cursor.take();
        Value exponent = unary(cursor, depth);
        return exponent == null ? null : base.pow(exponent);
    }

    private static Value primary(Cursor cursor, int depth) {
        Token token = cursor.peek();
        if (token == null) return null;
        if (token.kind() == Kind.NUMBER) { cursor.take(); return number(token.text()); }
        if (token.kind() == Kind.OPEN) {
            cursor.take();
            Value inner = expression(cursor, depth + 1);
            if (inner == null || cursor.peek() == null || cursor.peek().kind() != Kind.CLOSE) return null;
            cursor.take();
            return inner;
        }
        return null;
    }

    private static final class Cursor {
        private final List<Token> tokens;
        private int at;
        Cursor(List<Token> tokens) { this.tokens = tokens; }
        Token peek() { return at < tokens.size() ? tokens.get(at) : null; }
        Token take() { return tokens.get(at++); }
        boolean isOperator(String... operators) {
            Token token = peek();
            if (token == null || token.kind() != Kind.OPERATOR) return false;
            for (String operator : operators) if (token.text().equalsIgnoreCase(operator)) return true;
            return false;
        }
    }

    /**
     * An exact rational. Every operation returns {@code null} rather than an approximation, so a value that
     * exists is a value that was computed exactly.
     */
    record Value(BigInteger numerator, BigInteger denominator) {
        static Value of(BigInteger numerator, BigInteger denominator) {
            if (denominator == null || numerator == null || denominator.signum() == 0) return null;
            BigInteger top = numerator, bottom = denominator;
            if (bottom.signum() < 0) { top = top.negate(); bottom = bottom.negate(); }
            BigInteger divisor = top.gcd(bottom);
            if (divisor.signum() != 0) { top = top.divide(divisor); bottom = bottom.divide(divisor); }
            return top.bitLength() > MAX_BITS || bottom.bitLength() > MAX_BITS ? null : new Value(top, bottom);
        }

        Value add(Value other) { return other == null ? null : of(numerator.multiply(other.denominator).add(other.numerator.multiply(denominator)), denominator.multiply(other.denominator)); }
        Value subtract(Value other) { return other == null ? null : add(other.negate()); }
        Value multiply(Value other) { return other == null ? null : of(numerator.multiply(other.numerator), denominator.multiply(other.denominator)); }
        Value divide(Value other) { return other == null || other.numerator.signum() == 0 ? null : of(numerator.multiply(other.denominator), denominator.multiply(other.numerator)); }
        Value negate() { return new Value(numerator.negate(), denominator); }
        Value abs() { return numerator.signum() < 0 ? negate() : this; }

        /** Whole numbers only, and a positive modulus: anything else is a notation this cannot settle. */
        Value mod(Value other) {
            BigInteger left = integer(), right = other == null ? null : other.integer();
            return left == null || right == null || right.signum() <= 0 ? null : of(left.mod(right), BigInteger.ONE);
        }

        /** Whole exponents within reach. A fractional power is a root, which is not exact and so not decided. */
        Value pow(Value other) {
            BigInteger exponent = other == null ? null : other.integer();
            if (exponent == null || exponent.abs().compareTo(BigInteger.valueOf(MAX_EXPONENT)) > 0) return null;
            int power = exponent.abs().intValueExact();
            if ((long) Math.max(numerator.bitLength(), denominator.bitLength()) * power > MAX_BITS) return null;
            Value raised = of(numerator.pow(power), denominator.pow(power));
            if (raised == null || exponent.signum() >= 0) return raised;
            return raised.numerator.signum() == 0 ? null : of(raised.denominator, raised.numerator);
        }

        BigInteger integer() { return denominator.equals(BigInteger.ONE) ? numerator : null; }
        int compareTo(Value other) { return numerator.multiply(other.denominator).compareTo(other.numerator.multiply(denominator)); }

        /**
         * Whether {@code claimed} is this value written to {@code fractionDigits} places. A rounded quotient is
         * not a wrong quotient: an answer that says a third is 0.33 is correct to what it wrote, and reporting
         * it as contradicted would train a reader to ignore the check.
         */
        boolean roundsTo(Value claimed, int fractionDigits) {
            if (claimed == null) return false;
            if (compareTo(claimed) == 0) return true;
            Value tolerance = of(BigInteger.ONE, TEN.pow(Math.max(0, Math.min(24, fractionDigits))).multiply(BigInteger.TWO));
            Value difference = subtract(claimed);
            return tolerance != null && difference != null && difference.abs().compareTo(tolerance) <= 0;
        }

        /** The value as an answer would write it: whole, exact decimal where one exists, otherwise a fraction. */
        @Override public String toString() {
            if (denominator.equals(BigInteger.ONE)) return numerator.toString();
            BigInteger remaining = denominator;
            int twos = 0, fives = 0;
            while (remaining.mod(BigInteger.TWO).signum() == 0) { remaining = remaining.divide(BigInteger.TWO); twos++; }
            while (remaining.mod(BigInteger.valueOf(5)).signum() == 0) { remaining = remaining.divide(BigInteger.valueOf(5)); fives++; }
            if (!remaining.equals(BigInteger.ONE)) return numerator + "/" + denominator;
            int places = Math.max(twos, fives);
            BigInteger scaled = numerator.multiply(TEN.pow(places)).divide(denominator);
            String digits = scaled.abs().toString();
            while (digits.length() <= places) digits = "0" + digits;
            String value = digits.substring(0, digits.length() - places) + "." + digits.substring(digits.length() - places);
            return (scaled.signum() < 0 ? "-" : "") + value;
        }
    }
}
