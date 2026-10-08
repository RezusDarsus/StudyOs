package com.studyos.retrieval;

import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/debug/retrieval", "/api/workspaces/{courseId}/debug/retrieval"})
public class RetrievalDebugController {
    private final HybridRetriever retriever;
    public RetrievalDebugController(HybridRetriever retriever) { this.retriever = retriever; }
    @PostMapping
    public ResponseEntity<HybridRetriever.RetrievalDebug> debug(@PathVariable UUID courseId, @RequestBody Request request) {
        if (request.query() == null || request.query().isBlank()) return ResponseEntity.badRequest().build();
        return ResponseEntity.ok(retriever.debug(courseId, request.query(), Math.max(1, Math.min(request.limit() == null ? 8 : request.limit(), 20))));
    }
    public record Request(String query, Integer limit) {}
}
