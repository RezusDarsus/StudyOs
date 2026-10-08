package com.studyos.integration;

import com.studyos.planner.StudyPlanService;
import com.studyos.workspaces.LearningObjective;
import com.studyos.workspaces.WorkspaceType;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/integrations/goalify")
public class GoalifyIntegrationController {
    private final GoalifyIntegrationService goalify;public GoalifyIntegrationController(GoalifyIntegrationService goalify){this.goalify=goalify;}
    @PostMapping("/detect-learning-goal") public LearningGoalDetector.Result detect(@RequestBody GoalText request){return LearningGoalDetector.detect(request.title(),request.description());}
    @PostMapping("/activate") public GoalifyIntegrationService.Activation activate(@Valid @RequestBody ActivationRequest request){return goalify.activate(new GoalifyIntegrationService.ActivationCommand(request.userId(),request.goalifyGoalId(),request.title(),request.description(),request.enabled()==null||request.enabled(),request.workspaceType(),request.objective(),request.targetDate(),request.examDate()));}
    @GetMapping("/workspaces/{workspaceId}/recommendations") public GoalifyIntegrationService.RecommendationEnvelope recommendations(@PathVariable UUID workspaceId,@RequestParam(defaultValue="120") @Min(10) @Max(480) int availableMinutes,@RequestParam(required=false) LocalDate date){return goalify.recommendations(workspaceId,availableMinutes,date==null?LocalDate.now():date);}
    @PostMapping("/workspaces/{workspaceId}/task-links") public GoalifyIntegrationService.TaskLink link(@PathVariable UUID workspaceId,@Valid @RequestBody LinkRequest request){return goalify.link(workspaceId,request.studyTaskId(),request.goalifyGoalId(),request.goalifyTaskId());}
    @PostMapping("/workspaces/{workspaceId}/task-completions/{studyTaskId}") public StudyPlanService.Completion complete(@PathVariable UUID workspaceId,@PathVariable UUID studyTaskId,@RequestBody(required=false) CompletionRequest request){CompletionRequest value=request==null?new CompletionRequest(null,true,null):request;return goalify.completion(workspaceId,studyTaskId,value.actualMinutes(),value.completed()==null||value.completed(),value.feedback());}
    @GetMapping("/workspaces/{workspaceId}/social-progress") public GoalifyIntegrationService.SocialProgress social(@PathVariable UUID workspaceId){return goalify.socialProgress(workspaceId);}
    @PostMapping("/copilot/route") public CopilotContextRouter.Route route(@RequestBody CopilotRequest request){return CopilotContextRouter.route(request.workspaceId(),request.goalType());}
    public record GoalText(String title,String description){}
    public record ActivationRequest(UUID userId,@NotNull UUID goalifyGoalId,@NotBlank String title,String description,Boolean enabled,WorkspaceType workspaceType,LearningObjective objective,LocalDate targetDate,LocalDate examDate){}
    public record LinkRequest(UUID studyTaskId,UUID goalifyGoalId,UUID goalifyTaskId){}
    public record CompletionRequest(Integer actualMinutes,Boolean completed,String feedback){}
    public record CopilotRequest(UUID workspaceId,String goalType){}
}
