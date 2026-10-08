package com.studyos.verify;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Recomputes the numeric claims in an answer that are self-contained enough to be settled by arithmetic
 * alone, and reports the ones that do not hold.
 *
 * <p>A language model asserting "110101 has three 1-bits" is stating something a machine can decide, and the
 * measured failures in this system were of exactly that kind: a remainder off by one bit, a bit count off by
 * one, stated with full confidence and carried into everything downstream. Nothing here knows any subject.
 * It knows integers, exclusive-or, and how to count set bits, so it works the same for a networking course
 * and a chemistry one.
 *
 * <p>Which is a claim worth making concrete, because the notations differ by subject even though the arithmetic
 * does not. A chemistry answer writes "25 mL + 30 mL = 55 mL", a finance one "15% of 240 is 36", an algebra one
 * "2x + 3x = 5x" — none of which is an operator between two bare numerals, and all of which are decided here by
 * the same exact rational evaluator. Quantities carry their unit through the calculation and the unit has to
 * agree on every operand and on the result, which is also what makes the algebraic case safe: collecting like
 * terms and adding like quantities are the same operation, and a run whose units disagree is left undecided
 * rather than guessed at.
 *
 * <p>Precision is chosen over recall throughout. A claim is only checked when its notation is unambiguous,
 * and any clause that reads like a deliberate counter-example is skipped, because flagging an intentionally
 * wrong equation as an error would be worse than missing a real one.
 *
 * <p>Written expressions are recomputed by {@link Arithmetic} rather than matched shape by shape, so a mistake
 * inside a derivation is visible and not only a mistake in a lone sum. Values there are exact rationals, and a
 * result rounded to the places the answer wrote is accepted as written: 0.33 for a third is what a person
 * would put, and a check that called it contradicted would teach a reader to ignore the check.
 */
public final class ComputationAudit {
    /** Splits on sentence punctuation, but never between digits, so "3.5" stays intact. */
    private static final Pattern CLAUSES = Pattern.compile("(?<![0-9])[.;!?\\n](?![0-9])");
    /** Wording that makes a false equation intentional: a worked counter-example, or a mistake being named. */
    private static final Pattern DELIBERATELY_WRONG = Pattern.compile("(?i)\\b(?:incorrect|wrong|mistake|mistaken|error|erroneous|false|invalid|not\\s+equal|does\\s+not\\s+equal|instead\\s+of|rather\\s+than|would\\s+be|common\\s+(?:error|mistake|pitfall)|misconception|do\\s+not|don't|never\\s+write|trap)\\b|≠|!=");
    /** Notation that says the arithmetic in this clause is not base ten. */
    private static final Pattern BINARY_CONTEXT = Pattern.compile("(?i)mod(?:ulo)?[\\s-]*2\\b|\\bGF\\s*\\(\\s*2\\s*\\)|\\bxor\\b|⊕|exclusive[\\s-]or|binary\\s+(?:addition|division|arithmetic|subtraction)|polynomial\\s+division");

    private static final String COUNT = NumberWords.pattern();
    private static final String ONES = "(?:1s|1'?s|1[-\\s]?bits?|ones|set\\s+bits?|nonzero\\s+bits?)";
    /** The right-hand side of a written equation: what the answer says the expression comes to. */
    private static final Pattern CLAIMED = Pattern.compile("\\s*(-?\\d{1,24}(?:\\.\\d{1,12})?)(?![\\w.]*\\d)");
    private static final Pattern XOR_EQUATION = Pattern.compile("(?<![01])([01]{2,64})\\s*(?:xor|⊕)\\s*([01]{2,64})\\s*=\\s*([01]{2,64})(?![01])", Pattern.CASE_INSENSITIVE);
    /** Past this a clause is a table row or a wall of figures, not a derivation, and scanning it buys nothing. */
    private static final int MAX_CLAUSE_CHARS = 600;
    /** How far back from an equals sign an expression may reach, so a sentence of numbers is not read as a sum. */
    private static final int MAX_EXPRESSION_TOKENS = 40;
    private static final Pattern ONES_SUFFIX = Pattern.compile("(?<![01])([01]{2,64})(?![01])[^.;!?\\n]{0,48}?\\b(?:has|have|contains?|includes?|with)\\s+(?:exactly\\s+|only\\s+|a\\s+total\\s+of\\s+)?(" + COUNT + ")\\s+" + ONES + "\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern ONES_PREFIX = Pattern.compile("\\b(?:number|count|total|hamming\\s+weight|weight)\\s+of\\s+(?:" + ONES + "\\s+)?(?:in|of|for)\\s+(?<![01])([01]{2,64})(?![01])[^.;!?\\n]{0,24}?(?:is|=|equals)\\s+(" + COUNT + ")\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern REMAINDER_IS = Pattern.compile("\\bremainder\\b[^.;!?\\n]{0,60}?(?<![01])([01]{3,64})(?![01])\\s*(?:divided\\s+by|/|÷|by|mod(?:ulo)?)\\s*(?<![01])([01]{2,64})(?![01])[^.;!?\\n]{0,40}?(?:is|are|=|equals|gives)\\s*(?<![01])([01]{1,64})(?![01])", Pattern.CASE_INSENSITIVE);
    private static final Pattern REMAINDER_GIVES = Pattern.compile("(?<![01])([01]{3,64})(?![01])\\s*(?:divided\\s+by|/|÷)\\s*(?<![01])([01]{2,64})(?![01])[^.;!?\\n]{0,40}?\\bremainder\\b[^.;!?\\n]{0,24}?(?<![01])([01]{1,64})(?![01])", Pattern.CASE_INSENSITIVE);

    /** The unit a quantity carries, taken as written: a word of letters, no longer than a unit ever is. */
    private static final Pattern UNIT = Pattern.compile("\\s*(\\p{L}{1,12})(?![\\p{L}.])");
    /**
     * Percent of a quantity, the way every quantitative subject writes a proportion. The {@code =} alternative
     * sits outside the word boundary on purpose: {@code \b=} can never match, because a space and an equals sign
     * are both non-word characters and there is no boundary between them.
     */
    private static final String RESOLVES_TO = "(?:\\b(?:is|are|equals|gives|becomes|comes\\s+to|amounts\\s+to)\\b|=)";
    private static final Pattern PERCENT_OF = Pattern.compile("(?<![\\w.])(\\d{1,9}(?:\\.\\d{1,9})?)\\s*(?:%|percent|per\\s+cent)\\s+of\\s+(\\d{1,15}(?:\\.\\d{1,9})?)(?![\\w.])[^.;!?\\n]{0,24}?" + RESOLVES_TO + "\\s*(-?\\d{1,15}(?:\\.\\d{1,9})?)(?![\\w.]*\\d)", Pattern.CASE_INSENSITIVE);
    /** The same proportion stated the other way round, which is how a share or a yield is usually reported. */
    private static final Pattern IS_PERCENT_OF = Pattern.compile("(?<![\\w.])(\\d{1,15}(?:\\.\\d{1,9})?)(?![\\w.])[^.;!?\\n]{0,24}?\\b(?:is|are|equals|represents|makes\\s+up)\\s+(?:about\\s+|roughly\\s+|approximately\\s+)?(\\d{1,9}(?:\\.\\d{1,9})?)\\s*(?:%|percent|per\\s+cent)\\s+of\\s+(\\d{1,15}(?:\\.\\d{1,9})?)(?![\\w.])", Pattern.CASE_INSENSITIVE);
    private static final Arithmetic.Value HUNDRED = Arithmetic.number("100");

    private ComputationAudit() {}

    /** Every self-contained numeric claim in {@code text} that arithmetic contradicts. */
    public static List<Finding> findings(String text) {
        if (text == null || text.isBlank()) return List.of();
        List<Finding> findings = new ArrayList<>();
        for (String clause : CLAUSES.split(text)) {
            if (clause.isBlank() || DELIBERATELY_WRONG.matcher(clause).find()) continue;
            boolean binaryContext = BINARY_CONTEXT.matcher(clause).find();
            expressions(clause, binaryContext, findings);
            if (!binaryContext) percentages(clause, findings);
            xorEquations(clause, findings);
            oneCounts(clause, findings);
            if (binaryContext) remainders(clause, findings);
        }
        return List.copyOf(findings);
    }

    /**
     * Base-ten arithmetic, as much of it as the answer wrote. Each {@code =} is taken with the arithmetic
     * written in front of it, which is what lets "so (15 - 1) / 2 = 8" be checked: the mistake is in a
     * derivation, not in a lone sum, and a pattern for one operator and two operands cannot see it.
     *
     * <p>A clause whose every operand and result reads as a binary literal is skipped outright: "10 + 11 = 101"
     * is correct in one base and wrong in the other, and guessing which was meant is exactly the kind of
     * inference this class exists to avoid. A quantity that carries a unit is exempt from that caution, because
     * "10 mL + 11 mL" is not written in base two by anyone.
     */
    private static void expressions(String clause, boolean binaryContext, List<Finding> findings) {
        if (binaryContext || clause.length() > MAX_CLAUSE_CHARS) return;
        List<Arithmetic.Token> tokens = Arithmetic.tokens(clause);
        for (int index = 0; index < tokens.size(); index++) {
            if (!tokens.get(index).text().equals("=")) continue;
            Matcher claimed = CLAIMED.matcher(clause).region(tokens.get(index).end(), clause.length());
            if (!claimed.lookingAt()) continue;
            Expression expression = expressionBefore(tokens, index);
            if (expression == null) continue;
            Arithmetic.Value stated = Arithmetic.number(claimed.group(1));
            if (stated == null) continue;
            int end = claimed.end();
            if (!expression.unit().isEmpty()) {
                Matcher unit = UNIT.matcher(clause).region(claimed.end(), clause.length());
                if (!unit.lookingAt() || !unit.group(1).equalsIgnoreCase(expression.unit())) continue;
                end = unit.end();
            }
            List<String> literals = new ArrayList<>(expression.literals());
            literals.add(claimed.group(1));
            if (expression.unit().isEmpty() && literals.stream().allMatch(Gf2Polynomial::isBinary)) continue;
            int places = claimed.group(1).indexOf('.') < 0 ? 0 : claimed.group(1).length() - claimed.group(1).indexOf('.') - 1;
            if (expression.value().roundsTo(stated, places)) continue;
            findings.add(new Finding("arithmetic", clause.substring(expression.start(), end).trim(), claimed.group(1), expression.value() + (expression.unit().isEmpty() ? "" : " " + expression.unit())));
        }
    }

    /**
     * A proportion of a quantity, which is how most subjects write the calculation a networking course writes as
     * a remainder: percent yield, interest, a share of a population, a mark out of a total. The value is computed
     * as an exact rational, so "33.33% of 90 is 30" is accepted for what it rounded to rather than contradicted
     * by a hundredth.
     */
    private static void percentages(String clause, List<Finding> findings) {
        if (clause.length() > MAX_CLAUSE_CHARS || HUNDRED == null) return;
        record Claim(String percent, String whole, String stated, String text) {}
        List<Claim> claims = new ArrayList<>();
        Matcher of = PERCENT_OF.matcher(clause);
        while (of.find()) claims.add(new Claim(of.group(1), of.group(2), of.group(3), of.group()));
        Matcher share = IS_PERCENT_OF.matcher(clause);
        while (share.find()) claims.add(new Claim(share.group(2), share.group(3), share.group(1), share.group()));
        for (Claim claim : claims) {
            Arithmetic.Value percent = Arithmetic.number(claim.percent()), whole = Arithmetic.number(claim.whole()), stated = Arithmetic.number(claim.stated());
            if (percent == null || whole == null || stated == null) continue;
            Arithmetic.Value computed = percent.multiply(whole).divide(HUNDRED);
            if (computed == null) continue;
            int places = claim.stated().indexOf('.') < 0 ? 0 : claim.stated().length() - claim.stated().indexOf('.') - 1;
            if (computed.roundsTo(stated, places)) continue;
            findings.add(new Finding("percentage", claim.text().trim(), claim.stated(), computed.toString()));
        }
    }

    /**
     * The run of arithmetic reaching back from {@code equals}, if all of it is one expression. Words end the
     * run, which is what pulls the sum out of a sentence: in "Titrating 25 mL needs 3 + 4 = 8" the run is
     * "3 + 4", because "needs" is not arithmetic and stops the walk.
     *
     * <p>All of the run has to parse, and it has to open with a quantity or a bracket. Settling for whatever
     * shorter tail happens to parse is what turns algebra into a false accusation: the run before the equals
     * in "2x + 3 = 7" is "+ 3", which reads perfectly well as a signed three, and an audit content with a
     * fragment would announce that the answer had claimed 3 was 7. A leading sign is refused for the same
     * reason — next to a word, "-5" is as likely to be a dash or a range as a negative number.
     *
     * <p>Quantities are tried first, bare numbers second. A calculation in most subjects is written with its
     * units attached, and reading "25 mL + 30 mL = 55 mL" as arithmetic requires letting the unit travel with
     * the number — under the strict condition that every quantity in the run carries the same one.
     */
    private static Expression expressionBefore(List<Arithmetic.Token> tokens, int equals) {
        Expression quantities = quantityExpressionBefore(tokens, equals);
        return quantities != null ? quantities : numberExpressionBefore(tokens, equals);
    }

    private static Expression numberExpressionBefore(List<Arithmetic.Token> tokens, int equals) {
        int from = equals;
        while (from > 0 && equals - from < MAX_EXPRESSION_TOKENS && isArithmetic(tokens.get(from - 1).kind())) from--;
        return expressionOf(tokens.subList(from, equals), List.of(), "");
    }

    /**
     * The same run, with a unit allowed on each quantity. Every number has to carry one and they all have to be
     * the same word, which is what keeps the reading honest in both directions: "2x + 3x = 5x" is like terms
     * collected and is checked, while "2x + 3 = 7" mixes a quantity with a bare number and is an equation with
     * an unknown, so it is left alone. Mixed units are refused too — adding grams to litres is not arithmetic
     * this can settle, and pretending the unit is decoration would settle it wrongly.
     */
    private static Expression quantityExpressionBefore(List<Arithmetic.Token> tokens, int equals) {
        int from = equals;
        while (from > 0 && equals - from < MAX_EXPRESSION_TOKENS && (isArithmetic(tokens.get(from - 1).kind()) || isUnitWord(tokens.get(from - 1)))) from--;
        while (from < equals && tokens.get(from).kind() != Arithmetic.Kind.NUMBER && tokens.get(from).kind() != Arithmetic.Kind.OPEN) from++;
        List<Arithmetic.Token> run = tokens.subList(from, equals);
        List<Arithmetic.Token> bare = new ArrayList<>();
        String unit = null;
        for (int index = 0; index < run.size(); index++) {
            Arithmetic.Token token = run.get(index);
            boolean carried = isUnitWord(token) && index > 0 && run.get(index - 1).kind() == Arithmetic.Kind.NUMBER;
            if (isUnitWord(token) && !carried) return null;
            if (carried) {
                if (unit != null && !unit.equalsIgnoreCase(token.text())) return null;
                unit = token.text();
                continue;
            }
            if (token.kind() == Arithmetic.Kind.NUMBER && (index + 1 >= run.size() || !isUnitWord(run.get(index + 1)))) return null;
            bare.add(token);
        }
        return unit == null ? null : expressionOf(bare, run, unit);
    }

    /** One complete expression, or nothing. {@code quoted} is the run as written when units were kept. */
    private static Expression expressionOf(List<Arithmetic.Token> run, List<Arithmetic.Token> quoted, String unit) {
        if (run.isEmpty() || !Arithmetic.hasOperator(run)) return null;
        if (run.get(0).kind() != Arithmetic.Kind.NUMBER && run.get(0).kind() != Arithmetic.Kind.OPEN) return null;
        Arithmetic.Value value = Arithmetic.evaluate(run);
        if (value == null) return null;
        List<String> literals = run.stream().filter(token -> token.kind() == Arithmetic.Kind.NUMBER).map(Arithmetic.Token::text).toList();
        return new Expression((quoted.isEmpty() ? run : quoted).get(0).start(), value, literals, unit);
    }

    private static boolean isArithmetic(Arithmetic.Kind kind) {
        return kind == Arithmetic.Kind.NUMBER || kind == Arithmetic.Kind.OPERATOR || kind == Arithmetic.Kind.OPEN || kind == Arithmetic.Kind.CLOSE;
    }

    /** A word short enough to be a unit or a symbol. Whether it really is one is decided by where it sits. */
    private static boolean isUnitWord(Arithmetic.Token token) {
        return token.kind() == Arithmetic.Kind.OTHER && token.text().length() <= 12 && token.text().chars().allMatch(Character::isLetter);
    }

    private record Expression(int start, Arithmetic.Value value, List<String> literals, String unit) {}

    /** Exclusive-or is unambiguous whatever the subject, which makes every long-division step checkable. */
    private static void xorEquations(String clause, List<Finding> findings) {
        Matcher matcher = XOR_EQUATION.matcher(clause);
        while (matcher.find()) {
            String computed = Gf2Polynomial.xor(matcher.group(1), matcher.group(2));
            if (sameBits(computed, matcher.group(3))) continue;
            findings.add(new Finding("exclusive-or", matcher.group().trim(), matcher.group(3), computed));
        }
    }

    private static void oneCounts(String clause, List<Finding> findings) {
        for (Pattern pattern : List.of(ONES_SUFFIX, ONES_PREFIX)) {
            Matcher matcher = pattern.matcher(clause);
            while (matcher.find()) {
                String bits = matcher.group(1);
                Integer claimed = NumberWords.valueOf(matcher.group(2));
                if (claimed == null) continue;
                int computed = Gf2Polynomial.onesIn(bits);
                if (computed == claimed) continue;
                findings.add(new Finding("bit count", matcher.group().trim(), String.valueOf(claimed), computed + " (" + bits + ")"));
            }
        }
    }

    private static void remainders(String clause, List<Finding> findings) {
        for (Pattern pattern : List.of(REMAINDER_IS, REMAINDER_GIVES)) {
            Matcher matcher = pattern.matcher(clause);
            while (matcher.find()) {
                try {
                    String computed = Gf2Polynomial.remainder(matcher.group(1), matcher.group(2));
                    if (sameBits(computed, matcher.group(3))) continue;
                    findings.add(new Finding("mod-2 remainder", matcher.group().trim(), matcher.group(3), computed));
                } catch (IllegalArgumentException ignored) {
                    // Not a well-formed mod-2 division; nothing to decide.
                }
            }
        }
    }

    /** Leading zeros carry no value, so widths may differ without the claim being wrong. */
    private static boolean sameBits(String left, String right) { return strip(left).equals(strip(right)); }
    private static String strip(String bits) { int at = 0; while (at < bits.length() - 1 && bits.charAt(at) == '0') at++; return bits.substring(at); }

    /**
     * A note for the reader naming each contradicted claim and what the arithmetic gives instead. The answer
     * itself is left alone: rewriting a derivation from the outside risks contradicting the reasoning around
     * it, whereas saying plainly that a step does not check out is always safe and always true.
     */
    public static String note(List<Finding> findings) {
        if (findings.isEmpty()) return "";
        StringBuilder note = new StringBuilder("**Computation check** — the following step" + (findings.size() == 1 ? " does" : "s do") + " not hold when recomputed, so treat " + (findings.size() == 1 ? "it" : "them") + " as unreliable:\n");
        for (Finding finding : findings) note.append("- ").append(finding.kind()).append(": \"").append(finding.claim()).append("\" — recomputed as ").append(finding.computed()).append(", not ").append(finding.claimed()).append(".\n");
        return note.toString();
    }

    /** One contradicted claim: what was written, what was asserted, and what the arithmetic gives. */
    public record Finding(String kind,String claim,String claimed,String computed) {}
}
