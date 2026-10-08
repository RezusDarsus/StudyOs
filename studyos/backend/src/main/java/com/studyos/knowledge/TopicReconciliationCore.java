package com.studyos.knowledge;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Pure, staged identity comparison between two candidate topics.
 *
 * <p>The ladder runs from cheapest and safest to most expensive: exact normalized match, known
 * alias, safe lexical similarity, embedding similarity, source-context overlap. An LLM verdict is
 * never produced here — the core only ever says {@link ReconciliationDecision#AMBIGUOUS} so the
 * service layer can spend a bounded verification call on the few pairs that deserve one.
 *
 * <p>The thresholds are deliberately conservative: a false merge corrupts mastery, prerequisites,
 * assessment and exam signals at once, while a surviving duplicate only costs a little clutter.
 * "TCP flow control" and "TCP congestion control", "gradient" and "gradient descent", "gene" and
 * "gene expression" must all stay separate, no matter how strong their vectors look.
 */
public final class TopicReconciliationCore {

    /** Cosine at or above which two topics are the same concept by embedding evidence alone. */
    public static final double EMBED_SAME = 0.92;
    /** Cosine at or above which a pair becomes an LLM-verification candidate. */
    public static final double EMBED_CANDIDATE = 0.86;
    /** Token Jaccard below this is a hard "different", even against a strong vector. */
    public static final double LEXICAL_FLOOR = 0.55;
    /** Confidence a merge must carry before the service acts on it. */
    public static final double MERGE_CONFIDENCE = 0.85;

    private static final Set<String> STOPWORDS = Set.of("and", "of", "the", "in", "for", "to", "a", "an", "on", "with", "its", "their");

    private TopicReconciliationCore() {}

    /** One side of a comparison: canonical identity plus optional embedding and context terms. */
    public record CandidateTopic(String id, String name, List<String> aliases, float[] embedding, Set<String> contextTerms) {
        public CandidateTopic {
            aliases = aliases == null ? List.of() : aliases;
            contextTerms = contextTerms == null ? Set.of() : contextTerms;
        }
    }

    /** One run stage: what it scored and what it decided, kept so a merge can be argued with later. */
    public record StageResult(String stage, double score, boolean matched, String detail) {}

    public record Verdict(ReconciliationDecision decision,
                          double confidence,
                          String reason,
                          double lexicalScore,
                          double embeddingScore,
                          double sourceOverlap,
                          List<StageResult> stages) {}

    /**
     * Deterministic verdict for a merge driven by the quality-cleanup path: the salvaged spelling
     * proves the dropped name was packaging ("(20 Pt)", mojibake, a question prefix) of one concept.
     * No similarity stages ran — the evidence is the salvage itself.
     */
    public static Verdict mergeByCleanup(String salvaged, String droppedName, String keptName) {
        List<StageResult> stages = List.of(
                new StageResult("QUALITY_SALVAGE", 1.0, true,
                        "\"" + droppedName + "\" salvages to \"" + salvaged + "\", which the kept topic \"" + keptName + "\" already names"));
        return new Verdict(ReconciliationDecision.SAME, 1.0,
                "Quality cleanup: \"" + droppedName + "\" is assessment packaging of \"" + salvaged + "\"",
                1.0, 0, 0, stages);
    }

    /** Cosine similarity, or 0 when either vector is missing/blank so the stage simply abstains. */
    public static double cosine(float[] left, float[] right) {
        if (left == null || right == null || left.length == 0 || right.length != left.length) return 0;
        double dot = 0, leftNorm = 0, rightNorm = 0;
        for (int index = 0; index < left.length; index++) {
            dot += left[index] * right[index];
            leftNorm += left[index] * left[index];
            rightNorm += right[index] * right[index];
        }
        if (leftNorm == 0 || rightNorm == 0) return 0;
        return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
    }

    /** Token Jaccard over significant folded tokens (stopwords and plurals removed). */
    public static double lexicalSimilarity(String left, String right) {
        Set<String> leftTokens = significantTokens(left);
        Set<String> rightTokens = significantTokens(right);
        if (leftTokens.isEmpty() || rightTokens.isEmpty()) return 0;
        Set<String> union = new LinkedHashSet<>(leftTokens);
        union.addAll(rightTokens);
        long shared = leftTokens.stream().filter(rightTokens::contains).count();
        return (double) shared / union.size();
    }

    /** 1.0 when the shorter token set is fully contained in the longer one, else the Jaccard score. */
    public static double containment(String left, String right) {
        Set<String> leftTokens = significantTokens(left);
        Set<String> rightTokens = significantTokens(right);
        if (leftTokens.isEmpty() || rightTokens.isEmpty()) return 0;
        Set<String> smaller = leftTokens.size() <= rightTokens.size() ? leftTokens : rightTokens;
        Set<String> larger = smaller == leftTokens ? rightTokens : leftTokens;
        return larger.containsAll(smaller) ? 1.0 : lexicalSimilarity(left, right);
    }

    /** Overlap of the two topics' supporting-context vocabularies, 0 when either side has none. */
    public static double contextOverlap(Set<String> left, Set<String> right) {
        if (left == null || right == null || left.isEmpty() || right.isEmpty()) return 0;
        long shared = left.stream().filter(right::contains).count();
        return (double) shared / Math.min(left.size(), right.size());
    }

    /**
     * The full staged comparison. Every stage records its score even when it does not decide, so a
     * reviewer can see exactly why two topics were or were not folded together.
     */
    public static Verdict evaluate(CandidateTopic left, CandidateTopic right) {
        List<StageResult> stages = new ArrayList<>();
        String leftNormalized = TopicRegistry.normalize(left.name());
        String rightNormalized = TopicRegistry.normalize(right.name());

        // Stage 1: exact normalized match.
        if (!leftNormalized.isBlank() && leftNormalized.equals(rightNormalized)) {
            stages.add(new StageResult("EXACT", 1.0, true, "Identical normalized names"));
            return new Verdict(ReconciliationDecision.SAME, 1.0, "Identical normalized topic names", lexicalSimilarity(left.name(), right.name()), 0, 0, stages);
        }
        stages.add(new StageResult("EXACT", 0, false, "Normalized names differ"));

        // Stage 2: known alias match, either direction.
        Set<String> leftAliases = aliasTokens(left);
        Set<String> rightAliases = aliasTokens(right);
        if (!leftNormalized.isBlank() && rightAliases.contains(leftNormalized) || !rightNormalized.isBlank() && leftAliases.contains(rightNormalized)) {
            stages.add(new StageResult("ALIAS", 1.0, true, "One name is a registered alias of the other"));
            return new Verdict(ReconciliationDecision.SAME, 0.95, "One name is a registered alias of the other", 1.0, 0, 0, stages);
        }
        stages.add(new StageResult("ALIAS", 0, false, "No alias relation"));

        double lexical = lexicalSimilarity(left.name(), right.name());
        double embedding = cosine(left.embedding(), right.embedding());
        double overlap = contextOverlap(left.contextTerms(), right.contextTerms());

        // Stage 3: safe lexical similarity. Token-set equality (after plural and stopword folding)
        // is the same phrase said differently. Bare containment is only trusted when the contained
        // name has at least two significant tokens — it is what separates "dependency injection"
        // from "dependency injection and inversion of control" (merge) while still refusing
        // "gradient" → "gradient descent" and "gene" → "gene expression".
        Set<String> leftTokens = significantTokens(left.name());
        Set<String> rightTokens = significantTokens(right.name());
        Set<String> smaller = leftTokens.size() <= rightTokens.size() ? leftTokens : rightTokens;
        Set<String> larger = smaller == leftTokens ? rightTokens : leftTokens;
        if (!leftTokens.isEmpty() && leftTokens.equals(rightTokens)) {
            stages.add(new StageResult("LEXICAL", 1.0, true, "Same significant tokens after folding"));
            return new Verdict(ReconciliationDecision.SAME, 0.9, "Same phrase in different wording", lexical, embedding, overlap, stages);
        }
        boolean contained = larger.containsAll(smaller) && !smaller.isEmpty();
        if (contained && smaller.size() >= 2) {
            stages.add(new StageResult("LEXICAL", containment(left.name(), right.name()), true, "Shorter name fully contained in longer"));
            double confidence = embedding > 0 ? Math.min(0.95, 0.8 + 0.15 * overlap) : 0.85;
            return new Verdict(ReconciliationDecision.SAME, confidence, "Full containment of a multi-token name", lexical, embedding, overlap, stages);
        }
        stages.add(new StageResult("LEXICAL", lexical, false, "Lexically similar but not identical"));

        // Below the lexical floor nothing else may merge the pair — embeddings are not evidence
        // enough on their own to override clearly different names.
        if (lexical < LEXICAL_FLOOR) {
            stages.add(new StageResult("GUARD", lexical, false, "Token overlap below the safe floor"));
            return new Verdict(ReconciliationDecision.DIFFERENT, Math.max(0.6, 1.0 - lexical), "Names share too few concepts to merge safely", lexical, embedding, overlap, stages);
        }

        // Stage 4: embedding similarity, only ever a candidate or a corroboration.
        if (embedding >= EMBED_SAME) {
            // Stage 5: context comparison decides whether high vector similarity means the same
            // concept in this course's own material.
            stages.add(new StageResult("EMBEDDING", embedding, true, "Vector similarity above the same-concept threshold"));
            if (overlap >= 0.5 || (left.contextTerms().isEmpty() && right.contextTerms().isEmpty())) {
                stages.add(new StageResult("CONTEXT", overlap, true, "Supporting material overlaps"));
                return new Verdict(ReconciliationDecision.SAME, Math.min(0.9, 0.6 + 0.2 * embedding + 0.1 * overlap), "Strong vector and context agreement", lexical, embedding, overlap, stages);
            }
            stages.add(new StageResult("CONTEXT", overlap, false, "Supporting material does not overlap enough"));
            return new Verdict(ReconciliationDecision.AMBIGUOUS, 0.5, "Similar vectors but different supporting context", lexical, embedding, overlap, stages);
        }
        stages.add(new StageResult("EMBEDDING", embedding, embedding >= EMBED_CANDIDATE, embedding >= EMBED_CANDIDATE ? "Vector similarity worth verifying" : "Vector similarity inconclusive"));

        if (embedding >= EMBED_CANDIDATE || lexical >= 0.7) {
            return new Verdict(ReconciliationDecision.AMBIGUOUS, 0.5, "Candidates are close but no safe stage can confirm identity", lexical, embedding, overlap, stages);
        }
        return new Verdict(ReconciliationDecision.DIFFERENT, Math.max(0.6, 1.0 - Math.max(lexical, embedding)), "No stage finds enough evidence of identity", lexical, embedding, overlap, stages);
    }

    private static Set<String> aliasTokens(CandidateTopic topic) {
        Set<String> tokens = new LinkedHashSet<>();
        for (String alias : topic.aliases()) {
            String normalized = TopicRegistry.normalize(alias);
            if (!normalized.isBlank()) tokens.add(normalized);
        }
        return tokens;
    }

    private static Set<String> significantTokens(String value) {
        Set<String> tokens = new LinkedHashSet<>();
        for (String word : TopicRegistry.normalize(value).split(" ")) {
            if (word.isBlank()) continue;
            if (STOPWORDS.contains(word)) continue;
            tokens.add(TopicRegistry.singularForm(word));
        }
        return tokens;
    }

    /** Top significant terms of a context snippet, for building {@link CandidateTopic} context sets. */
    public static Set<String> contextTerms(String text, int limit) {
        if (text == null || text.isBlank()) return Set.of();
        java.util.Map<String, Integer> counts = new java.util.HashMap<>();
        for (String word : text.toLowerCase(Locale.ROOT).split("[^a-z0-9]+")) {
            if (word.length() < 4 || STOPWORDS.contains(word)) continue;
            counts.merge(word, 1, Integer::sum);
        }
        return counts.entrySet().stream()
                .sorted(java.util.Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(limit)
                .map(java.util.Map.Entry::getKey)
                .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
    }
}
