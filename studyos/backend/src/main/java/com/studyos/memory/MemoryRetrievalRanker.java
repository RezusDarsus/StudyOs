package com.studyos.memory;

/** Pure ranking policy: semantic relevance dominates, with bounded importance and recency support. */
public final class MemoryRetrievalRanker {
    private MemoryRetrievalRanker() {}
    public static double score(double semanticSimilarity, double importance, double recency) {
        return .70 * clamp(semanticSimilarity) + .20 * clamp(importance) + .10 * clamp(recency);
    }
    private static double clamp(double value) { return Math.max(0, Math.min(1, value)); }
}
