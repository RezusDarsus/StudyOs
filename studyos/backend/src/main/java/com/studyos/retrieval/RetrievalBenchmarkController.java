package com.studyos.retrieval;

import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/retrieval", "/api/workspaces/{courseId}/retrieval"})
public class RetrievalBenchmarkController {
    private final HybridRetriever retriever;
    public RetrievalBenchmarkController(HybridRetriever retriever) { this.retriever = retriever; }

    @PostMapping("/benchmark")
    public BenchmarkResult benchmark(@PathVariable UUID courseId, @RequestBody BenchmarkRequest request) {
        List<CaseResult> cases = new ArrayList<>();
        for (Case test : request.cases() == null ? List.<Case>of() : request.cases()) {
            HybridRetriever.RetrievalDebug debug = retriever.debug(courseId, test.question(), 10);
            cases.add(new CaseResult(score(debug.lexical(), test), score(debug.vector(), test), score(debug.fused(), test),score(debug.selected(), test)));
        }
        return new BenchmarkResult(cases.size(), aggregate(cases, 0), aggregate(cases, 1), aggregate(cases, 2),aggregate(cases,3));
    }

    private Metrics aggregate(List<CaseResult> cases, int mode) {
        if (cases.isEmpty()) return new Metrics(0,0,0,0,0);
        double r5 = cases.stream().mapToDouble(value -> metric(value, mode).recallAt5()).average().orElse(0);
        double r10 = cases.stream().mapToDouble(value -> metric(value, mode).recallAt10()).average().orElse(0);
        double mrr = cases.stream().mapToDouble(value -> metric(value, mode).mrr()).average().orElse(0);
        double precision=cases.stream().mapToDouble(value->metric(value,mode).contextPrecision()).average().orElse(0);
        double citations=cases.stream().mapToDouble(value->metric(value,mode).citationCorrectness()).average().orElse(0);
        return new Metrics(r5,r10,mrr,precision,citations);
    }
    private Metrics metric(CaseResult result, int mode) { return mode == 0 ? result.lexical() : mode == 1 ? result.vector() : mode==2?result.hybrid():result.hybridReranked(); }
    private Metrics score(List<HybridRetriever.RetrievedChunk> results, Case test) {
        int first = 0; boolean hit5 = false; boolean hit10 = false;
        int relevant=0;for (int i=0;i<results.size();i++) if (matches(results.get(i), test)) {relevant++; if (first == 0) first = i + 1; if (i < 5) hit5 = true; if (i < 10) hit10 = true; }
        int inspected=Math.min(10,results.size());double precision=inspected==0?0:(double)relevant/inspected;double citation=first==0?0:hasValidProvenance(results.get(first-1))?1:0;
        return new Metrics(hit5 ? 1 : 0, hit10 ? 1 : 0, first == 0 ? 0 : 1.0 / first,precision,citation);
    }
    private boolean matches(HybridRetriever.RetrievedChunk chunk, Case test) {
        boolean chunkMatch=test.relevantChunkIds()!=null&&!test.relevantChunkIds().isEmpty()&&test.relevantChunkIds().contains(chunk.id());
        boolean document = test.expectedDocumentId() == null || test.expectedDocumentId().equals(chunk.documentId());
        boolean page = test.expectedPages() == null || test.expectedPages().isEmpty() || test.expectedPages().stream().anyMatch(value -> value >= chunk.pageStart() && value <= chunk.pageEnd());
        return chunkMatch||document && page;
    }
    private boolean hasValidProvenance(HybridRetriever.RetrievedChunk chunk){return chunk.documentId()!=null&&chunk.documentName()!=null&&!chunk.documentName().isBlank()&&chunk.pageStart()>0&&chunk.pageEnd()>=chunk.pageStart();}

    public record BenchmarkRequest(List<Case> cases) {}
    public record Case(String question,UUID expectedDocumentId,List<Integer> expectedPages,List<UUID> relevantChunkIds) {}
    public record Metrics(double recallAt5,double recallAt10,double mrr,double contextPrecision,double citationCorrectness) {}
    private record CaseResult(Metrics lexical,Metrics vector,Metrics hybrid,Metrics hybridReranked) {}
    public record BenchmarkResult(int sampleCount,Metrics lexical,Metrics vector,Metrics hybrid,Metrics hybridReranked) {}
}
