package com.studyos.curriculum;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/curriculum", "/api/workspaces/{courseId}/curriculum"})
public class CurriculumController {
    private final CurriculumService curricula;
    private final LessonBriefService briefs;
    private final CurriculumIntegrityService integrity;
    private final CoursePacingService pacing;
    private final CurriculumReplanService replanning;
    public CurriculumController(CurriculumService curricula, LessonBriefService briefs, CurriculumIntegrityService integrity,
                                CoursePacingService pacing, CurriculumReplanService replanning) {
        this.curricula = curricula; this.briefs = briefs; this.integrity = integrity; this.pacing = pacing; this.replanning = replanning;
    }

    /** The workspace's curriculum, building one on first use. */
    @GetMapping
    public ResponseEntity<CurriculumService.Curriculum> get(@PathVariable UUID courseId) {
        CurriculumService.Curriculum curriculum = curricula.active(courseId);
        return curriculum == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(curriculum);
    }

    /** Builds a curriculum, replacing any existing one. */
    @PostMapping
    public ResponseEntity<CurriculumService.Curriculum> generate(@PathVariable UUID courseId, @Valid @RequestBody(required = false) GenerateRequest request) {
        return ResponseEntity.ok(curricula.generate(courseId, request == null ? null : request.goal()));
    }

    /** What is unlocked right now, what is blocking the rest, and how much is covered. */
    @GetMapping("/frontier")
    public ResponseEntity<CurriculumService.Frontier> frontier(@PathVariable UUID courseId) {
        return ResponseEntity.ok(curricula.frontier(courseId));
    }

    /** Deterministic integrity findings for the active curriculum. */
    @GetMapping("/integrity")
    public ResponseEntity<CurriculumIntegrityValidator.Report> integrity(@PathVariable UUID courseId) {
        CurriculumIntegrityValidator.Report report = integrity.validateActive(courseId);
        return report == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(report);
    }

    /** Applies the safe deterministic repairs, then re-validates. */
    @PostMapping("/integrity/repair")
    public CurriculumIntegrityService.RepairResult repairIntegrity(@PathVariable UUID courseId) {
        return integrity.repair(courseId);
    }

    /**
     * The week-by-week plan for the time that is actually left. Always computed from live mastery,
     * so a missed week or a fast learner changes the very next plan.
     */
    @GetMapping("/pacing")
    public CoursePacingPlanner.Plan pacing(@PathVariable UUID courseId,
                                           @RequestParam(required = false) Integer minutesPerDay,
                                           @RequestParam(required = false) Integer daysPerWeek) {
        return pacing.pace(courseId, minutesPerDay, daysPerWeek);
    }

    /** Whether evidence has moved on since the plan was made, and why. */
    @GetMapping("/replan/suggestions")
    public CurriculumReplanService.Suggestion replanSuggestions(@PathVariable UUID courseId) {
        return replanning.suggest(courseId);
    }

    /** Records a new revision with its reason and applies the safe repairs. */
    @PostMapping("/replan")
    public CurriculumReplanService.RevisionResult replan(@PathVariable UUID courseId, @RequestBody(required = false) ReplanRequest request) {
        return replanning.replan(courseId, request == null ? null : request.reason());
    }

    public record ReplanRequest(String reason) {}


    /** One lesson's teaching content, written from the material the first time it is opened. */
    @GetMapping("/lessons/{lessonId}/brief")
    public ResponseEntity<LessonBriefComposer.Brief> brief(@PathVariable UUID courseId, @PathVariable UUID lessonId) {
        return ResponseEntity.ok(briefs.brief(courseId, lessonId));
    }

    /** Rewrites the lesson, which is what a student wants after uploading the notes it was missing. */
    @PostMapping("/lessons/{lessonId}/brief")
    public ResponseEntity<LessonBriefComposer.Brief> regenerateBrief(@PathVariable UUID courseId, @PathVariable UUID lessonId) {
        return ResponseEntity.ok(briefs.brief(courseId, lessonId, true));
    }

    /** The same lesson as plain text, for reading in one piece or copying out. */
    @GetMapping(value = "/lessons/{lessonId}/brief/text", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseEntity<String> briefText(@PathVariable UUID courseId, @PathVariable UUID lessonId) {
        return ResponseEntity.ok(briefs.markdown(courseId, lessonId));
    }

    public record GenerateRequest(@Size(max = 2000) String goal) {}
}
