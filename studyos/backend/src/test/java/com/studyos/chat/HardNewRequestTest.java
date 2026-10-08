package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

class HardNewRequestTest {
    @Test void parsesExactConstrainedRequestBeforeRetrieval(){
        HardNewRequest request=HardNewRequest.parse("give me new hard exercise not same as homework 1 but use topic from week 1");
        assertThat(request.requestedCount()).isEqualTo(1);
        assertThat(request.requestedWeeks()).containsExactly(1);
        assertThat(request.referenceExercise()).isEqualTo(1);
        assertThat(request.difficulty()).isEqualTo("HARD");
        assertThat(request.allowLaterWeeks()).isFalse();
        assertThat(request.requireReasoningNovelty()).isTrue();
        assertThat(request.freezesReferenceModel()).isTrue();
    }
    @Test void hardNewContextProfileCannotRetrieveLaterWeekEvidence(){
        ContextProfile profile=new ContextPolicyRegistry().profile(QueryIntent.HARD_NEW);
        assertThat(profile.evidenceChunks()).isZero();
        assertThat(profile.recentMessages()).isZero();
        assertThat(profile.crossChatMemory()).isFalse();
    }
    @Test void readsAnExplicitPluralCount(){
        assertThat(HardNewRequest.parse("generate 3 new hard exercises from week 2").requestedCount()).isEqualTo(3);
        assertThat(HardNewRequest.parse("give me 2 harder problems for week 4").requestedCount()).isEqualTo(2);
        assertThat(HardNewRequest.parse("Generate 2 genuinely different hard exercises using only Week 1").requestedCount()).isEqualTo(2);
        assertThat(HardNewRequest.parse("Create one genuinely hard new problem from Week 3").requestedCount()).isEqualTo(1);
    }
    @Test void doesNotMistakeAWeekOrHomeworkNumberForACount(){
        assertThat(HardNewRequest.parse("new hard exercise not same as homework 7 but use topic from week 5").requestedCount()).isEqualTo(1);
    }
    @Test void detectsAScopedGenerationRequestEvenWithoutTheWordExercise(){
        assertThat(HardNewRequest.requestsScopedNewExercise("give me new hard device not same as homework 1 but use topic from week 1")).isTrue();
    }
    @Test void treatsAHomeworkReferenceAloneAsAClosedScopeSignal(){
        HardNewRequest request=HardNewRequest.parse("create a harder problem unlike homework 3");
        assertThat(request.hasClosedScopeSignal()).isTrue();
        assertThat(request.referenceExercise()).isEqualTo(3);
        assertThat(request.requestedWeeks()).isEmpty();
    }
    @Test void doesNotTreatExplanatoryQuestionsAsGenerationRequests(){
        assertThat(HardNewRequest.requestsScopedNewExercise("what is new in week 2 homework 1")).isFalse();
        assertThat(HardNewRequest.requestsScopedNewExercise("explain week 1 homework 1")).isFalse();
        assertThat(HardNewRequest.requestsScopedNewExercise("help me solve homework 1 from week 1")).isFalse();
    }
    @Test void requiresAClosedScopeBeforeClaimingAScopedRequest(){
        assertThat(HardNewRequest.requestsScopedNewExercise("give me a new hard exercise")).isFalse();
        assertThat(HardNewRequest.parse("give me a new hard exercise").hasClosedScopeSignal()).isFalse();
    }
    @Test void preservesRawQueryForDynamicTopicAndDocumentResolution(){HardNewRequest request=HardNewRequest.parse("Give me a hard Streams exercise from Week 6, unlike Homework 2");assertThat(request.rawQuery()).contains("Streams").contains("Week 6");assertThat(request.referenceText()).isEqualTo("homework 2");}
    @Test void unlikeUsesHomeworkForComparisonWithoutFreezingItsModel(){assertThat(HardNewRequest.parse("Create one hard new CRC exercise using only Week 4, unlike Homework 4.").freezesReferenceModel()).isFalse();}
    @Test void parsesExamReferenceWithoutTreatingYearAsHomeworkExercise(){HardNewRequest request=HardNewRequest.parse("Create a hard Week 4 problem unlike Midterm 2025");assertThat(request.referenceExercise()).isNull();assertThat(request.referenceText()).isEqualTo("midterm 2025");}
    @Test void namedDocumentCanDefineAClosedScope(){assertThat(HardNewRequest.parse("Create a hard exercise from document CNDSEx06.pdf").hasClosedScopeSignal()).isTrue();assertThat(HardNewRequest.requestsScopedNewExercise("Create a hard exercise from document CNDSEx06.pdf")).isTrue();}
}
