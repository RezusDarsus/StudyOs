package com.studyos.evaluation;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/quality-harness")
public class QualityHarnessController {
    private final QualityHarnessService harness;public QualityHarnessController(QualityHarnessService harness){this.harness=harness;}
    @PostMapping("/deterministic") public QualityHarnessService.Report run(){return harness.run();}
}
