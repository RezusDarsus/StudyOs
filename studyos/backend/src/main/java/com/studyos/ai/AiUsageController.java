package com.studyos.ai;

import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/usage", "/api/workspaces/{courseId}/usage"})
public class AiUsageController {
    private final AiUsageService usage;
    public AiUsageController(AiUsageService usage) { this.usage = usage; }
    @GetMapping("/summary") public AiUsageService.UsageSummary summary(@PathVariable UUID courseId) { return usage.summary(courseId); }
}
