package com.studyos.verify;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The quiz failures the benchmark recorded, and the replies a checker must leave alone. The second group is the
 * harder half: a question is allowed to contain a figure, an equation, or the word "answer" in its instructions,
 * and a check that flagged those would delete the questions it was meant to protect.
 */
class QuizContractAuditTest {
    /** The measured failure: the whole quiz printed with every correct answer beside it. */
    @Test void reportsAKeySectionThatShowsTheAnswers() {
        String reply = """
                Here are 3 questions.
                1. What does the checksum protect against?
                2. Why is the divisor fixed?
                3. When does detection fail?

                ## Answers
                1. Burst errors up to the check length.
                2. Sender and receiver must agree.
                3. When the error is a multiple of the divisor.
                """;
        var findings = QuizContractAudit.findings(reply, 3);
        assertThat(findings).extracting(QuizContractAudit.Finding::kind).contains("answer key section");
        assertThat(QuizContractAudit.withoutRevealedAnswers(reply))
                .contains("What does the checksum protect against?")
                .doesNotContain("Burst errors up to the check length")
                .doesNotContain("Sender and receiver must agree");
    }

    /** The other shape of the same defect: no heading, the answer simply stated after the question. */
    @Test void reportsAnAnswerStatedBesideItsQuestion() {
        var findings = QuizContractAudit.findings("1. What is the remainder? Answer: 01110.", 1);
        assertThat(findings).extracting(QuizContractAudit.Finding::kind).contains("answer revealed");
        assertThat(QuizContractAudit.withoutRevealedAnswers("1. What is the remainder? Answer: 01110."))
                .isEqualTo("1. What is the remainder?");
    }

    @Test void reportsAnExpectedResponseSectionUnderAnyOfItsNames() {
        for (String heading : java.util.List.of("### Expected response", "**Solutions**", "Answer key:", "## Marking scheme", "Model answers"))
            assertThat(QuizContractAudit.findings("1. Ask something?\n\n" + heading + "\n1. Because it is.", 1))
                    .as(heading).extracting(QuizContractAudit.Finding::kind).contains("answer key section");
    }

    /** Prompts 39, 44 and 45: a lecture on the topic, delivered to a request to be tested. */
    @Test void reportsAReplyThatAsksNothingAtAll() {
        var findings = QuizContractAudit.findings("Leader election in a ring proceeds by passing identifiers until the largest returns to its origin.", 0);
        assertThat(findings).singleElement().extracting(QuizContractAudit.Finding::kind).isEqualTo("nothing asked");
        assertThat(findings.get(0).detail()).contains("asks nothing");
    }

    /** "Check my knowledge with 3 questions" and "ask me one at a time" both named a number. */
    @Test void reportsAQuestionCountThatIsNotWhatWasAskedFor() {
        String five = "1. A?\n2. B?\n3. C?\n4. D?\n5. E?";
        var findings = QuizContractAudit.findings(five, 3);
        assertThat(findings).singleElement().extracting(QuizContractAudit.Finding::kind).isEqualTo("question count");
        assertThat(findings.get(0).claim()).isEqualTo("5 asked");
        assertThat(findings.get(0).detail()).contains("asked for 3");
        assertThat(QuizContractAudit.findings("1. A?\n2. B?\n3. C?", 3)).isEmpty();
        assertThat(QuizContractAudit.findings("1. Only this one?", 1)).isEmpty();
    }

    /** A request that named no number cannot be violated by a count, so the count is not checked. */
    @Test void doesNotJudgeACountNobodyAskedFor() {
        assertThat(QuizContractAudit.findings("1. A?\n2. B?\n3. C?\n4. D?", 0)).isEmpty();
        assertThat(QuizContractAudit.findings("What is the remainder of the division?", -1)).isEmpty();
    }

    /**
     * Counting is by the unbroken run of item numbers, so a figure that happens to open a line cannot inflate it
     * and a question that repeats a number cannot either.
     */
    @Test void countsItemsAndNotEveryNumberOnALine() {
        assertThat(QuizContractAudit.questionsAsked("1. A?\n2. B?\n2. B again?")).isEqualTo(2);
        assertThat(QuizContractAudit.questionsAsked("1. A?\n3. C?")).isEqualTo(1);
        assertThat(QuizContractAudit.questionsAsked("## Question 1\nState the rule.\n## Question 2\nApply it.")).isEqualTo(2);
        assertThat(QuizContractAudit.questionsAsked("Q1) First\nQ2) Second\nQ3) Third")).isEqualTo(3);
        assertThat(QuizContractAudit.questionsAsked("Give the value.\n1600 m of cable is available; what is the delay?")).isEqualTo(1);
    }

    /** An unnumbered single question is still one question, which is what "ask me one at a time" produces. */
    @Test void countsAnUnnumberedQuestionByItsQuestionMark() {
        assertThat(QuizContractAudit.questionsAsked("Here is your question. Why does the divisor have to be agreed in advance?")).isEqualTo(1);
        assertThat(QuizContractAudit.findings("Here is your question. Why does the divisor have to be agreed in advance?", 1)).isEmpty();
    }

    /**
     * The replies the check must not touch. A quiz asks for an answer and says so; the questions themselves
     * contain figures and equations; and the closing invitation contains the word the key headings are built out
     * of. Flagging any of these would make the audit delete the quiz.
     */
    @Test void leavesAProperQuizCompletelyAlone() {
        String quiz = """
                Here are 2 questions on error detection. Answer in your own words and I will mark them and tell you where you stand.

                ## Question 1

                A frame carries 1101011011 and the agreed divisor is 10011. What remainder does the sender append?

                ## Question 2

                Explain why a receiver that finds a non-zero remainder cannot say which bit changed.
                """;
        assertThat(QuizContractAudit.findings(quiz, 2)).isEmpty();
        assertThat(QuizContractAudit.withoutRevealedAnswers(quiz)).isEqualTo(quiz.trim());
    }

    /** A blank to be filled in is the opposite of a disclosure, however much it looks like one. */
    @Test void leavesABlankForTheLearnerToFillAlone() {
        assertThat(QuizContractAudit.findings("1. Compute the remainder. Answer: ______", 1)).isEmpty();
        assertThat(QuizContractAudit.findings("1. Compute the remainder.\nAnswer:", 1)).isEmpty();
    }

    @Test void saysNothingWhenThereIsNothingToCheck() {
        assertThat(QuizContractAudit.findings(null, 3)).isEmpty();
        assertThat(QuizContractAudit.findings("   ", 3)).isEmpty();
        assertThat(QuizContractAudit.withoutRevealedAnswers(null)).isNull();
        assertThat(QuizContractAudit.questionsAsked(null)).isZero();
    }

    /**
     * The generality claim, made checkable. Nothing above mentions a subject, but the wording that was measured
     * came from one course and one language, and a checker is only as general as the labels it can read. These
     * are the same two defects in four other subjects, one of them writing its key in its own language.
     */
    @Test void catchesTheSameDefectsInSubjectsAndLanguagesItHasNeverSeen() {
        String pharmacology = "1. Which receptor does propranolol block?\n2. Name one contraindication.\n\n## Answers\n1. Beta-1 and beta-2.\n2. Asthma.";
        assertThat(QuizContractAudit.findings(pharmacology, 2)).extracting(QuizContractAudit.Finding::kind).contains("answer key section");
        assertThat(QuizContractAudit.withoutRevealedAnswers(pharmacology)).doesNotContain("Beta-1").contains("Which receptor");

        String law = "1. What are the elements of negligence? The correct answer is duty, breach, causation and damage.";
        assertThat(QuizContractAudit.findings(law, 1)).extracting(QuizContractAudit.Finding::kind).contains("answer revealed");

        String spanish = "1. ¿Qué mide la titulación?\n\n## Respuestas\n1. La concentración del ácido.";
        assertThat(QuizContractAudit.findings(spanish, 1)).extracting(QuizContractAudit.Finding::kind).contains("answer key section");
        assertThat(QuizContractAudit.withoutRevealedAnswers(spanish)).doesNotContain("concentración").contains("titulación");

        String german = "1. Was misst die Enthalpie?\nLösungen\n1. Die Wärmemenge.";
        assertThat(QuizContractAudit.findings(german, 1)).extracting(QuizContractAudit.Finding::kind).contains("answer key section");

        assertThat(QuizContractAudit.findings("Die Photosynthese wandelt Lichtenergie in chemische Energie um.", 0))
                .extracting(QuizContractAudit.Finding::kind).containsExactly("nothing asked");
    }
}
