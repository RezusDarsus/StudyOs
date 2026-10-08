package com.studyos.retrieval;

import java.util.List;

public interface RerankerProvider {
    List<HybridRetriever.RetrievedChunk> rerank(String query,List<HybridRetriever.RetrievedChunk> candidates);
    String name();
}
