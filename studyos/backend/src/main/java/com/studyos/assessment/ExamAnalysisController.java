package com.studyos.assessment;

import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/exam-analysis", "/api/workspaces/{courseId}/exam-analysis"})
public class ExamAnalysisController {
    private final AssessmentExtractionService extraction;
    private final ExamAnalysisService analysis;

    public ExamAnalysisController(AssessmentExtractionService extraction, ExamAnalysisService analysis) { this.extraction = extraction; this.analysis = analysis; }

    @GetMapping
    public ResponseEntity<List<ExamAnalysisService.Signal>> list(@PathVariable UUID courseId) { return ResponseEntity.ok(analysis.list(courseId)); }

    @PostMapping("/rebuild")
    public ResponseEntity<RebuildResult> rebuild(@PathVariable UUID courseId) { int items = extraction.rebuild(courseId); analysis.rebuild(courseId); return ResponseEntity.ok(new RebuildResult(items, analysis.list(courseId).size())); }

    public record RebuildResult(int extractedAssessmentItems, int analyzedTopics) {}
}
