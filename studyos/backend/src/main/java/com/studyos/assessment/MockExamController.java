package com.studyos.assessment;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/workspaces/{workspaceId}/mock-exams")
public class MockExamController {
    private final MockExamService exams;public MockExamController(MockExamService exams){this.exams=exams;}
    @PostMapping public ResponseEntity<MockExamService.MockExam> create(@PathVariable UUID workspaceId,@Valid @RequestBody(required=false) CreateRequest request){CreateRequest value=request==null?new CreateRequest(null,null):request;return ResponseEntity.ok(exams.create(workspaceId,value.count()==null?5:value.count(),value.estimatedMinutes()==null?90:value.estimatedMinutes()));}
    @GetMapping public List<MockExamService.MockExam> list(@PathVariable UUID workspaceId){return exams.list(workspaceId);}
    @GetMapping("/{examId}") public MockExamService.MockExam get(@PathVariable UUID workspaceId,@PathVariable UUID examId){return exams.get(workspaceId,examId);}
    @PostMapping("/{examId}/start") public MockExamService.MockExam start(@PathVariable UUID workspaceId,@PathVariable UUID examId){return exams.start(workspaceId,examId);}
    @PostMapping("/{examId}/complete") public MockExamService.MockExam complete(@PathVariable UUID workspaceId,@PathVariable UUID examId){return exams.complete(workspaceId,examId);}
    public record CreateRequest(@Min(2) @Max(12) Integer count,@Min(15) @Max(240) Integer estimatedMinutes){}
}
