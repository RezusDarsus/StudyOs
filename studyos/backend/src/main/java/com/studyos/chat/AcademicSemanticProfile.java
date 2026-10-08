package com.studyos.chat;

import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import java.util.List;

/**
 * Domain-agnostic description of the academic content and reasoning in source material or an exercise.
 * The vocabulary is extracted from uploaded evidence; no subject is encoded in Java.
 */
public record AcademicSemanticProfile(
        @JsonDeserialize(using=PredictionVerificationBatch.StringListDeserializer.class) List<String> concepts,
        @JsonDeserialize(using=PredictionVerificationBatch.StringListDeserializer.class) List<String> assumptions,
        @JsonDeserialize(using=PredictionVerificationBatch.StringListDeserializer.class) List<String> domains,
        @JsonDeserialize(using=PredictionVerificationBatch.StringListDeserializer.class) List<String> operations,
        @JsonDeserialize(using=PredictionVerificationBatch.StringListDeserializer.class) List<String> requiredKnowledge,
        @JsonDeserialize(using=PredictionVerificationBatch.StringListDeserializer.class) List<String> taskTypes,
        @JsonDeserialize(using=PredictionVerificationBatch.StringListDeserializer.class) List<String> expectedReasoningSteps) {

    public AcademicSemanticProfile {
        concepts=copy(concepts); assumptions=copy(assumptions); domains=copy(domains); operations=copy(operations);
        requiredKnowledge=copy(requiredKnowledge); taskTypes=copy(taskTypes); expectedReasoningSteps=copy(expectedReasoningSteps);
    }

    public static AcademicSemanticProfile empty(){return new AcademicSemanticProfile(List.of(),List.of(),List.of(),List.of(),List.of(),List.of(),List.of());}
    public boolean isEmpty(){return concepts.isEmpty()&&assumptions.isEmpty()&&domains.isEmpty()&&operations.isEmpty()&&requiredKnowledge.isEmpty()&&taskTypes.isEmpty()&&expectedReasoningSteps.isEmpty();}
    public static String contract(){return "{concepts:[],assumptions:[],domains:[],operations:[],requiredKnowledge:[],taskTypes:[],expectedReasoningSteps:[]}";}
    private static List<String> copy(List<String> values){return values==null?List.of():values.stream().filter(value->value!=null&&!value.isBlank()).map(String::trim).distinct().toList();}
}
