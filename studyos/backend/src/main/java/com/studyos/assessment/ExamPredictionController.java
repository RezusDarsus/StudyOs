package com.studyos.assessment;

import com.studyos.prediction.PredictionBacktestService;
import com.studyos.prediction.WeightSensitivity;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/workspaces/{workspaceId}/exam-predictions")
public class ExamPredictionController {
    private final ExamPredictionService predictions;
    private final PredictionBacktestService backtest;
    public ExamPredictionController(ExamPredictionService predictions, PredictionBacktestService backtest){this.predictions=predictions;this.backtest=backtest;}
    @GetMapping public ExamPredictionService.PredictionReport get(@PathVariable UUID workspaceId){return predictions.predict(workspaceId);}

    /** Engineering view: runs a fresh walk-forward backtest, persists it as a new run, returns it. */
    @GetMapping("/backtest")
    public PredictionBacktestService.BacktestReport backtest(@PathVariable UUID workspaceId,
                                                             @RequestParam(required = false) String fixtureHash) {
        return backtest.backtest(workspaceId, fixtureHash);
    }

    /** Previously persisted backtest runs, newest first. History is never rewritten. */
    @GetMapping("/backtest/runs")
    public List<Map<String, Object>> runs(@PathVariable UUID workspaceId) {
        return backtest.runs(workspaceId);
    }

    /** Bounded weight-sensitivity grids over the same held-out folds: measurement, not tuning. */
    @PostMapping("/sensitivity")
    public WeightSensitivity.SensitivityReport sensitivity(@PathVariable UUID workspaceId) {
        return backtest.sensitivity(workspaceId);
    }

    /** The V2 candidate's own bounded grids: measured on the same folds, adopted by nothing here. */
    @PostMapping("/sensitivity/v2")
    public WeightSensitivity.V2SensitivityReport v2Sensitivity(@PathVariable UUID workspaceId) {
        return backtest.v2Sensitivity(workspaceId);
    }

    /** The data-requirement verdict for touching weights on this course's history size. */
    @GetMapping("/fitting-policy")
    public Map<String, String> fittingPolicy(@PathVariable UUID workspaceId) {
        return Map.of("verdict", backtest.fittingPolicyVerdict(workspaceId));
    }

    /** Registered model versions (global + course-scoped), newest first. */
    @GetMapping("/model-versions")
    public List<Map<String, Object>> modelVersions(@PathVariable UUID workspaceId) {
        return backtest.modelVersions(workspaceId);
    }

    /** Deliberate, explicit registration of a model version; never implicit. */
    public record RegisterModelRequest(String modelVersion, ExamRelevanceCalculator.Weights weights,
                                       String basis, Object metrics, String corpusSummary) {}

    @PostMapping("/model-versions")
    public Map<String, Object> registerModel(@PathVariable UUID workspaceId, @RequestBody RegisterModelRequest request) {
        UUID id = backtest.registerModelVersion(workspaceId, request.modelVersion(), request.weights(),
                request.basis(), request.metrics(), request.corpusSummary());
        return Map.of("id", id.toString());
    }
}
