package com.studyos.assessment;

import java.util.Locale;

/** Deterministic public grading state derived from a bounded rubric score. */
final class AssessmentOutcomeRules {
    /**
     * At or above this, an answer is simply correct. Named because a second rule depends on it: an attempt this
     * good cannot be the evidence for a misconception, and {@link MisconceptionEvidence} reads the boundary from
     * here rather than repeating the number.
     */
    static final double CORRECT_SCORE = .85;

    private AssessmentOutcomeRules() {}
    static String correctness(double score,String expectedAnswer){if(expectedAnswer==null||expectedAnswer.isBlank())return "UNSUPPORTED";if(score>=CORRECT_SCORE)return "CORRECT";if(score>=.35)return "PARTIALLY_CORRECT";return "INCORRECT";}
    static String errorType(String proposed,String correctness){if("CORRECT".equals(correctness))return "NONE";if("UNSUPPORTED".equals(correctness))return "UNSUPPORTED";String normalized=(proposed==null?"CONCEPTUAL_ERROR":proposed).toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]+","_").replaceAll("^_|_$","");return normalized.isBlank()?"CONCEPTUAL_ERROR":normalized.substring(0,Math.min(100,normalized.length()));}
    static String eventType(String correctness){return switch(correctness){case "CORRECT"->"EXERCISE_CORRECT";case "PARTIALLY_CORRECT"->"EXERCISE_PARTIAL";case "UNSUPPORTED"->"CHAT_INTERACTION";default->"EXERCISE_INCORRECT";};}
}
