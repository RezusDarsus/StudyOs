package com.studyos.assessment;

import java.util.Locale;

/**
 * Deterministic grading for the answer types that have an objectively right answer.
 *
 * <p>A model grade is the only judgement an open-ended answer can get, but a multiple-choice or
 * numeric answer either matches its expected answer or it does not, and no durable learner state
 * should rest on a model disagreeing with arithmetic. For those types this check bounds the
 * recorded score: an exact match cannot be graded below full credit, and a mismatch cannot be
 * graded above a residual sliver of partial credit. Open-ended types are left to the grader.
 */
final class DeterministicAnswerCheck {
    /** Above this an objectively wrong answer may never be graded — a mis-keyed selection is not partial credit. */
    static final double MISMATCH_CEILING = .1;
    /** Below this an objectively right answer may never be graded. */
    static final double MATCH_FLOOR = 1.0;

    private DeterministicAnswerCheck() {}

    /** Whether this answer type is one this class can judge on its own. */
    static boolean objectivelyGradable(String answerType) {
        String type = answerType == null ? "" : answerType.toUpperCase(Locale.ROOT);
        return type.equals("MULTIPLE_CHOICE") || type.equals("NUMERIC");
    }

    /**
     * The score the recorded evidence may carry, given the objective comparison and the grade the
     * model proposed. The model can only widen a mismatch upwards in the narrow case where its
     * rubric caught an equivalence the string comparison missed, and even then never to a pass.
     */
    static double bound(double proposedScore, boolean matches) {
        double score = Math.max(0, Math.min(1, proposedScore));
        if (matches) return Math.max(score, MATCH_FLOOR);
        return Math.min(score, MISMATCH_CEILING);
    }

    /**
     * Whether the answer is the expected one, compared as a learner would write it: case, spacing
     * and punctuation folded away, and numbers compared by value so "0.5", ".50" and "1/2" agree
     * but "0.45" does not. Numeric comparison runs on the raw strings, because folding punctuation
     * into spaces would turn "42.0" into "42 0" before the parser ever saw it.
     */
    static boolean matches(String answer, String expected) {
        if (answer == null || expected == null) return false;
        String left = fold(answer);
        String right = fold(expected);
        if (left.isEmpty() || right.isEmpty()) return false;
        if (left.equals(right)) return true;
        Double leftValue = numeric(answer.trim());
        Double rightValue = numeric(expected.trim());
        return leftValue != null && rightValue != null && leftValue.doubleValue() == rightValue.doubleValue();
    }

    private static String fold(String value) {
        return value.trim().toLowerCase(Locale.ROOT)
                .replaceAll("[\\p{Punct}\\p{IsPunctuation}]+", " ")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private static Double numeric(String value) {
        String cleaned = value.replace(" ", "");
        if (cleaned.isEmpty()) return null;
        int slash = cleaned.indexOf('/');
        if (slash > 0 && slash < cleaned.length() - 1) {
            try {
                double denominator = Double.parseDouble(cleaned.substring(slash + 1));
                if (denominator == 0) return null;
                return Double.parseDouble(cleaned.substring(0, slash)) / denominator;
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        try { return Double.parseDouble(cleaned); } catch (NumberFormatException ignored) { return null; }
    }
}
