package com.studyos.ai;

import java.util.*;
import org.springframework.stereotype.Component;

/**
 * Representative inputs a cheaper internal model must handle before it may be enabled.
 *
 * <p>The concepts are supplied by the caller from the material the installation actually holds, never fixed
 * here. A fixed list would certify a cheaper model against one subject's vocabulary and then route a
 * completely different course through it, which proves nothing about that course. If the corpus offers no
 * concepts yet, there are no fixtures, and the honest conclusion is that the substitution is unevaluated.
 */
@Component
public class ModelRoutingFixtures {
    /** How many concepts one operation is exercised with; more than this adds cost without adding coverage. */
    public static final int FIXTURES_PER_OPERATION = 20;

    /** Fixtures for {@code operation}, one per supplied concept, or none for an operation never routed internally. */
    public List<Fixture> fixtures(AiOperation operation, List<String> concepts) {
        if (!isInternal(operation) || concepts == null) return List.of();
        List<String> distinct = concepts.stream().filter(concept -> concept != null && !concept.isBlank()).map(String::trim)
                .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new)).stream().limit(FIXTURES_PER_OPERATION).toList();
        List<Fixture> result = new ArrayList<>();
        for (int index = 0; index < distinct.size(); index++) {
            String concept = distinct.get(index);
            result.add(new Fixture(operation.name().toLowerCase(Locale.ROOT) + "-" + (index + 1), input(operation, concept), List.of(concept.toLowerCase(Locale.ROOT))));
        }
        return List.copyOf(result);
    }

    private String input(AiOperation operation, String concept) {
        return switch (operation) {
            case GRADING -> "Grade a student's explanation of " + concept + " and return score, feedback, misconception, conceptScores, and mistakes.";
            case TOPIC_EXTRACTION -> "Extract canonical topics and source chunk IDs from a passage about " + concept + ".";
            case MEMORY_EXTRACTION -> "Extract learning events, decisions, unresolved questions, and misconceptions from a conversation about " + concept + ".";
            case SUMMARY -> "Summarize a source-grounded section about " + concept + " without adding facts.";
            case ASSESSMENT_EXTRACTION -> "Extract question, points, type, and provenance from an assessment item about " + concept + ".";
            case EXAM_PREDICTION_VERIFICATION -> "Strictly verify whether a proposed exam exercise about " + concept + " is grounded, well-defined, and meaningfully different from supplied assessment items.";
            default -> throw new IllegalArgumentException("Not an internal operation: " + operation);
        };
    }

    /** Student-facing chat is never served by the cheaper model, so it has no fixtures by construction. */
    public static Set<AiOperation> internalOperations() {
        return Set.of(AiOperation.GRADING, AiOperation.TOPIC_EXTRACTION, AiOperation.MEMORY_EXTRACTION, AiOperation.SUMMARY, AiOperation.ASSESSMENT_EXTRACTION, AiOperation.EXAM_PREDICTION_VERIFICATION);
    }
    private boolean isInternal(AiOperation operation) { return internalOperations().contains(operation); }
    public record Fixture(String id,String input,List<String> requiredConcepts) {}
}
