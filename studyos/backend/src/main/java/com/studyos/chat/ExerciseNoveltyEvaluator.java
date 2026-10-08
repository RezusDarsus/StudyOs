package com.studyos.chat;

import java.util.List;

/** Public deterministic facade used by generation pipelines and the quality harness. */
public final class ExerciseNoveltyEvaluator {
    private ExerciseNoveltyEvaluator(){}
    public static Evaluation evaluate(List<String> references,String candidate){var shallow=PredictionVerificationRules.shallowAgainst(references==null?List.of():references,candidate);double maximum=(references==null?List.<String>of():references).stream().mapToDouble(reference->PredictionVerificationRules.tokenOverlap(reference,candidate)).max().orElse(0);return new Evaluation(shallow.isEmpty(),shallow.orElse("UNDECIDED"),maximum);}
    public record Evaluation(boolean passesLocalNoveltyGate,String classification,double maximumTokenOverlap){}
}
