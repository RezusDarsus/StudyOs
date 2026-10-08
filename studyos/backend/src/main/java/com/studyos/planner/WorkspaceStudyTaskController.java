package com.studyos.planner;

import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/workspaces/{workspaceId}/study-tasks")
public class WorkspaceStudyTaskController {
    private final StudyPlanService plans;
    public WorkspaceStudyTaskController(StudyPlanService plans){this.plans=plans;}
    @GetMapping("/{taskId}")
    public ResponseEntity<StudyPlanService.TaskDetails> details(@PathVariable UUID workspaceId,@PathVariable UUID taskId){return ResponseEntity.ok(plans.details(taskId,workspaceId));}
}
