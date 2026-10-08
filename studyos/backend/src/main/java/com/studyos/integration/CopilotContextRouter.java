package com.studyos.integration;

import java.util.List;
import java.util.UUID;

public final class CopilotContextRouter {
    private CopilotContextRouter(){}
    public static Route route(UUID workspaceId,String goalType){boolean study=workspaceId!=null||"STUDY".equalsIgnoreCase(goalType);return study?new Route("STUDYOS","StudyOS Engine",List.of("WHAT_TO_STUDY_NEXT","EXPLAIN_WEAKEST_TOPIC","QUIZ_ME","NEW_EXERCISE","READINESS_WHY","MOCK_EXAM")):new Route("GENERAL_GOAL","Goalify Copilot Engine",List.of("MAKE_EASIER","FALLING_BEHIND_WHY","CHANGE_SCHEDULE"));}
    public record Route(String context,String backend,List<String> availableActions){}
}
