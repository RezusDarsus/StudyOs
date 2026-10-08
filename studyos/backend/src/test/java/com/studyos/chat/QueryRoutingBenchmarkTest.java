package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The eighty recorded benchmark turns and the route each one has to be served as. The measured run put
 * strict routing at 46/80: thirty-four turns were answered as something other than what they asked for,
 * and a request that is misrouted cannot be repaired further down the pipeline — a quiz request answered
 * as a question comes back with the answers attached however good the prompt is.
 *
 * <p>The expected route is the behavioural category of the request, not the wording it happens to use.
 * "Give me a difficult quiz", "ask me one question at a time" and "check my knowledge with 3 questions"
 * are one request in three costumes, and all three have to reach the intent whose contract says to ask
 * rather than tell.
 *
 * <p>Every prompt here is from one networking course, which is the whole reason the table is a liability
 * as well as an asset: it would be easy to make it pass by naming its topics. Nothing in the router does,
 * and {@link #routesTheSameWordingInSubjectsTheBenchmarkNeverTouched()} is the guard — the same eight
 * request shapes in eight other subjects, expected to route identically.
 */
class QueryRoutingBenchmarkTest {
    private final QueryRouter router = new QueryRouter();

    /**
     * Prompt number to expected route. Three of the recorded eighty are continuations that state nothing
     * about the kind of help wanted, so they are checked separately, against what the previous turn was.
     *
     * <p>Two entries differ from the 2026-08-21 audit's own tally, both deliberately. Prompt 37 asks for an
     * exam-style exercise that copies nothing, which is a generation request rather than an analysis of the
     * exam; prompt 76 asks why a topic was selected, which is the selection-rationale question the router
     * grew a rule for after that run.
     */
    private static Map<Integer, Expected> table() {
        Map<Integer, Expected> table = new LinkedHashMap<>();
        // Grounded questions: answered from the course, and nothing else.
        table.put(1, new Expected("Why does CRC detect burst errors?", QueryIntent.FACTUAL_QA));
        table.put(2, new Expected("What is the purpose of the generator polynomial in CRC?", QueryIntent.FACTUAL_QA));
        table.put(3, new Expected("Explain the difference between sender and receiver responsibilities in CRC using my sources.", QueryIntent.EXPLAIN_TOPIC));
        table.put(4, new Expected("What does fairness mean in distributed systems according to my lectures?", QueryIntent.FACTUAL_QA));
        table.put(5, new Expected("Compare weak fairness and strong fairness using my course material.", QueryIntent.FACTUAL_QA));
        table.put(6, new Expected("What is the main idea behind a sliding-window protocol?", QueryIntent.FACTUAL_QA));
        table.put(7, new Expected("Why are sequence numbers necessary in sliding-window protocols?", QueryIntent.FACTUAL_QA));
        table.put(8, new Expected("Explain leader election in a ring using my uploaded material.", QueryIntent.EXPLAIN_TOPIC));
        table.put(9, new Expected("Compare CRC and parity as error-detection mechanisms using my sources.", QueryIntent.FACTUAL_QA));
        table.put(10, new Expected("What are the most important concepts connecting fairness, sliding window, and leader election in this course?", QueryIntent.FACTUAL_QA));
        // Teaching: a request to be taught, however the depth is qualified.
        table.put(11, new Expected("Explain CRC as if I have never studied it before.", QueryIntent.EXPLAIN_TOPIC));
        table.put(12, new Expected("Explain CRC simply first, then give me the formal explanation.", QueryIntent.EXPLAIN_TOPIC));
        table.put(13, new Expected("Teach me generator polynomial division step by step.", QueryIntent.EXPLAIN_TOPIC));
        table.put(14, new Expected("Explain fairness from intuition to the formal definition.", QueryIntent.EXPLAIN_TOPIC));
        table.put(15, new Expected("Explain sliding window with a real-world analogy.", QueryIntent.EXPLAIN_TOPIC));
        table.put(16, new Expected("Teach me leader election in a ring and then give me one small example.", QueryIntent.EXPLAIN_TOPIC));
        table.put(17, new Expected("I still don't understand sequence numbers. Explain them in another way.", QueryIntent.EXPLAIN_TOPIC));
        table.put(18, new Expected("Explain why delayed acknowledgements can cause problems in a sliding-window protocol.", QueryIntent.EXPLAIN_TOPIC));
        table.put(19, new Expected("Explain the hardest concept in Week 1 in simple language.", QueryIntent.EXPLAIN_TOPIC));
        table.put(20, new Expected("Teach me CRC, but use examples before theory.", QueryIntent.EXPLAIN_TOPIC));
        // Help with an item the learner already has: never an invitation to invent a replacement.
        table.put(21, new Expected("Help me solve homework exercise 4.", QueryIntent.HOMEWORK_HELP));
        table.put(22, new Expected("Give me a hint for assignment 2.", QueryIntent.HOMEWORK_HELP));
        table.put(23, new Expected("Walk me through problem 7 step by step.", QueryIntent.HOMEWORK_HELP));
        table.put(24, new Expected("Don't solve my homework yet. Give me only the first hint.", QueryIntent.HOMEWORK_HELP));
        table.put(25, new Expected("I am stuck on the CRC homework. What should I think about first?", QueryIntent.HOMEWORK_HELP));
        table.put(26, new Expected("Explain what this homework problem is asking me to do before solving it.", QueryIntent.HOMEWORK_HELP));
        table.put(27, new Expected("Help me with Homework 1, but don't reveal the final answer.", QueryIntent.HOMEWORK_HELP));
        table.put(28, new Expected("I think my solution to the assignment is wrong. Help me identify where my reasoning probably fails.", QueryIntent.HOMEWORK_HELP));
        // Generation: asking to be given work that does not exist yet, with or without a novelty word.
        table.put(29, new Expected("Generate a hard new Week 1 exercise unlike Homework 1.", QueryIntent.HARD_NEW));
        table.put(30, new Expected("Give me a new sliding-window problem that is not the same as my homework.", QueryIntent.HARD_NEW));
        table.put(31, new Expected("Create a harder CRC problem from my sources.", QueryIntent.HARD_NEW));
        table.put(32, new Expected("Generate a new problem about leader election.", QueryIntent.HARD_NEW));
        table.put(33, new Expected("Give me a practice exercise on CRC.", QueryIntent.QUIZ_GENERATION));
        table.put(34, new Expected("Give me an easy CRC exercise first.", QueryIntent.HARD_NEW));
        table.put(36, new Expected("Create a problem that combines fairness and leader election.", QueryIntent.HARD_NEW));
        table.put(37, new Expected("Give me an exam-style sliding-window exercise based on the concepts in my material, but don't copy an existing problem.", QueryIntent.HARD_NEW));
        table.put(38, new Expected("Generate two CRC exercises that test different skills, not just different numbers.", QueryIntent.HARD_NEW));
        // Being tested: ask, do not tell.
        table.put(39, new Expected("Quiz me on routing.", QueryIntent.QUIZ_GENERATION));
        table.put(40, new Expected("Quiz me on CRC.", QueryIntent.QUIZ_GENERATION));
        table.put(41, new Expected("Test me on CRC without showing the answer first.", QueryIntent.QUIZ_GENERATION));
        table.put(42, new Expected("Ask me one fairness question at a time.", QueryIntent.QUIZ_GENERATION));
        table.put(43, new Expected("Give me a difficult quiz on sliding window.", QueryIntent.QUIZ_GENERATION));
        table.put(44, new Expected("Quizz me on leader election.", QueryIntent.QUIZ_GENERATION));
        table.put(45, new Expected("Check my knowledge of CRC with 3 questions.", QueryIntent.QUIZ_GENERATION));
        table.put(46, new Expected("Give me a mixed quiz on the topics I am weakest at.", QueryIntent.QUIZ_GENERATION));
        // Planning: being told what to do next, whether or not the word "plan" appears.
        table.put(47, new Expected("What should I study today?", QueryIntent.STUDY_PLAN));
        table.put(48, new Expected("I have 45 minutes. What should I study today?", QueryIntent.STUDY_PLAN));
        table.put(49, new Expected("Make me a 30-minute plan.", QueryIntent.STUDY_PLAN));
        table.put(50, new Expected("I have only 15 minutes. Give me the highest-value thing to study.", QueryIntent.STUDY_PLAN));
        table.put(51, new Expected("What should I study first and why?", QueryIntent.STUDY_PLAN));
        table.put(52, new Expected("Give me a study plan based on my weaknesses.", QueryIntent.STUDY_PLAN));
        table.put(53, new Expected("I want to improve my exam readiness as quickly as possible. What should I do?", QueryIntent.STUDY_PLAN));
        table.put(54, new Expected("What should I review today if I want to focus only on forgotten material?", QueryIntent.STUDY_PLAN));
        table.put(55, new Expected("Don't give me a general plan. Tell me the single most useful thing to do next.", QueryIntent.STUDY_PLAN));
        // The learner's own recorded state, which the record answers and the course cannot.
        table.put(56, new Expected("How ready am I for the exam?", QueryIntent.EXAM_ANALYSIS));
        table.put(57, new Expected("Why is my readiness currently at this level?", QueryIntent.EXAM_ANALYSIS));
        table.put(58, new Expected("What are my biggest weaknesses right now?", QueryIntent.EXAM_ANALYSIS));
        table.put(59, new Expected("What topic am I strongest at?", QueryIntent.EXAM_ANALYSIS));
        table.put(60, new Expected("Review my recent mistakes.", QueryIntent.REVIEW_MISTAKES));
        table.put(61, new Expected("Review what I got wrong yesterday.", QueryIntent.REVIEW_MISTAKES));
        table.put(62, new Expected("What misconceptions do I currently have?", QueryIntent.REVIEW_MISTAKES));
        table.put(63, new Expected("Why do you think CRC is one of my weaknesses?", QueryIntent.EXAM_ANALYSIS));
        table.put(64, new Expected("What is the fastest way for me to improve my readiness?", QueryIntent.STUDY_PLAN));
        // Exam intelligence: what the exam is likely to want, and what it might ask.
        table.put(65, new Expected("What topics are likely important on the exam?", QueryIntent.EXAM_ANALYSIS));
        table.put(66, new Expected("Which midterm topics are most important?", QueryIntent.EXAM_ANALYSIS));
        table.put(67, new Expected("Why do you think CRC is important for the exam?", QueryIntent.EXAM_ANALYSIS));
        table.put(68, new Expected("What types of questions are likely to appear on the exam?", QueryIntent.EXAM_ANALYSIS));
        table.put(69, new Expected("Predict two new exercises that could appear on the exam.", QueryIntent.EXAM_PREDICTION));
        table.put(70, new Expected("Predict new exercises for the midterm from Week 3.", QueryIntent.EXAM_PREDICTION));
        table.put(71, new Expected("Which exam prediction has the strongest evidence and which has the weakest evidence?", QueryIntent.EXAM_PREDICTION));
        table.put(72, new Expected("Predict one new CRC exercise that could appear on my exam.", QueryIntent.EXAM_PREDICTION));
        table.put(76, new Expected("Now explain why you selected that topic for me.", QueryIntent.EXAM_ANALYSIS));
        // Robustness: another language, compressed wording, and two questions the evidence cannot settle.
        table.put(77, new Expected("Explícame CRC de forma sencilla.", QueryIntent.EXPLAIN_TOPIC));
        table.put(78, new Expected("make me plan 20 min crc weak exam tomorrow", QueryIntent.STUDY_PLAN));
        table.put(79, new Expected("What did my professor say on page 500 of my lecture?", QueryIntent.FACTUAL_QA));
        table.put(80, new Expected("According to my uploaded material, what is the exact date when the CRC algorithm was invented?", QueryIntent.FACTUAL_QA));
        return table;
    }

    private record Expected(String prompt, QueryIntent intent) {}

    /** Every turn that states its own request, routed on its own wording with no chat context at all. */
    @Test void routesEveryRecordedTurnThatStatesItsOwnRequest() {
        table().forEach((number, expected) -> assertThat(router.classify(expected.prompt()))
                .as("prompt %d: \"%s\"", number, expected.prompt()).isEqualTo(expected.intent()));
    }

    /**
     * The same table read through a chat that already has a purpose and a previous turn. A stated request
     * outranks both, so a purpose cannot quietly re-answer a turn the student was explicit about — which is
     * the property that keeps the table above meaningful in a real conversation.
     */
    @Test void aStatedRequestRoutesTheSameWayInsideAnyChat() {
        table().forEach((number, expected) -> {
            for (ChatPurpose purpose : ChatPurpose.values())
                for (QueryIntent previous : List.of(QueryIntent.HARD_NEW, QueryIntent.QUIZ_GENERATION, QueryIntent.EXAM_PREDICTION))
                    assertThat(router.classify(expected.prompt(), "", purpose, previous))
                            .as("prompt %d in a %s chat after a %s turn", number, purpose, previous).isEqualTo(expected.intent());
        });
    }

    /**
     * The four turns that say nothing about what they want. They lost the thread in the recorded run and were
     * answered as questions about unrelated material; each one has to be served as whatever the last turn was.
     * Prompt 35's comparative sits at the end of the sentence, which is where a person puts it.
     */
    @Test void continuationsAreServedAsWhateverTheLastTurnWas() {
        List<String> continuations = List.of("Now make the same topic significantly harder.", "Make another one.",
                "Make it harder.", "Don't use CRC this time. Use another weak topic.");
        for (String turn : continuations) {
            assertThat(router.continues(turn)).as("\"%s\" only asks for more of the same", turn).isTrue();
            for (QueryIntent previous : List.of(QueryIntent.HARD_NEW, QueryIntent.EXAM_PREDICTION, QueryIntent.QUIZ_GENERATION))
                assertThat(router.classify(turn, "", ChatPurpose.GENERAL, previous))
                        .as("\"%s\" after a %s turn", turn, previous).isEqualTo(previous);
        }
    }

    /**
     * The generality claim for the router, made checkable. The table above is one course's vocabulary, so the
     * risk is a rule that learns the vocabulary instead of the request. These are the same eight request
     * shapes in eight unrelated subjects, and they must route identically — if one of them fails, the router
     * has been taught a syllabus.
     */
    @Test void routesTheSameWordingInSubjectsTheBenchmarkNeverTouched() {
        assertThat(router.classify("Give me a difficult quiz on the Krebs cycle.")).isEqualTo(QueryIntent.QUIZ_GENERATION);
        assertThat(router.classify("Ask me one question at a time about tort liability.")).isEqualTo(QueryIntent.QUIZ_GENERATION);
        assertThat(router.classify("Check my understanding of titration with 4 questions.")).isEqualTo(QueryIntent.QUIZ_GENERATION);
        assertThat(router.classify("Create a problem that combines enzyme kinetics and pH buffering.")).isEqualTo(QueryIntent.HARD_NEW);
        assertThat(router.classify("Give me an easy declension exercise first.")).isEqualTo(QueryIntent.HARD_NEW);
        assertThat(router.classify("I have only 20 minutes. Give me the highest-value thing to study.")).isEqualTo(QueryIntent.STUDY_PLAN);
        assertThat(router.classify("What should I review today about Roman law?")).isEqualTo(QueryIntent.STUDY_PLAN);
        assertThat(router.classify("What is the fastest way for me to improve my readiness?")).isEqualTo(QueryIntent.STUDY_PLAN);
        assertThat(router.classify("What are my biggest weaknesses in organic chemistry right now?")).isEqualTo(QueryIntent.EXAM_ANALYSIS);
        assertThat(router.classify("Which topic am I weakest at in macroeconomics?")).isEqualTo(QueryIntent.EXAM_ANALYSIS);
        assertThat(router.classify("Why do you think pharmacokinetics is one of my weaknesses?")).isEqualTo(QueryIntent.EXAM_ANALYSIS);
        assertThat(router.classify("Give me a hint for assignment 2 of the statics sheet.")).isEqualTo(QueryIntent.HOMEWORK_HELP);
    }

    /**
     * The turns the widened rules must not swallow. Each one is a request that shares wording with a rule
     * above and means something else: material described as important, an exercise built around a weak topic,
     * an existing numbered item asked for by name, and a subject question that happens to contain "what to do".
     */
    @Test void widerRulesDoNotCaptureTurnsThatMeanSomethingElse() {
        assertThat(router.classify("What are the most important concepts in this course?")).isEqualTo(QueryIntent.FACTUAL_QA);
        assertThat(router.classify("Which midterm topics are most important?")).isEqualTo(QueryIntent.EXAM_ANALYSIS);
        assertThat(router.classify("Give me a hard Week 3 exercise on my weakest topic")).isEqualTo(QueryIntent.HARD_NEW);
        assertThat(router.classify("Give me exercise 3 of homework 1")).isEqualTo(QueryIntent.HOMEWORK_HELP);
        assertThat(router.classify("Quiz me on my weakest topics")).isEqualTo(QueryIntent.QUIZ_GENERATION);
        assertThat(router.classify("Explain the hardest concept in Week 1 in simple language.")).isEqualTo(QueryIntent.EXPLAIN_TOPIC);
        assertThat(router.continues("Explain the hardest concept in Week 1 in simple language.")).isFalse();
        assertThat(router.classify("Generate two exercises that test different skills, not just different numbers.")).isEqualTo(QueryIntent.HARD_NEW);
        assertThat(router.classify("Help me check my homework answer")).isEqualTo(QueryIntent.HOMEWORK_HELP);
    }
}
