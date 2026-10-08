package com.studyos.retrieval;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/ai/embedding-cache")
public class EmbeddingCacheController {
    private final EmbeddingCacheService cache;
    public EmbeddingCacheController(EmbeddingCacheService cache){this.cache=cache;}
    @GetMapping public EmbeddingCacheService.Stats stats(){return cache.stats();}
    @PostMapping("/backfill") public EmbeddingCacheService.BackfillResult backfill(){return cache.backfillExistingChunks();}
}
