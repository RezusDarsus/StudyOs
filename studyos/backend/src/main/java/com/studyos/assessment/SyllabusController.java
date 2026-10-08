package com.studyos.assessment;

import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/workspaces/{workspaceId}/syllabus")
public class SyllabusController {
    private final SyllabusService syllabus;public SyllabusController(SyllabusService syllabus){this.syllabus=syllabus;}
    @GetMapping public SyllabusService.SyllabusView get(@PathVariable UUID workspaceId){return syllabus.get(workspaceId);}
}
