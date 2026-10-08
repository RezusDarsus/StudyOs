package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

class QueryRouterTest {
    private final QueryRouter router = new QueryRouter();
    @Test void recognizesStudyPlan() { assertThat(router.classify("What should I study today?")).isEqualTo(QueryIntent.STUDY_PLAN); }
    @Test void recognizesQuiz() { assertThat(router.classify("Quiz me on routing")).isEqualTo(QueryIntent.QUIZ_GENERATION); }
    @Test void recognizesHomeworkHelp() { assertThat(router.classify("Help me solve homework exercise 4")).isEqualTo(QueryIntent.HOMEWORK_HELP); }
    @Test void recognizesDirectMidtermPrediction() { assertThat(router.classify("Predict 4 new exercises for the midterm")).isEqualTo(QueryIntent.EXAM_PREDICTION); }
    @Test void keepsExamIntentForFollowUp() { assertThat(router.classify("new exercises not from homework","predict exercises which can be in the midterm")).isEqualTo(QueryIntent.EXAM_PREDICTION); }
    @Test void routesConstrainedNewExerciseToHardNewPolicy() { assertThat(router.classify("give me a new hard exercise not same as homework 1 but use topic from week 1")).isEqualTo(QueryIntent.HARD_NEW); }
    @Test void routesArbitraryCourseTopicsWithoutSubjectSpecificLogic(){assertThat(router.classify("Give me a hard Streams exercise from Week 6 unlike Homework 2")).isEqualTo(QueryIntent.HARD_NEW);assertThat(router.classify("Create a difficult BCNF problem from Week 4 unlike assignment 2")).isEqualTo(QueryIntent.HARD_NEW);assertThat(router.classify("Generate a challenging derivatives exercise from Week 3")).isEqualTo(QueryIntent.HARD_NEW);}
    @Test void hardNewScopeOutranksAReferenceToAnOldMidterm(){assertThat(router.classify("Create a new hard Week 4 exercise unlike Midterm 2025")).isEqualTo(QueryIntent.HARD_NEW);}
    @Test void defaultsToQuestionAnswering() { assertThat(router.classify("Why does Dijkstra fail with negative edges?")).isEqualTo(QueryIntent.FACTUAL_QA); }

    @Test void scopedRequestKeepsHardNewWhenEarlierTurnsMentionedTheMidterm() {
        String conversation="generate 10 exercise new which can be in midterm new exercises not same as homework\npredict exercises for the midterm";
        assertThat(router.classify("give me new hard exercise not same as homework 1 but use topic from week 1",conversation)).isEqualTo(QueryIntent.HARD_NEW);
    }
    @Test void scopedRequestSurvivesATypoInTheExerciseNoun() {
        String conversation="predict exercises which can be in the midterm";
        assertThat(router.classify("give me new hard device not same as homework 1 but use topic from week 1",conversation)).isEqualTo(QueryIntent.HARD_NEW);
    }
    @Test void explicitMidtermRequestStillOutranksAWeekConstraint() {
        assertThat(router.classify("predict new exercises for the midterm from week 3")).isEqualTo(QueryIntent.EXAM_PREDICTION);
    }
    @Test void doesNotTreatAQuestionAboutAWeekAsAGenerationRequest() {
        assertThat(router.classify("what is new in week 2 homework 1")).isNotEqualTo(QueryIntent.HARD_NEW);
    }
    @Test void scopedNewExerciseWorksForAnySubject() {
        assertThat(router.classify("create a hard new problem not like homework 2 using week 2 material")).isEqualTo(QueryIntent.HARD_NEW);
        assertThat(router.classify("give me a harder exercise from week 5, different from homework 5")).isEqualTo(QueryIntent.HARD_NEW);
    }

    @Test void askingForSupportOnANumberedItemIsNotARequestToInventANewOne() {
        assertThat(router.classify("Give me a hint for assignment 2")).isEqualTo(QueryIntent.HOMEWORK_HELP);
        assertThat(router.classify("Give me a hint for exercise 5 of the titration sheet")).isEqualTo(QueryIntent.HOMEWORK_HELP);
        assertThat(router.classify("I am stuck on problem 3 of homework 4")).isEqualTo(QueryIntent.HOMEWORK_HELP);
    }

    @Test void staleExamContextDoesNotSwallowATurnThatAsksForNoItem() {
        String conversation = "predict exercises which can be in the midterm";
        assertThat(router.classify("explain that differently", conversation)).isEqualTo(QueryIntent.EXPLAIN_TOPIC);
        assertThat(router.classify("quiz me on it instead", conversation)).isEqualTo(QueryIntent.QUIZ_GENERATION);
        assertThat(router.classify("review my mistakes first", conversation)).isEqualTo(QueryIntent.REVIEW_MISTAKES);
    }

    @Test void recognizesTheRequestVerbInOtherLanguagesWithoutASubjectLexicon() {
        assertThat(router.classify("Explícame CRC de forma sencilla")).isEqualTo(QueryIntent.EXPLAIN_TOPIC);
        assertThat(router.classify("Explícame el equilibrio químico")).isEqualTo(QueryIntent.EXPLAIN_TOPIC);
        assertThat(router.classify("Erkläre mir Enzymkinetik einfach")).isEqualTo(QueryIntent.EXPLAIN_TOPIC);
        assertThat(router.classify("Spiegami la struttura del sonetto")).isEqualTo(QueryIntent.EXPLAIN_TOPIC);
    }

    @Test void aPlanRequestIsRecognizedFromTheArtifactAlone() {
        assertThat(router.classify("Make me a 30-minute plan")).isEqualTo(QueryIntent.STUDY_PLAN);
        assertThat(router.classify("Give me a study plan for the week")).isEqualTo(QueryIntent.STUDY_PLAN);
    }

    @Test void readinessWordingIsAnalysisRatherThanPrediction() {
        assertThat(router.classify("How ready am I for the exam?")).isEqualTo(QueryIntent.EXAM_ANALYSIS);
        assertThat(router.classify("How ready am I for the final exam?")).isEqualTo(QueryIntent.EXAM_ANALYSIS);
    }

    @Test void practiceAndTypoedQuizWordingBothStartPractice() {
        assertThat(router.classify("Give me a practice exercise on CRC")).isEqualTo(QueryIntent.QUIZ_GENERATION);
        assertThat(router.classify("Quizz me on the Krebs cycle")).isEqualTo(QueryIntent.QUIZ_GENERATION);
        assertThat(router.classify("Let me practise tort law")).isEqualTo(QueryIntent.QUIZ_GENERATION);
    }

    @Test void anErrorInTheSubjectMatterIsNotAStudentMistake() {
        assertThat(router.classify("Why does CRC detect burst errors?")).isEqualTo(QueryIntent.FACTUAL_QA);
        assertThat(router.classify("Which enzymes fail at low pH?")).isEqualTo(QueryIntent.FACTUAL_QA);
    }

    /** A short turn only makes sense in the chat it was typed in: "another one" is not the same ask everywhere. */
    @Test void aChatPurposeDecidesTurnsThatSayNothingAboutWhatIsWanted() {
        assertThat(router.classify("another one", "", ChatPurpose.HARD_EXERCISES)).isEqualTo(QueryIntent.HARD_NEW);
        assertThat(router.classify("I'm stuck", "", ChatPurpose.HOMEWORK_HELP)).isEqualTo(QueryIntent.HOMEWORK_HELP);
        assertThat(router.classify("3b", "", ChatPurpose.HOMEWORK_HELP)).isEqualTo(QueryIntent.HOMEWORK_HELP);
        assertThat(router.classify("hydrolysis of esters", "", ChatPurpose.DEEP_DIVE)).isEqualTo(QueryIntent.EXPLAIN_TOPIC);
        assertThat(router.classify("consideration in contract law", "", ChatPurpose.EXAM_PREPARATION)).isEqualTo(QueryIntent.EXAM_ANALYSIS);
    }

    /**
     * The safety property behind chat purposes: a purpose is a reading of silence, never a reinterpretation.
     * Checked against every purpose so adding one cannot quietly capture wording that already routes.
     */
    @Test void aStatedPurposeNeverChangesATurnThatNamesItsOwnRequest() {
        java.util.List<String> explicit = java.util.List.of("What should I study today?", "Quiz me on chapter 4", "Help me solve homework exercise 4",
                "Predict 4 new exercises for the midterm", "give me a new hard exercise not same as homework 1 but use topic from week 1",
                "Explícame el equilibrio químico", "Review my mistakes", "How ready am I for the exam?", "Give me a hint for assignment 2");
        for (ChatPurpose purpose : ChatPurpose.values())
            for (String turn : explicit)
                assertThat(router.classify(turn, "", purpose)).as("\"%s\" in a %s chat", turn, purpose).isEqualTo(router.classify(turn, ""));
    }

    /** Asking a question in a chat meant for exercises is still asking a question. */
    @Test void aQuestionStaysAQuestionWhateverTheChatIsFor() {
        assertThat(router.classify("what does this notation mean?", "", ChatPurpose.HARD_EXERCISES)).isEqualTo(QueryIntent.FACTUAL_QA);
        assertThat(router.classify("does that hold for negative values", "", ChatPurpose.HARD_EXERCISES)).isEqualTo(QueryIntent.FACTUAL_QA);
        assertThat(router.classify("is the second condition necessary", "", ChatPurpose.HOMEWORK_HELP)).isEqualTo(QueryIntent.FACTUAL_QA);
    }

    /** An untyped chat, and the course's own main thread, must route exactly as they did before purposes existed. */
    @Test void aChatWithNoStatedPurposeRoutesUnchanged() {
        for (String turn : java.util.List.of("another one", "I'm stuck", "mitosis", "next", "3b"))
            for (ChatPurpose purpose : java.util.List.of(ChatPurpose.GENERAL, ChatPurpose.MAIN_TUTOR))
                assertThat(router.classify(turn, "", purpose)).isEqualTo(router.classify(turn, ""));
        assertThat(router.classify("another one", "", (ChatPurpose) null)).isEqualTo(router.classify("another one", ""));
    }

    /** History that already established the exam outranks the chat's own default reading. */
    @Test void whatTheConversationEstablishedOutranksThePurpose() {
        assertThat(router.classify("another one", "predict exercises which can be in the midterm", ChatPurpose.HARD_EXERCISES)).isEqualTo(QueryIntent.EXAM_PREDICTION);
    }

    /**
     * The five recorded turns that lost the thread: after one exercise was served, "another one" and
     * "another one but not this topic" were answered as questions about unrelated material. A continuation
     * states nothing about the kind of help wanted, so it has to be served as whatever the last turn was.
     */
    @Test void aContinuationIsServedAsWhateverTheLastTurnWas() {
        assertThat(router.classify("another one", "", ChatPurpose.GENERAL, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.HARD_NEW);
        assertThat(router.classify("another one but not this topic", "", ChatPurpose.GENERAL, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.HARD_NEW);
        assertThat(router.classify("one more please", "", ChatPurpose.GENERAL, QueryIntent.QUIZ_GENERATION)).isEqualTo(QueryIntent.QUIZ_GENERATION);
        assertThat(router.classify("keep going", "", ChatPurpose.GENERAL, QueryIntent.EXAM_PREDICTION)).isEqualTo(QueryIntent.EXAM_PREDICTION);
        assertThat(router.classify("ok, more", "", ChatPurpose.GENERAL, QueryIntent.EXPLAIN_TOPIC)).isEqualTo(QueryIntent.EXPLAIN_TOPIC);
        assertThat(router.classify("un altro", "", ChatPurpose.GENERAL, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.HARD_NEW);
    }

    /** The last turn is the more specific of the two silent signals, so it outranks the chat's purpose. */
    @Test void thePreviousTurnOutranksTheChatPurpose() {
        assertThat(router.classify("another one", "", ChatPurpose.HARD_EXERCISES, QueryIntent.QUIZ_GENERATION)).isEqualTo(QueryIntent.QUIZ_GENERATION);
        assertThat(router.classify("hydrolysis of esters", "", ChatPurpose.HARD_EXERCISES, QueryIntent.QUIZ_GENERATION)).isEqualTo(QueryIntent.HARD_NEW);
    }

    /** A turn that names its own kind of request outranks both the previous turn and the purpose. */
    @Test void aTurnThatNamesItsOwnRequestDoesNotInheritTheLastTurn() {
        assertThat(router.classify("explain that differently", "", ChatPurpose.GENERAL, QueryIntent.EXAM_PREDICTION)).isEqualTo(QueryIntent.EXPLAIN_TOPIC);
        assertThat(router.classify("quiz me instead", "", ChatPurpose.GENERAL, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.QUIZ_GENERATION);
        assertThat(router.classify("What should I study today?", "", ChatPurpose.GENERAL, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.STUDY_PLAN);
        assertThat(router.classify("review my mistakes first", "", ChatPurpose.GENERAL, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.REVIEW_MISTAKES);
    }

    /**
     * "Another" inside a question is about the material, not a request for more of it, and answering it is
     * correct. Asking for one outright still inherits, which is the difference between the two readings.
     */
    @Test void aQuestionThatHappensToSayAnotherStaysAQuestion() {
        assertThat(router.classify("is there another way to prove this?", "", ChatPurpose.GENERAL, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.FACTUAL_QA);
        assertThat(router.classify("does another polynomial give the same remainder?", "", ChatPurpose.GENERAL, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.FACTUAL_QA);
        assertThat(router.classify("can you give me another one?", "", ChatPurpose.GENERAL, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.HARD_NEW);
    }

    /** Nothing to inherit means nothing changes: a first turn, or a turn asking for nothing in particular. */
    @Test void inheritanceAppliesOnlyToAContinuationOfSomethingSpecific() {
        for (String turn : java.util.List.of("another one", "keep going", "mitosis", "what is a spanning tree"))
            for (ChatPurpose purpose : ChatPurpose.values())
                assertThat(router.classify(turn, "", purpose, null)).as("\"%s\" as a first turn in a %s chat", turn, purpose)
                        .isEqualTo(router.classify(turn, "", purpose));
        assertThat(router.classify("another one", "", ChatPurpose.GENERAL, QueryIntent.FACTUAL_QA)).isEqualTo(QueryIntent.FACTUAL_QA);
        assertThat(router.classify("what is a spanning tree", "", ChatPurpose.GENERAL, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.FACTUAL_QA);
    }

    /** Retrieval needs the same reading: a continuation names no topic, so its own words cannot be searched on. */
    @Test void reportsWhetherATurnOnlyAsksForMoreOfTheSame() {
        assertThat(router.continues("another one")).isTrue();
        assertThat(router.continues("give me a harder one")).isTrue();
        assertThat(router.continues("not this topic")).isTrue();
        assertThat(router.continues("What should I study today?")).isFalse();
        assertThat(router.continues("explain hydrolysis")).isFalse();
    }

    /**
     * Asking why this exercise was chosen is a question about the learner's own recorded state, so it must
     * route somewhere that supplies it. Answered as an ordinary question it gets justified with generic
     * course relevance, which is how the recorded run answered it.
     */
    @Test void askingWhyTheTutorChoseSomethingIsAQuestionAboutRecordedState() {
        assertThat(router.classify("why did you choose that topic?")).isEqualTo(QueryIntent.EXAM_ANALYSIS);
        assertThat(router.classify("Why this exercise and not the other?")).isEqualTo(QueryIntent.EXAM_ANALYSIS);
        assertThat(router.classify("why did you pick this one for me")).isEqualTo(QueryIntent.EXAM_ANALYSIS);
        assertThat(router.classify("why did you suggest starting here", "", ChatPurpose.HARD_EXERCISES, QueryIntent.HARD_NEW)).isEqualTo(QueryIntent.EXAM_ANALYSIS);
    }
}
