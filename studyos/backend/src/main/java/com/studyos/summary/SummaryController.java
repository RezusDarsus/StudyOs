package com.studyos.summary;

import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping({"/api/courses/{courseId}/summaries", "/api/workspaces/{courseId}/summaries"})
public class SummaryController {
    private final SummaryService summaries;
    public SummaryController(SummaryService summaries) { this.summaries = summaries; }
    @GetMapping public List<SummaryService.SummaryView> list(@PathVariable UUID courseId) { return summaries.list(courseId); }
    @PostMapping("/rebuild") public ResponseEntity<Void> rebuild(@PathVariable UUID courseId) { summaries.rebuild(courseId); return ResponseEntity.accepted().build(); }
}
