package com.studyos.chat;

import java.util.List;
import java.util.Locale;

/**
 * Builds one conservative fallback candidate from the resolved source semantics. The templates
 * describe reasoning forms only; all academic objects, data, and operations remain source-bound.
 */
final class HardNewScaffoldFactory {
    private HardNewScaffoldFactory() {}

    static PredictionCandidateBatch.PredictionCandidate create(
            GenerationScope scope, SemanticAnswerPacket.SourceRef source) {
        GenerationScope.ReferenceAssessment reference = scope.referenceAssessments().isEmpty()
                ? null : scope.referenceAssessments().getFirst();
        AcademicSemanticProfile profile = reference != null && !reference.semantics().isEmpty()
                ? reference.semantics() : scope.sourceSemantics();
        String focus = focus(scope, profile, reference);
        String semanticText = semanticText(profile, reference);

        if (scope.referenceModelFrozen() && containsAny(semanticText,
                "transition", "step", "state", "configuration", "computation", "reachable")) {
            return candidate("Reachability characterization — " + focus,
                    "Use the definitions, rules, and assumptions from the cited source unchanged. "
                            + "Characterize exactly every configuration reachable from the source's initial configuration by a finite sequence of its original transitions. Express the characterization in the source's own state notation and prove both directions. For necessity, use induction on the computation length and check every source-defined transition. For sufficiency, give a general construction that reaches an arbitrary configuration satisfying your condition. Then formulate a plausible condition that is necessary but not sufficient, exhibit a valid trace under the unchanged source model that refutes its sufficiency, and repair it into a complete if-and-only-if characterization. Finish by checking the initial configuration and the smallest nontrivial reachable cases. Do not alter any source domain, initial value, transition, operation, or state component.",
                    source, "EXACT_CHARACTERIZATION");
        }

        if (!scope.requestedTopics().isEmpty() && scope.referenceAssessments().size() >= 2) {
            GenerationScope.ReferenceAssessment second = scope.referenceAssessments().get(1);
            String firstTasks = taskSummary(profile);
            String secondTasks = taskSummary(second.semantics());
            String operations = operationSummary(profile, second.semantics());
            return candidate("End-to-end synthesis — " + focus,
                    "Use the definitions, rules, and assumptions from the cited source unchanged. "
                            + "Build one end-to-end solution for the exact data already stated in the source.\n\n"
                            + "1. Complete these source tasks: " + firstTasks + ".\n"
                            + "2. Continue that result through these source tasks: " + secondTasks + ".\n"
                            + "3. Derive every intermediate object required by the source-defined operations: " + operations + ".\n"
                            + "4. State a checkable condition for each stage, and prove that satisfying all stage conditions produces a result meeting both source specifications.\n"
                            + "5. Determine whether different source-permitted intermediate choices can produce distinct valid final solutions; prove uniqueness or characterize all valid alternatives.\n"
                            + "6. Audit a proposed solution that verifies only the first stage, identify the precise missing checks, and repair the argument.\n\n"
                            + "Do not add or change any graph, value, domain, operation, rule, or assumption.",
                    source, "CONCEPT_COMBINATION");
        }

        if (containsAny(semanticText, "compute", "calculate", "procedure", "algorithm", "divide",
                "division", "construct", "determine", "specify", "apply")) {
            return candidate("Verification certificate — " + focus,
                    "Use the definitions, rules, and assumptions from the cited source unchanged. "
                            + "Complete the exact source task—" + taskSummary(profile)
                            + "—using the exact source data. In addition to the final result, give a verification certificate that records every intermediate result produced by these source-defined operations: " + operationSummary(profile)
                            + ".\n\n1. State local conditions that certify each step.\n"
                            + "2. Prove that the complete set of conditions is necessary and sufficient for a proposed answer to be correct.\n"
                            + "3. Determine whether the exact source input has a unique valid output; prove uniqueness or characterize every valid output allowed by the unchanged procedure.\n"
                            + "4. Construct a plausible incomplete solution using only source data, identify its first invalid step, and repair it without adding any new value, convention, operation, or assumption.",
                    source, "DERIVE_CONDITION");
        }

        return candidate("Complete characterization and proof audit — " + focus,
                "Use the definitions, rules, and assumptions from the cited source unchanged. "
                        + "Solve the exact source task on " + taskSummary(profile)
                        + ", then characterize all source-permitted solutions in the original notation. State necessary and sufficient conditions and prove both directions using only these source-defined operations or rules: " + operationSummary(profile)
                        + ". Determine whether the conditions force a unique solution; prove uniqueness or characterize all alternatives. Next, write a plausible argument that establishes only a necessary condition, provide a source-valid counterexample showing why the argument is incomplete, and repair it into a complete proof. Check the smallest case already admitted by the source, and do not introduce or alter any datum, object, domain, operation, theorem, or assumption.",
                source, "EXACT_CHARACTERIZATION");
    }

    private static PredictionCandidateBatch.PredictionCandidate candidate(
            String title, String exercise, SemanticAnswerPacket.SourceRef source, String type) {
        return new PredictionCandidateBatch.PredictionCandidate(title, exercise, List.of(source), type);
    }

    private static String focus(GenerationScope scope, AcademicSemanticProfile profile,
                                GenerationScope.ReferenceAssessment reference) {
        if (!scope.requestedTopics().isEmpty()) return String.join(" and ", scope.requestedTopics());
        if (!profile.concepts().isEmpty()) return concise(profile.concepts().getFirst(), 90);
        if (reference != null) return assessmentTitle(reference.prompt());
        return scope.label();
    }

    private static String taskSummary(AcademicSemanticProfile profile) {
        if (profile != null && !profile.taskTypes().isEmpty())
            return join(profile.taskTypes(), 3, "the complete source task");
        return "the complete source task";
    }

    private static String operationSummary(AcademicSemanticProfile... profiles) {
        java.util.LinkedHashSet<String> values = new java.util.LinkedHashSet<>();
        for (AcademicSemanticProfile profile : profiles) {
            if (profile == null) continue;
            profile.operations().stream()
                    .filter(value -> !value.toLowerCase(Locale.ROOT).contains("credit point"))
                    .filter(value -> !value.matches("(?i)^(?:define|determine|compare|prove|show|give|specify)\\b.*"))
                    .limit(3).forEach(values::add);
        }
        return values.isEmpty() ? "the source-defined rules and operations" : join(List.copyOf(values), 5, "the source-defined rules and operations");
    }

    private static String semanticText(AcademicSemanticProfile profile,
                                       GenerationScope.ReferenceAssessment reference) {
        StringBuilder value = new StringBuilder();
        if (profile != null) value.append(profile).append(' ');
        if (reference != null) value.append(reference.prompt());
        return value.toString().toLowerCase(Locale.ROOT);
    }

    private static boolean containsAny(String value, String... terms) {
        for (String term : terms) if (value.contains(term)) return true;
        return false;
    }

    private static String join(List<String> values, int limit, String fallback) {
        if (values == null || values.isEmpty()) return fallback;
        return values.stream().limit(limit).map(value -> concise(value, 150))
                .collect(java.util.stream.Collectors.joining("; "));
    }

    private static String assessmentTitle(String prompt) {
        String value = prompt == null ? "source-defined problem" : prompt.replaceAll("\\s+", " ").trim();
        int points = value.toLowerCase(Locale.ROOT).indexOf("credit point");
        if (points > 0) value = value.substring(0, points);
        int bullet = value.indexOf('•');
        if (bullet > 3) value = value.substring(0, bullet);
        return concise(value, 90);
    }

    private static String concise(String value, int max) {
        String clean = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        return clean.length() <= max ? clean : clean.substring(0, max).trim() + "…";
    }
}
