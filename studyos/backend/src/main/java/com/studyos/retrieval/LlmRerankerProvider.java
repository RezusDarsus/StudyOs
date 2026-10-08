package com.studyos.retrieval;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.studyos.ai.AiGateway;
import com.studyos.ai.AiOperation;
import com.studyos.ai.AiResult;
import com.studyos.ai.AiUsageService;
import com.studyos.ai.GenerationPolicyRegistry;
import com.studyos.ai.StructuredGenerationException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;

/**
 * Reranks by asking a model how much each candidate helps answer the question, and falls back to term evidence
 * when it cannot.
 *
 * <p>This is the cross-encoder step in a retrieve-then-rerank pipeline: a scorer that reads the query and the
 * passage <em>together</em>, which is what a bi-encoder embedding cannot do — the embedding of a passage is
 * computed once, before any question exists. No cross-encoder checkpoint is reachable through the configured
 * providers, so the chat model plays the role, scoring each candidate on its own so one long passage cannot
 * argue the others down.
 *
 * <p>Off unless {@code studyos.retrieval.llm-reranker} is set, because it spends a model call on every
 * retrieval. When off, when the call fails, and when the reply cannot be read, the deterministic ranker decides
 * the order — a reranker that can fail open is a reranker that can be switched on safely.
 */
@Primary
@Component
public class LlmRerankerProvider implements RerankerProvider {
    private static final Logger log = LoggerFactory.getLogger(LlmRerankerProvider.class);
    /** Enough of a passage to judge relevance from; the whole set has to fit one prompt. */
    private static final int PASSAGE_CHARS = 700;
    private static final int MAX_CANDIDATES = 20;
    /**
     * How far the model may move a candidate. Retrieval's own ordering keeps the rest: the model sees a
     * fragment of each passage and nothing of the course, so it is a better judge of relevance than of what was
     * worth retrieving, and a confident mistake should not be able to bury what both retrieval halves agreed on.
     */
    private static final double MODEL_WEIGHT = .6;
    private static final String SYSTEM = """
            You score how much each passage would help answer a question. Return JSON only, as
            {"scores":[{"id":1,"relevance":0.0}]}, with one entry for every passage id you were given.
            Relevance is 1 when the passage contains what is needed to answer, 0 when it is about something else.
            Judge only that. Do not answer the question, do not rewrite the passages, and do not add ids of your own.""";

    private final RerankerProvider fallback;
    private final AiGateway ai;
    private final AiUsageService usage;
    private final GenerationPolicyRegistry policies;
    private final boolean enabled;

    public LlmRerankerProvider(LexicalRerankerProvider fallback, AiGateway ai, AiUsageService usage, GenerationPolicyRegistry policies,
                               @Value("${studyos.retrieval.llm-reranker:false}") boolean enabled) {
        this.fallback = fallback; this.ai = ai; this.usage = usage; this.policies = policies; this.enabled = enabled;
    }

    @Override
    public List<HybridRetriever.RetrievedChunk> rerank(String query, List<HybridRetriever.RetrievedChunk> candidates) {
        List<HybridRetriever.RetrievedChunk> baseline = fallback.rerank(query, candidates);
        if (!enabled || baseline.size() < 2 || query == null || query.isBlank()) return baseline;
        List<HybridRetriever.RetrievedChunk> judged = baseline.subList(0, Math.min(MAX_CANDIDATES, baseline.size()));
        long started = System.nanoTime();
        AiResult<Scores> result = null;
        boolean success = false;
        try {
            result = ai.generateStructuredResult(SYSTEM, prompt(query, judged), Scores.class, policies.policy(AiOperation.RERANKING));
            Map<Integer, Double> relevance = relevance(result.value(), judged.size());
            success = true;
            if (relevance.isEmpty()) return baseline;
            List<HybridRetriever.RetrievedChunk> ordered = new ArrayList<>(baseline.size());
            for (int index : merge(judged.size(), relevance)) ordered.add(judged.get(index));
            ordered.addAll(baseline.subList(judged.size(), baseline.size()));
            return List.copyOf(ordered);
        } catch (RuntimeException error) {
            if (error instanceof StructuredGenerationException structured) result = structured.telemetryResult();
            log.warn("Reranking model call failed; term ranking retained: {}", message(error));
            return baseline;
        } finally {
            usage.record(AiOperation.RERANKING, result, null, null, null, (System.nanoTime() - started) / 1_000_000, success);
        }
    }

    @Override public String name() { return enabled ? "llm-pointwise-v1+" + fallback.name() : fallback.name(); }

    /** Ids are one-based positions in the prompt, so a reply that invents one is recognisable as out of range. */
    private String prompt(String query, List<HybridRetriever.RetrievedChunk> candidates) {
        StringBuilder prompt = new StringBuilder("QUESTION: ").append(query.strip()).append("\n\n");
        for (int index = 0; index < candidates.size(); index++) {
            prompt.append("PASSAGE ").append(index + 1).append('\n').append(trim(candidates.get(index).contextualContent())).append("\n\n");
        }
        return prompt.toString();
    }

    /** Zero-based candidate positions to the score they were given, ignoring anything unusable. */
    private static Map<Integer, Double> relevance(Scores scores, int count) {
        Map<Integer, Double> relevance = new LinkedHashMap<>();
        if (scores == null) return relevance;
        for (Score score : scores.scores()) {
            int index = score.id() - 1;
            if (index < 0 || index >= count || !Double.isFinite(score.relevance())) continue;
            relevance.putIfAbsent(index, Math.max(0, Math.min(1, score.relevance())));
        }
        return relevance;
    }

    /**
     * The final order over the first {@code count} candidates, best first. A candidate the model did not score
     * keeps the position term evidence gave it; a candidate it did score is moved from there by at most
     * {@link #MODEL_WEIGHT}. Ties keep the order they came in, so this is a reordering and never a filter —
     * every candidate given is returned.
     */
    static List<Integer> merge(int count, Map<Integer, Double> relevance) {
        List<Integer> order = new ArrayList<>();
        for (int index = 0; index < count; index++) order.add(index);
        if (count < 2) return List.copyOf(order);
        return order.stream().sorted(Comparator.comparingDouble((Integer index) -> {
            double positional = 1 - (double) index / (count - 1);
            Double scored = relevance.get(index);
            return scored == null ? positional : MODEL_WEIGHT * scored + (1 - MODEL_WEIGHT) * positional;
        }).reversed()).toList();
    }

    private static String trim(String value) { return value.length() <= PASSAGE_CHARS ? value : value.substring(0, PASSAGE_CHARS); }
    private static String message(Throwable error) { String value = error.getMessage(); return value == null ? error.getClass().getSimpleName() : value.substring(0, Math.min(300, value.length())); }

    public record Scores(List<Score> scores) {
        @JsonCreator public Scores(@JsonProperty("scores") List<Score> scores) { this.scores = scores == null ? List.of() : scores; }
    }
    public record Score(int id, double relevance) {
        @JsonCreator public Score(@JsonProperty("id") int id, @JsonProperty("relevance") double relevance) { this.id = id; this.relevance = relevance; }
    }
}
