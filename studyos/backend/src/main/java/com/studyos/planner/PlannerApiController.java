package com.studyos.planner;

import java.time.LocalDate;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

@RestController
@RequestMapping({"/api/courses/{courseId}/study-plans", "/api/workspaces/{courseId}/study-plans"})
public class PlannerApiController {
    private final StudyPlanService plans;
    public PlannerApiController(StudyPlanService plans) { this.plans = plans; }
    @PostMapping("/generate")
    public ResponseEntity<StudyPlanService.Plan> generate(@PathVariable UUID courseId, @Valid @RequestBody GenerateRequest request) {
        return ResponseEntity.ok(plans.generate(courseId, request.date() == null ? LocalDate.now() : request.date(), request.availableMinutes() == null ? 120 : request.availableMinutes()));
    }
    public record GenerateRequest(UUID examId, LocalDate date, @Min(15) @Max(480) Integer availableMinutes) {}
}
