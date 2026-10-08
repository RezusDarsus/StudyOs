package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;
import java.util.List;
import org.junit.jupiter.api.Test;

class ChatPredictionValidationTest {
    private final ChatService service=new ChatService(null,null,null,null,null,null,null,null,null,null,null,null,null,null);

    @Test void readsRequestedExerciseCountFromConversation(){assertThat(service.requestedPredictionCount("new exercises please","predict 4 exercises for the midterm")).isEqualTo(4);}
    @Test void supportsTenExercisesAndPrefersCurrentRequest(){assertThat(service.requestedPredictionCount("generate 10 new exercises","previously generate 2")).isEqualTo(10);}
    @Test void readsNaturalLanguageCountWithoutUsingDefaultFour(){assertThat(service.requestedPredictionCount("predict one likely hard midterm exercise","")).isEqualTo(1);assertThat(service.requestedPredictionCount("predict two genuinely new midterm problems","")).isEqualTo(2);}
    @Test void rejectsTopicOnlyPrediction(){var packet=new SemanticAnswerPacket("Four topics",List.of(new SemanticAnswerPacket.Section("Predicted topics","CRC, fairness, routing, leader election")),List.of(),List.of());assertThat(service.usableExamPacket(packet,4)).isFalse();}
    @Test void acceptsCompleteCitedExerciseSections(){String body="Scenario with enough detail for a realistic unseen exam variant. Tasks: 1. Prove the property. 2. Analyze the execution. Why new: it combines two learned ideas. Confidence: medium. [[Source: lecture.pdf; pages 3-4]]";var sections=java.util.stream.IntStream.rangeClosed(1,4).mapToObj(i->new SemanticAnswerPacket.Section("Exercise "+i+" — Variant",body)).toList();assertThat(service.usableExamPacket(new SemanticAnswerPacket("Overview",sections,List.of(),List.of()),4)).isTrue();}

    /** A full set says nothing extra; anything else has to say how many of the requested exercises are there. */
    @Test void statesTheShortfallWhenFewerExercisesSurvivedThanWereAskedFor(){
        assertThat(service.shortfallNote(4,4)).isEmpty();
        assertThat(service.shortfallNote(5,4)).isEmpty();
        assertThat(service.shortfallNote(3,5)).contains("You asked for 5","3 passed","2 did not","only these are shown");
        assertThat(service.shortfallNote(1,4)).contains("only this one is shown");
    }

    /**
     * When verification stopped early, "2 did not pass" would be a false statement about candidates no verifier
     * ever looked at. A short set from a truncated turn has to say the difference, because the learner's next
     * move depends on it: a rejected exercise is gone, an unchecked one is worth asking for again.
     */
    @Test void separatesExercisesThatFailedACheckFromOnesNeverChecked(){
        var stopped=diagnostics(2,0,"BUDGET: verification stopped after 6 verifier calls (cap 6)");
        String note=service.shortfallNote(3,5,stopped);
        assertThat(note).contains("You asked for 5","3 are shown","Verification stopped before finishing",
                "the remaining 2 are missing because they were not checked, not because they failed a check","2 candidates were never checked at all","Ask again for the rest.");
        assertThat(note).doesNotContain("passed every check"," did not,");
    }

    /** A complete set from a completed turn still says nothing, whether or not diagnostics are available. */
    @Test void aCompletedFullSetStillNeedsNoNote(){
        assertThat(service.shortfallNote(4,4,diagnostics(0,0,null))).isEmpty();
        assertThat(service.shortfallNote(4,4,null)).isEmpty();
        assertThat(service.shortfallNote(3,5,diagnostics(0,0,null))).contains("3 passed","2 did not");
    }

    /**
     * A full set can still be short of a check. The exercises shown did pass grounding, novelty and
     * well-definedness once, so they are shown; that the second independent opinion never ran is disclosed
     * rather than silently absorbed.
     */
    @Test void disclosesAMissingSecondOpinionEvenWhenTheSetIsComplete(){
        String note=service.shortfallNote(4,4,diagnostics(0,2,null));
        assertThat(note).contains("final independent re-check did not run","2 of the exercises shown rest","a single verifier's judgement");
        assertThat(note).doesNotContain("You asked for");
    }

    /** The disclosed count may never exceed what is on screen, or the note describes exercises nobody can see. */
    @Test void neverClaimsMoreUnauditedExercisesThanAreShown(){
        assertThat(service.shortfallNote(1,4,diagnostics(0,5,null))).contains("up to 1 of the exercises shown rests").doesNotContain("5 of the exercises");
    }

    /** Singular wording, because a note that reads like a template is a note a learner skips. */
    @Test void countsOfOneReadAsOne(){
        assertThat(service.shortfallNote(1,2,diagnostics(1,0,null))).contains("1 is shown","the remaining one is missing because it was not checked, not because it failed a check","1 candidate was never checked at all");
    }

    private ExamPredictionVerificationService.PredictionDiagnostics diagnostics(int unverified,int unaudited,String budgetStop){
        return new ExamPredictionVerificationService.PredictionDiagnostics(6,0,0,0,0,4,1_200,List.of(),0,0,
                new ExamPredictionVerificationService.GateExecution(true,true,true,true,true,true),unverified,unaudited,budgetStop);
    }

    /**
     * The count a quiz is held to is only the one the learner named. The generation default of four is the
     * system's own choice, so reporting a three-question reply as violating it would be the audit inventing a
     * request — which is why these two methods disagree on an empty turn and must keep disagreeing.
     */
    @Test void holdsAQuizOnlyToACountTheLearnerActuallyNamed(){
        assertThat(service.namedQuestionCount("check my knowledge with 3 questions","")).isEqualTo(3);
        assertThat(service.namedQuestionCount("ask me one question at a time","")).isEqualTo(1);
        assertThat(service.namedQuestionCount("quiz me","")).isZero();
        assertThat(service.requestedPredictionCount("quiz me","")).isEqualTo(4);
        assertThat(service.namedQuestionCount("quiz me","give me two questions on this")).isEqualTo(2);
    }
}
