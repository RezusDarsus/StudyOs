package com.studyos.learning;

import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/learning-events", "/api/workspaces/{courseId}/learning-evidence"})
public class LearningController {
    private final LearningService learning;
    public LearningController(LearningService learning) { this.learning=learning; }
    @GetMapping public java.util.List<LearningService.Event> list(@PathVariable UUID courseId) { return learning.list(courseId); }
    @PostMapping public ResponseEntity<Void> record(@PathVariable UUID courseId,@RequestBody LearningService.EventRequest request){ learning.record(courseId,request); return ResponseEntity.accepted().build(); }
}
