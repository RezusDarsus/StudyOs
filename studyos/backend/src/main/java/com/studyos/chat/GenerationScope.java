package com.studyos.chat;

import java.util.List;
import java.util.UUID;

/**
 * Closed, dynamic evidence boundary for generated academic work. It is resolved from this course's
 * uploaded documents, topics, week constraints, and explicit assessment references before generation.
 */
public record GenerationScope(
        UUID courseId,
        String label,
        List<Integer> requestedWeeks,
        List<String> requestedTopics,
        List<UUID> documentIds,
        List<String> allowedDocuments,
        Integer referenceExercise,
        String referenceText,
        boolean referenceModelFrozen,
        List<ReferenceAssessment> referenceAssessments,
        String evidence,
        List<String> courseConcepts,
        AcademicSemanticProfile sourceSemantics,
        List<String> historicalGeneratedExercises) {

    public GenerationScope {
        label=label==null?"requested source scope":label;
        requestedWeeks=copy(requestedWeeks); requestedTopics=copy(requestedTopics); documentIds=copy(documentIds); allowedDocuments=copy(allowedDocuments);
        referenceText=referenceText==null?"":referenceText;referenceAssessments=copy(referenceAssessments);evidence=evidence==null?"":evidence;
        courseConcepts=copy(courseConcepts);sourceSemantics=sourceSemantics==null?AcademicSemanticProfile.empty():sourceSemantics;historicalGeneratedExercises=copy(historicalGeneratedExercises);
    }

    public boolean hasEvidence(){return !documentIds.isEmpty()&&!evidence.isBlank();}
    public ScopeSummary summary(){return new ScopeSummary(label,requestedWeeks,requestedTopics,documentIds,allowedDocuments,referenceExercise,referenceText,referenceModelFrozen,referenceAssessments.stream().map(ReferenceAssessment::summary).toList(),sourceSemantics,historicalGeneratedExercises.size());}
    private static <T> List<T> copy(List<T> values){return values==null?List.of():List.copyOf(values);}

    public record ReferenceAssessment(String id,String prompt,String sourceType,String document,Integer pageStart,Integer pageEnd,AcademicSemanticProfile semantics){
        public ReferenceAssessment {id=id==null?"":id;prompt=prompt==null?"":prompt;sourceType=sourceType==null?"ASSESSMENT":sourceType;document=document==null?"":document;semantics=semantics==null?AcademicSemanticProfile.empty():semantics;}
        public ReferenceAssessment withSemantics(AcademicSemanticProfile value){return new ReferenceAssessment(id,prompt,sourceType,document,pageStart,pageEnd,value);}
        public ReferenceSummary summary(){return new ReferenceSummary(id,sourceType,document,pageStart,pageEnd,semantics);}
    }
    public record ReferenceSummary(String id,String sourceType,String document,Integer pageStart,Integer pageEnd,AcademicSemanticProfile semantics){}
    public record ScopeSummary(String label,List<Integer> requestedWeeks,List<String> requestedTopics,List<UUID> documentIds,List<String> documents,Integer referenceExercise,String referenceText,boolean referenceModelFrozen,List<ReferenceSummary> references,AcademicSemanticProfile sourceSemantics,int historicalGeneratedExerciseCount){}
}
