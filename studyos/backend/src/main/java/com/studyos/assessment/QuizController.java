package com.studyos.assessment;

import java.util.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;

@RestController
@RequestMapping({"/api/courses/{courseId}/quiz", "/api/workspaces/{courseId}/quiz"})
public class QuizController {
    private final QuizService quizzes;
    public QuizController(QuizService quizzes) { this.quizzes=quizzes; }
    @PostMapping
    public ResponseEntity<List<QuizService.Question>> generate(@PathVariable UUID courseId,@Valid @RequestBody GenerateRequest request) { return ResponseEntity.ok(quizzes.generate(courseId,request.topicId(),request.count()==null?3:request.count(),request.difficulty()==null?.5:request.difficulty(),request.mode(),request.activityKind(),request.level())); }
    @PostMapping("/{itemId}/attempts")
    public ResponseEntity<QuizService.Grade> submit(@PathVariable UUID courseId,@PathVariable UUID itemId,@Valid @RequestBody AnswerRequest request) { return ResponseEntity.ok(quizzes.submit(courseId,itemId,request.answer())); }
    @GetMapping("/{itemId}/support")
    public ResponseEntity<QuizService.Support> support(@PathVariable UUID courseId,@PathVariable UUID itemId,@RequestParam(defaultValue="1") @Min(1) @Max(5) int level){return ResponseEntity.ok(quizzes.support(courseId,itemId,level));}
    public record GenerateRequest(UUID topicId,@Min(1) @Max(20) Integer count,@DecimalMin("0.0") @DecimalMax("1.0") Double difficulty,String mode,String activityKind,@Min(1) @Max(6) Integer level) {}
    public record AnswerRequest(@NotBlank String answer) {}
}
