package com.studyos.mastery;

import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/mastery", "/api/workspaces/{courseId}/mastery"})
public class MasteryController {
    private final MasteryService mastery;
    public MasteryController(MasteryService mastery) { this.mastery = mastery; }
    @GetMapping public java.util.List<MasteryService.TopicState> list(@PathVariable UUID courseId) { return mastery.list(courseId); }
}
