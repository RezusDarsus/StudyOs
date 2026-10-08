package com.studyos.chat;

import org.springframework.stereotype.Component;

@Component
public class ContextPolicyRegistry {
    public ContextProfile profile(QueryIntent intent) {
        return switch (intent) {
            case FACTUAL_QA -> new ContextProfile(false,false,false,false,false,false,4,4,2800);
            case EXPLAIN_TOPIC -> new ContextProfile(true,false,false,true,false,true,6,6,4200);
            case HOMEWORK_HELP -> new ContextProfile(false,true,false,true,false,true,8,6,4200);
            case HARD_NEW -> new ContextProfile(false,false,false,false,false,false,0,0,0);
            case REVIEW_MISTAKES -> new ContextProfile(false,true,false,true,true,true,4,3,2200);
            case STUDY_PLAN -> new ContextProfile(true,false,true,true,true,true,2,0,0);
            case EXAM_ANALYSIS -> new ContextProfile(true,true,true,true,true,true,2,12,7500);
            case EXAM_PREDICTION -> new ContextProfile(false,false,false,false,false,false,2,12,6000);
            case QUIZ_GENERATION -> new ContextProfile(true,true,false,true,true,true,6,6,4200);
        };
    }
}
