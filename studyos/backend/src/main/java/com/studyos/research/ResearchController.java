package com.studyos.research;

import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Online research for a workspace. Starting a run is asynchronous — the response carries the run
 * whose status the caller polls — and both endpoints route through the workspace/course aliasing
 * the rest of the API uses, because research belongs to the course knowledge base, not to any one
 * chat or view.
 */
@RestController
@RequestMapping({"/api/workspaces/{courseId}/research", "/api/courses/{courseId}/research"})
public class ResearchController {
    private final ResearchService research;
    private final ResearchRunner runner;
    private final ResearchCoverageService coverage;

    public ResearchController(ResearchService research, ResearchRunner runner, ResearchCoverageService coverage) {
        this.research = research;
        this.runner = runner;
        this.coverage = coverage;
    }

    /** Starts a bounded research run against the stated goal. */
    @PostMapping
    public ResponseEntity<ResearchService.Run> start(@PathVariable UUID courseId, @RequestBody StartRequest request) {
        ResearchService.Run run = research.start(courseId, request.goal(), request.mode());
        runner.run(run.courseId(), run.id(), run.goal(), run.mode());
        return ResponseEntity.accepted().body(run);
    }

    /** The latest run and every source research has brought into this knowledge base. */
    @GetMapping
    public ResearchService.Status status(@PathVariable UUID courseId) {
        return research.status(courseId);
    }

    /** What the collected sources actually cover, per topic, plus the gaps worth researching next. */
    @GetMapping("/coverage")
    public ResearchCoverageService.Coverage coverage(@PathVariable UUID courseId) {
        return coverage.coverage(courseId);
    }

    public record StartRequest(String goal, ResearchMode mode) {}
}
