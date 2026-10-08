package com.studyos.prediction;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

/** Import + inspection surface for dedicated prediction-benchmark workspaces. */
@RestController
@RequestMapping("/api/prediction-benchmark")
public class PredictionBenchmarkController {
    private final PredictionBenchmarkService benchmark;

    public PredictionBenchmarkController(PredictionBenchmarkService benchmark) { this.benchmark = benchmark; }

    @PostMapping("/import")
    public PredictionBenchmarkService.ImportResult importCorpus(@RequestBody PredictionBenchmarkService.ImportRequest request) {
        return benchmark.importCorpus(request);
    }

    @GetMapping("/manifests")
    public List<Map<String, Object>> manifests() { return benchmark.manifests(); }
}
