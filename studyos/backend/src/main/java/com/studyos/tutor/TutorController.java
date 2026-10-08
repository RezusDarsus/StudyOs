package com.studyos.tutor;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/tutor", "/api/workspaces/{courseId}/tutor"})
public class TutorController {
    private final TutorService tutor;
    private final ExamModeService examMode;
    public TutorController(TutorService tutor, ExamModeService examMode) { this.tutor = tutor; this.examMode = examMode; }

    /** Today's proposed session: ordered steps, minutes, and where readiness is expected to land. */
    @GetMapping("/today")
    public ResponseEntity<TutorService.Today> today(@PathVariable UUID courseId,
                                                    @RequestParam(required = false) @Min(5) @Max(480) Integer minutes) {
        return ResponseEntity.ok(tutor.today(courseId, minutes));
    }

    /** Exam-mode plan for today: bounded blocks with machine-readable reasons for every choice. */
    @GetMapping("/exam-mode")
    public ExamModePlanner.Plan examMode(@PathVariable UUID courseId,
                                         @RequestParam(required = false) @Min(20) @Max(480) Integer minutes) {
        return examMode.today(courseId, minutes);
    }

    /** Starts today's session so the student can work through it step by step. */
    @PostMapping("/sessions")
    public ResponseEntity<TutorService.Session> start(@PathVariable UUID courseId, @Valid @RequestBody(required = false) StartRequest request) {
        return ResponseEntity.ok(tutor.start(courseId, request == null ? null : request.minutes()));
    }

    @GetMapping("/sessions")
    public List<TutorService.Session> list(@PathVariable UUID courseId) { return tutor.list(courseId); }

    @GetMapping("/sessions/{sessionId}")
    public ResponseEntity<TutorService.Session> get(@PathVariable UUID courseId, @PathVariable UUID sessionId) {
        return ResponseEntity.ok(tutor.session(courseId, sessionId));
    }

    /** Records the outcome of one step and hands back the session with the next step selected. */
    @PostMapping("/sessions/{sessionId}/steps/{ordinal}/advance")
    public ResponseEntity<TutorService.Session> advance(@PathVariable UUID courseId, @PathVariable UUID sessionId,
                                                        @PathVariable int ordinal, @Valid @RequestBody(required = false) AdvanceRequest request) {
        AdvanceRequest value = request == null ? new AdvanceRequest(null, null, null) : request;
        return ResponseEntity.ok(tutor.advance(courseId, sessionId, ordinal, value.score(), value.minutes(), Boolean.TRUE.equals(value.skipped())));
    }

    @PostMapping("/sessions/{sessionId}/complete")
    public ResponseEntity<TutorService.Session> complete(@PathVariable UUID courseId, @PathVariable UUID sessionId) {
        return ResponseEntity.ok(tutor.complete(courseId, sessionId));
    }

    public record StartRequest(@Min(5) @Max(480) Integer minutes) {}
    public record AdvanceRequest(@Min(0) @Max(1) Double score, @Min(1) @Max(480) Integer minutes, Boolean skipped) {}
}
