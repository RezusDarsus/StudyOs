package com.studyos.knowledge;

/**
 * How a reconciliation comparison ended. {@code AMBIGUOUS} means the safe stages could not decide
 * and only a bounded LLM verification (or a human) may resolve the pair.
 */
public enum ReconciliationDecision {
    SAME,
    DIFFERENT,
    AMBIGUOUS
}
