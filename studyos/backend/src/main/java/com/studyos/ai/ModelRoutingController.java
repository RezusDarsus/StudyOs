package com.studyos.ai;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/ai/model-routing")
public class ModelRoutingController {
    private final ModelRoutingEvaluationService evaluation;
    public ModelRoutingController(ModelRoutingEvaluationService evaluation){this.evaluation=evaluation;}
    @GetMapping public ModelRoutingEvaluationService.Status status(){return evaluation.status();}
}
