package com.studyos.ai;

import org.springframework.stereotype.Component;

@Component
public class GenerationPolicyRegistry {
    private final AiUsageProperties properties;
    public GenerationPolicyRegistry(AiUsageProperties properties) { this.properties = properties; }
    public GenerationPolicy policy(AiOperation operation) {
        boolean internal = switch (operation) { case GRADING, TOPIC_EXTRACTION, MEMORY_EXTRACTION, SUMMARY, ASSESSMENT_EXTRACTION, EXAM_PREDICTION_VERIFICATION, RERANKING, RECONCILIATION, SYLLABUS_PARSING, RESEARCH_PLANNING -> true; default -> false; };
        String model = internal ? properties.resolvedInternalModel() : properties.getPrimaryModel();
        boolean json = internal || operation == AiOperation.QUIZ_GENERATION || operation == AiOperation.CURRICULUM || operation == AiOperation.LESSON_BRIEF;
        return new GenerationPolicy(operation, model, json ? jsonTokens(operation) : properties.getChatMaxOutputTokens(), json ? .1 : 1.0, json ? 1.0 : .95, !json && operation == AiOperation.CHAT && properties.isThinking(), json ? GenerationPolicy.ResponseMode.JSON : GenerationPolicy.ResponseMode.TEXT);
    }
    /** A whole curriculum is far larger than a single extraction, and one taught lesson sits between them. */
    private int jsonTokens(AiOperation operation) {
        return switch (operation) {
            case CURRICULUM -> Math.min(properties.getPredictionMaxOutputTokens(), 6000);
            case LESSON_BRIEF -> Math.min(properties.getPredictionMaxOutputTokens(), 3000);
            // A relevance score per candidate and nothing else; a larger budget would only buy commentary.
            case RERANKING -> 512;
            default -> 2048;
        };
    }
    public GenerationPolicy predictionPolicy(int exerciseCount){return predictionPolicy(exerciseCount,false);}
    public GenerationPolicy predictionPolicy(int exerciseCount,boolean detailed){GenerationPolicy base=policy(AiOperation.CHAT);int perExercise=detailed?800:550;int estimated=800+Math.max(1,exerciseCount)*perExercise;int cap=Math.min(properties.getPredictionMaxOutputTokens(),Math.max(base.maxOutputTokens(),estimated));return new GenerationPolicy(AiOperation.CHAT,base.model(),cap,.15,1,false,GenerationPolicy.ResponseMode.JSON);}
}
