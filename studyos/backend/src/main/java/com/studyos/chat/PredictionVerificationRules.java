package com.studyos.chat;

import java.util.*;

/** Deterministic gates before and after the AI verifier; they intentionally do not certify novelty. */
final class PredictionVerificationRules {
    private PredictionVerificationRules() {}
    static boolean structurallyUsable(PredictionCandidateBatch.PredictionCandidate candidate) {
        return candidate!=null && candidate.title().length()>=4 && candidate.exercise().length()>=140 && !candidate.sourceBasis().isEmpty()
                && candidate.sourceBasis().stream().anyMatch(source->source.document()!=null&&!source.document().isBlank()&&source.pages()!=null&&!source.pages().isBlank());
    }
    static boolean eligible(PredictionVerificationBatch.Verification verification,boolean allowParameterOnly) {
        if(verification==null||verification.scopeViolation()||!verification.groundingOk()||!verification.wellDefined()||!verification.mathematicalConsistency()||verification.nearCopy()||!verification.unsupportedConcepts().isEmpty()||!verification.unsupportedModelChanges().isEmpty()||!verification.unsupportedAssumptions().isEmpty()||!verification.unsupportedDomains().isEmpty()||!verification.unsupportedOperations().isEmpty()) return false;
        if(!requiredConceptsCovered(verification))return false;
        String type=verification.noveltyType().toUpperCase(Locale.ROOT);
        if(type.equals("EXACT_COPY")||type.equals("NEAR_COPY")||type.equals("SHALLOW_OPERATOR_VARIANT")||type.equals("SHALLOW_TRANSFORMATION")) return false;
        return allowParameterOnly || !type.equals("PARAMETER_ONLY_VARIANT");
    }
    static boolean eligibleHardNew(PredictionVerificationBatch.Verification verification) {
        return eligible(verification,false)&&verification.reasoningNovelty()>=.60&&verification.reasoningDifficulty()>=.72&&verification.solutionStrategySimilarity()<=.68;
    }
    static boolean requiredConceptsCovered(PredictionVerificationBatch.Verification verification){if(verification==null||verification.requiredConcepts().isEmpty())return false;Set<String> supported=verification.supportedConcepts().stream().map(PredictionVerificationRules::normalizeConcept).collect(java.util.stream.Collectors.toSet());return verification.requiredConcepts().stream().map(PredictionVerificationRules::normalizeConcept).allMatch(supported::contains);}
    static String localNoveltyType(String original,String candidate) {
        String left=normalizeVariant(original),right=normalizeVariant(candidate);
        if(left.equals(right)) return "PARAMETER_ONLY_VARIANT";
        double symmetric=tokenOverlap(left,right),referenceCoverage=directionalCoverage(left,right);
        return symmetric>=.88||referenceCoverage>=.86?"NEAR_COPY":"UNDECIDED";
    }
    /**
     * Deterministic novelty gate applied before the AI verifier. It reports the first reference exercise the
     * candidate merely re-skins, so an operator or constant swap is rejected without trusting the model.
     */
    static Optional<String> shallowAgainst(List<String> references,String candidate) {
        for(String reference:references) { String type=localNoveltyType(reference,candidate); if(type.equals("PARAMETER_ONLY_VARIANT")||type.equals("NEAR_COPY")) return Optional.of(type); }
        return Optional.empty();
    }
    static boolean obviousDuplicate(double cosine,String existing,String candidate) {
        String reference=normalizeVariant(existing),generated=normalizeVariant(candidate);
        return cosine>=.985 || (cosine>=.90 && directionalCoverage(reference,generated)>=.78) || (cosine>=.94 && tokenOverlap(reference,generated)>=.88);
    }
    static double semanticStrategySimilarity(AcademicSemanticProfile candidate,List<AcademicSemanticProfile> references){
        if(candidate==null||references==null||references.isEmpty())return 0;
        String actualTasks=String.join(" ",candidate.taskTypes()),actualReasoning=String.join(" ",candidate.expectedReasoningSteps());if(tokens(actualTasks+" "+actualReasoning).size()<2)return 0;double best=0;
        for(AcademicSemanticProfile reference:references){String expectedTasks=String.join(" ",reference.taskTypes()),expectedReasoning=String.join(" ",reference.expectedReasoningSteps());if(tokens(expectedTasks+" "+expectedReasoning).size()<2)continue;double taskSimilarity=tokens(actualTasks).isEmpty()||tokens(expectedTasks).isEmpty()?tokenOverlap(expectedReasoning,actualReasoning):tokenOverlap(expectedTasks,actualTasks);double reasoningSimilarity=tokenOverlap(expectedReasoning,actualReasoning);best=Math.max(best,.72*taskSimilarity+.28*reasoningSimilarity);}
        return best;
    }
    static double tokenOverlap(String left,String right) {
        Set<String> a=tokens(left),b=tokens(right); if(a.isEmpty()||b.isEmpty()) return 0;
        Set<String> shared=new HashSet<>(a);shared.retainAll(b);return (double)shared.size()/Math.max(a.size(),b.size());
    }
    private static double directionalCoverage(String reference,String candidate){Set<String> expected=tokens(reference),actual=tokens(candidate);if(expected.isEmpty())return 0;Set<String> shared=new HashSet<>(expected);shared.retainAll(actual);return (double)shared.size()/expected.size();}
    private static String normalizeVariant(String value) {
        return (value==null?"":value.toLowerCase(Locale.ROOT))
                .replaceAll("\\b(?:n|m|k|x|y|z)\\s*=\\s*\\d+"," variable ")
                .replaceAll("\\b(?:one|two|three|four|five|second|third|fourth|fifth)\\b"," number ")
                .replaceAll("\\b\\d+(?:\\.\\d+)?\\b"," number ")
                .replaceAll("[^a-z ]"," ").replaceAll("\\s+"," ").trim();
    }
    private static Set<String> tokens(String value) { Set<String> result=new HashSet<>(Arrays.asList(value.split(" ")));result.removeIf(token->token.length()<3||Set.of("the","and","for","with","that","this","from","into","your","are","not").contains(token));return result; }
    private static String normalizeConcept(String value){return (value==null?"":value.toLowerCase(Locale.ROOT)).replaceAll("[^a-z0-9]+"," ").replaceAll("\\s+"," ").trim();}
}
