package com.studyos.knowledge;

import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/topic-capsules", "/api/workspaces/{courseId}/topic-capsules"})
public class TopicCapsuleController {
    private final TopicCapsuleService capsules;
    public TopicCapsuleController(TopicCapsuleService capsules) { this.capsules = capsules; }
    @GetMapping public List<TopicCapsuleService.Capsule> list(@PathVariable UUID courseId) { return capsules.list(courseId); }
    @GetMapping("/{topicId}") public TopicCapsuleService.Capsule get(@PathVariable UUID courseId, @PathVariable UUID topicId) { return capsules.get(courseId, topicId); }
}
