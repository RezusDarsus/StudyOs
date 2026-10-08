package com.studyos.retrieval;

import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Reranks by term evidence alone — no model call, no latency, no cost — using {@link RelevanceScorer}.
 *
 * <p>Scores against the chunk together with the document and section it belongs to, because that context is
 * what retrieval matched on and demoting a chunk for lacking words its own heading supplied would undo the
 * match that found it.
 */
@Component
public class LexicalRerankerProvider implements RerankerProvider {
    @Override
    public List<HybridRetriever.RetrievedChunk> rerank(String query, List<HybridRetriever.RetrievedChunk> candidates) {
        if (candidates == null || candidates.size() < 2) return candidates == null ? List.of() : candidates;
        List<String> documents = candidates.stream().map(HybridRetriever.RetrievedChunk::contextualContent).toList();
        List<Double> scores = candidates.stream().map(HybridRetriever.RetrievedChunk::score).toList();
        List<HybridRetriever.RetrievedChunk> ordered = new ArrayList<>(candidates.size());
        for (int index : RelevanceScorer.rank(query, documents, scores)) ordered.add(candidates.get(index));
        return List.copyOf(ordered);
    }

    @Override public String name() { return "bm25-proximity-v2"; }
}
