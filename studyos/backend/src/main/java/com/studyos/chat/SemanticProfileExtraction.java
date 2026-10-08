package com.studyos.chat;

import java.util.List;

/** Structured semantic extraction for one closed source scope and its explicit reference assessments. */
public record SemanticProfileExtraction(AcademicSemanticProfile source,List<ReferenceProfile> references) {
    public SemanticProfileExtraction { source=source==null?AcademicSemanticProfile.empty():source;references=references==null?List.of():List.copyOf(references); }
    public static String contract(){return "Return JSON {source:"+AcademicSemanticProfile.contract()+",references:[{referenceId,profile:"+AcademicSemanticProfile.contract()+"}]}. Extract only what the supplied text supports. Keep each list concise and use subject terminology from the text.";}
    public record ReferenceProfile(String referenceId,AcademicSemanticProfile profile){public ReferenceProfile{referenceId=referenceId==null?"":referenceId;profile=profile==null?AcademicSemanticProfile.empty():profile;}}
}
