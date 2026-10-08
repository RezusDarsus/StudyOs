package com.studyos.prediction;

import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping({"/api/courses/{courseId}/predictions", "/api/workspaces/{courseId}/predictions"})
public class PredictionController {
    private final PredictionService predictions;
    public PredictionController(PredictionService predictions) { this.predictions = predictions; }
    @GetMapping public PredictionService.Forecast forecast(@PathVariable UUID courseId) { return predictions.forecast(courseId); }
}
