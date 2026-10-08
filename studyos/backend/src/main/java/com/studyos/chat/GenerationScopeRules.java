package com.studyos.chat;

import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/** Fast, subject-independent checks before semantic AI comparison. */
final class GenerationScopeRules {
    private static final Pattern MUTATES_SOURCE=Pattern.compile("(?s).*(?:is\\s+(?:now\\s+)?(?:changed|replaced|redefined)\\s+to|we\\s+(?:change|replace|redefine)\\s+the|modified\\s+(?:version|system|model|rule|definition|assumption)|redefine\\s+the|suppose\\s+(?:instead\\s+that|that\\s+the\\s+.+?\\s+(?:is\\s+changed|is\\s+replaced|now\\s+uses))|replace\\s+.+?\\s+with\\s+.+?).*");
    private static final Pattern INTRODUCES_REFERENCE_SETUP=Pattern.compile("(?is)\\b(?:consider|suppose|assume|let|take|given)\\b|\\bdefine\\s+(?:a|an|the|this|following)\\b|\\bas\\s+follows\\s*:");
    private static final int MAX_REPORTED_CONCEPTS=8;
    private GenerationScopeRules(){}

    static ScopeCheck check(GenerationScope scope,PredictionCandidateBatch.PredictionCandidate candidate){
        if(scope==null||!scope.hasEvidence())return new ScopeCheck(false,true,"OUT_OF_SCOPE",List.of(),List.of(),List.of("scope evidence"),List.of(),"groundingOk=false: no evidence was resolved for the requested scope");
        if(candidate.sourceBasis().stream().anyMatch(source->!scope.allowedDocuments().contains(source.document())))return new ScopeCheck(false,true,"OUT_OF_SCOPE",List.of(),List.of(),List.of("citation inside closed scope"),List.of(),"groundingOk=false: citation outside "+scope.label());
        String text=stripExplicitExclusions((candidate.title()+" "+candidate.exercise()).toLowerCase(Locale.ROOT));String evidence=scope.evidence().toLowerCase(Locale.ROOT);
        List<String> required=new ArrayList<>(),supported=new ArrayList<>(),unsupported=new ArrayList<>(),changes=new ArrayList<>(),issues=new ArrayList<>();
        if(!candidate.exercise().toLowerCase(Locale.ROOT).startsWith("use the definitions, rules, and assumptions from the cited source unchanged."))issues.add("candidate did not explicitly bind itself to the unchanged closed source material");
        String tasks=candidate.exercise().replaceFirst("(?is)^\\s*use the definitions, rules, and assumptions from the cited source unchanged\\.\\s*","");
        if(scope.referenceModelFrozen()&&!scope.referenceAssessments().isEmpty()&&INTRODUCES_REFERENCE_SETUP.matcher(tasks).find()){
            changes.add("REFERENCE_MODEL_RESTATED_OR_EXTENDED");
            issues.add("unsupported model change: an explicitly referenced assessment permits new tasks over its unchanged model, not a newly introduced setup or concrete instance");
        }
        for(String concept:scope.courseConcepts()){
            if(!mentions(text,concept))continue;required.add(concept);
            if(mentions(evidence,concept))supported.add(concept);else if(unsupported.size()<MAX_REPORTED_CONCEPTS){unsupported.add(concept);issues.add("unsupported concept: "+concept+" is absent from the closed evidence");}
        }
        List<String> unsupportedData=unsupportedStructuredLiterals(tasks,evidence);
        if(!unsupportedData.isEmpty()){changes.add("UNSUPPORTED_CONCRETE_DATA");issues.add("unsupported concrete data not present in the closed evidence: "+unsupportedData);}
        if(MUTATES_SOURCE.matcher(text).matches()){changes.add("SOURCE_SEMANTICS_REPLACED");issues.add("unsupported model change: candidate explicitly replaces a source definition, rule, operation, domain, or assumption");}
        if(issues.isEmpty())return new ScopeCheck(true,false,"",required,supported,unsupported,changes,"");
        return new ScopeCheck(false,true,changes.isEmpty()?"OUT_OF_SCOPE":"SHALLOW_TRANSFORMATION",required,supported,unsupported,changes,"groundingOk=false: "+String.join("; ",issues));
    }

    private static boolean mentions(String text,String concept){String trimmed=concept==null?"":concept.trim();if(trimmed.isBlank())return false;String[] words=trimmed.split("\\s+");String phrase="\\b"+Arrays.stream(words).map(Pattern::quote).collect(Collectors.joining("\\s+"))+"(?:s|es)?\\b";if(Pattern.compile(phrase,Pattern.CASE_INSENSITIVE).matcher(text).find())return true;if(words.length<2)return false;String acronym=Arrays.stream(words).filter(word->!word.isBlank()).map(word->word.substring(0,1)).collect(Collectors.joining());return acronym.length()>=2&&Pattern.compile("\\b"+Pattern.quote(acronym)+"\\b",Pattern.CASE_INSENSITIVE).matcher(text).find();}
    private static String stripExplicitExclusions(String text){return text.replaceAll("(?i)\\b(?:without|excluding|do not (?:use|assume|add|require)|does not depend on|must not (?:use|assume|add|require)|no need for)\\s+(?:any\\s+)?[a-z][a-z -]{1,60}(?=[,.;]|$)"," ");}
    private static List<String> unsupportedStructuredLiterals(String candidate,String evidence){
        String source=compactLiteral(evidence);LinkedHashSet<String> values=new LinkedHashSet<>();
        for(Pattern pattern:List.of(Pattern.compile("\\{[^{}]{1,80}}"),Pattern.compile("(?<![\\p{L}\\p{N}])[01]{4,}(?![\\p{L}\\p{N}])"),Pattern.compile("(?<![\\p{L}\\p{N}])\\d{3,}(?![\\p{L}\\p{N}])"))){var matcher=pattern.matcher(candidate==null?"":candidate);while(matcher.find()){String literal=compactLiteral(matcher.group());if(!literal.isBlank()&&!source.contains(literal))values.add(matcher.group().trim());}}
        return values.stream().limit(5).toList();
    }
    private static String compactLiteral(String value){return (value==null?"":value.toLowerCase(Locale.ROOT)).replaceAll("\\s+","");}
    record ScopeCheck(boolean allowed,boolean scopeViolation,String noveltyType,List<String> requiredConcepts,List<String> supportedConcepts,List<String> unsupportedConcepts,List<String> unsupportedModelChanges,String issue){}
}
