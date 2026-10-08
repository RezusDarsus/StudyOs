package com.studyos.assessment;

import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/misconceptions", "/api/workspaces/{courseId}/misconceptions"})
public class MisconceptionController {
    private final MisconceptionService misconceptions;
    public MisconceptionController(MisconceptionService misconceptions) { this.misconceptions = misconceptions; }
    @GetMapping public List<MisconceptionService.View> active(@PathVariable UUID courseId) { return misconceptions.active(courseId); }

    /**
     * What the graders proposed and what survived. The rejected candidates are the point: without this read, a
     * grading model naming concepts the learner never wrote is invisible, because the only trace it used to leave
     * was the misconception it created.
     */
    @GetMapping("/evidence") public MisconceptionService.Audit evidence(@PathVariable UUID courseId, @RequestParam(defaultValue = "50") int limit) { return misconceptions.audit(courseId, limit); }
}
