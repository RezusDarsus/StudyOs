package com.studyos.planner;

import java.time.LocalDate;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

@RestController
@RequestMapping({"/api/courses/{courseId}/study-plan", "/api/workspaces/{courseId}/study-plan"})
public class StudyPlanController {
    private final StudyPlanService plans;
    public StudyPlanController(StudyPlanService plans){this.plans=plans;}
    @GetMapping public ResponseEntity<StudyPlanService.Plan> current(@PathVariable UUID courseId,@RequestParam(required=false) LocalDate date){return ResponseEntity.ok(plans.current(courseId,date==null?LocalDate.now():date));}
    @PostMapping public ResponseEntity<StudyPlanService.Plan> generate(@PathVariable UUID courseId,@Valid @RequestBody Request request){return ResponseEntity.ok(plans.generate(courseId,request.date()==null?LocalDate.now():request.date(),request.availableMinutes()==null?120:request.availableMinutes()));}
    public record Request(LocalDate date,@Min(15) @Max(480) Integer availableMinutes){}
}
