package com.studyos.planner;

import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import jakarta.validation.Valid;

@RestController
@RequestMapping("/api/study-tasks")
public class StudyTaskController {
    private final StudyPlanService plans;
    public StudyTaskController(StudyPlanService plans) { this.plans = plans; }
    @GetMapping("/{taskId}")
    public ResponseEntity<StudyPlanService.TaskDetails> details(@PathVariable UUID taskId){return ResponseEntity.ok(plans.details(taskId,null));}
    @PostMapping("/{taskId}/complete")
    public ResponseEntity<StudyPlanService.Completion> complete(@PathVariable UUID taskId, @Valid @RequestBody CompletionRequest request) {
        return ResponseEntity.ok(plans.complete(taskId, request.actualMinutes(), request.completed() == null || request.completed(), request.score(), request.difficultyReported(), request.studentFeedback()));
    }
    public record CompletionRequest(Integer actualMinutes, Boolean completed, Double score, Double difficultyReported, String studentFeedback) {}
}
