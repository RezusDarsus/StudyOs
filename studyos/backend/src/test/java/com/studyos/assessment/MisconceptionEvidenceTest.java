package com.studyos.assessment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.studyos.assessment.MisconceptionEvidence.Action;
import com.studyos.assessment.MisconceptionEvidence.Attempt;
import com.studyos.assessment.MisconceptionEvidence.Finding;
import com.studyos.assessment.MisconceptionEvidence.Known;
import com.studyos.assessment.MisconceptionEvidence.Verdict;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * A misconception is durable learner state — the planner raises the topic's priority, the quiz generator writes a
 * question to diagnose it, the lesson brief teaches against it. So the failure these tests exist to prevent is a
 * grading model's free text becoming a belief the learner never held, and StudyOS then teaching a course against it.
 *
 * <p>The rule being pinned is that the evidence for a claim about someone's thinking is what they actually wrote.
 * Every verdict is asserted with the figure behind it, because the figure is what a person auditing the record reads:
 * a candidate rejected with {@code groundedShare} 0 was checked and found nowhere in the attempt, and one rejected
 * with an unmeasured share was never checkable at all. Those are different failures and the table must not report
 * them as the same number.
 *
 * <p>Subjects are mixed on purpose — thermodynamics, contract law, cell biology, renal physiology, coding theory.
 * Nothing here knows any of them; the only word list in the class is English framing, so a course this code has
 * never seen has to come out the same way.
 */
class MisconceptionEvidenceTest {
    /** One physics attempt, reused: the learner wrote the mistaken thing themselves, in their own words. */
    private static final Attempt ENTROPY = new Attempt(.3, "Explain what entropy measures in an isolated system.",
            "Entropy measures the number of accessible microstates.", "Entropy is just the temperature of the system.");
    /** One contract-law attempt where the learner wrote too little to have stated anything at all. */
    private static final Attempt CONTRACT = new Attempt(.4, "State the requirements of a valid contract.",
            "Offer, acceptance, consideration and intention.", "You need an offer and both sides must agree.");

    @Test
    void admitsACandidateTheLearnersOwnWordsCarry() {
        Finding finding = MisconceptionEvidence.of("believes entropy is temperature", ENTROPY, List.of());

        assertThat(finding.verdict()).isEqualTo(Verdict.LEARNER_STATED);
        assertThat(finding.action()).isEqualTo(Action.CREATED);
        assertThat(finding.misconceptionId()).as("a created misconception has no id yet; the caller mints it").isNull();
        assertThat(finding.groundedShare()).isEqualTo(1);
        assertThat(finding.clusterSimilarity()).as("nothing was recorded to compare against").isEqualTo(MisconceptionEvidence.UNMEASURED);
        assertThat(finding.learnerExcerpt()).isEqualTo("Entropy is just the temperature of the system.");
    }

    /**
     * The distinction the whole checkpoint turns on. A candidate written in the question's vocabulary and not the
     * learner's describes an omission, and an omission is a gap, not a belief. Recorded, and nothing more.
     */
    @Test
    void refusesToInventABeliefFromWhatTheLearnerDidNotSay() {
        Finding finding = MisconceptionEvidence.of("omits consideration from the contract requirements", CONTRACT, List.of());

        assertThat(finding.verdict()).isEqualTo(Verdict.TASK_GROUNDED);
        assertThat(finding.action()).isEqualTo(Action.REJECTED);
        assertThat(finding.misconceptionId()).isNull();
        assertThat(finding.groundedShare()).as("every term was in the task, which is why it is not ungrounded").isEqualTo(1);
        assertThat(finding.learnerExcerpt()).as("their answer shares nothing, and an excerpt would overstate the evidence").isNull();
        assertThat(Verdict.TASK_GROUNDED.mayCreate()).isFalse();
        assertThat(Verdict.TASK_GROUNDED.mayReinforce()).isTrue();
    }

    /** The same candidate may still strengthen a misconception the workspace already established. */
    @Test
    void letsATaskGroundedCandidateStrengthenAnEstablishedMisconception() {
        UUID established = UUID.randomUUID();

        Finding finding = MisconceptionEvidence.of("omits consideration from the contract requirements", CONTRACT,
                List.of(new Known(established, "ignores consideration in contract requirements")));

        assertThat(finding.verdict()).isEqualTo(Verdict.TASK_GROUNDED);
        assertThat(finding.action()).isEqualTo(Action.REINFORCED);
        assertThat(finding.misconceptionId()).isEqualTo(established);
        assertThat(finding.clusterSimilarity()).isEqualTo(.75);
    }

    /**
     * The failure the checkpoint exists for: a grader naming concepts from elsewhere in the syllabus. The share is a
     * measured zero and the similarity is unmeasured, and those two must not be stored as the same thing.
     */
    @Test
    void rejectsACandidateWrittenInVocabularyFromNeitherTheTaskNorTheLearner() {
        Attempt mitosis = new Attempt(.2, "Where in the cell does mitosis take place?",
                "In the nucleus, during the M phase of the cell cycle.", "It happens in the cytoplasm during interphase.");

        Finding finding = MisconceptionEvidence.of("confuses glycolysis with oxidative phosphorylation", mitosis, List.of());

        assertThat(finding.verdict()).isEqualTo(Verdict.UNGROUNDED);
        assertThat(finding.action()).isEqualTo(Action.REJECTED);
        assertThat(finding.groundedShare()).as("checked against the attempt and found in none of it").isEqualTo(0);
        assertThat(finding.clusterSimilarity()).as("never compared, because an ungrounded candidate is not placed at all")
                .isEqualTo(MisconceptionEvidence.UNMEASURED);
    }

    /** And it cannot buy its way in through clustering: a perfect wording match is still not evidence. */
    @Test
    void doesNotLetAnUngroundedCandidateReinforceEvenAnExactMatch() {
        Attempt mitosis = new Attempt(.2, "Where in the cell does mitosis take place?",
                "In the nucleus, during the M phase of the cell cycle.", "It happens in the cytoplasm during interphase.");

        Finding finding = MisconceptionEvidence.of("confuses glycolysis with oxidative phosphorylation", mitosis,
                List.of(new Known(UUID.randomUUID(), "confuses glycolysis with oxidative phosphorylation")));

        assertThat(finding.action()).isEqualTo(Action.REJECTED);
        assertThat(finding.misconceptionId()).isNull();
        assertThat(finding.clusterSimilarity()).isEqualTo(MisconceptionEvidence.UNMEASURED);
    }

    /**
     * The mirror of never raising mastery because a learner said they understood: an answer this good is not
     * evidence of a misconception, however confidently a grader names one. The boundary is read from the grading
     * rules rather than repeated here, so the two cannot drift apart.
     */
    @Test
    void refusesToFindAMisconceptionInACorrectAnswer() {
        Attempt correct = new Attempt(AssessmentOutcomeRules.CORRECT_SCORE, ENTROPY.question(), ENTROPY.expectedAnswer(), ENTROPY.learnerAnswer());
        Attempt justBelow = new Attempt(AssessmentOutcomeRules.CORRECT_SCORE - .01, ENTROPY.question(), ENTROPY.expectedAnswer(), ENTROPY.learnerAnswer());

        Finding notAnError = MisconceptionEvidence.of("believes entropy is temperature", correct, List.of());
        Finding judged = MisconceptionEvidence.of("believes entropy is temperature", justBelow, List.of());

        assertThat(notAnError.verdict()).isEqualTo(Verdict.NOT_AN_ERROR);
        assertThat(notAnError.action()).isEqualTo(Action.REJECTED);
        assertThat(notAnError.groundedShare()).as("no grounding was measured, because the score settled it first")
                .isEqualTo(MisconceptionEvidence.UNMEASURED);
        assertThat(judged.verdict()).isEqualTo(Verdict.LEARNER_STATED);
    }

    /**
     * No attempt to check against is not the same as checked and found nowhere. Reported as one number, a table
     * could not tell a hallucinating grader from a caller that was never wired to supply the evidence.
     */
    @Test
    void separatesNothingToCheckFromCheckedAndNotFound() {
        Finding noAttempt = MisconceptionEvidence.of("believes entropy is temperature", null, List.of());
        Finding emptyAttempt = MisconceptionEvidence.of("believes entropy is temperature", new Attempt(.3, "", null, "   "), List.of());

        assertThat(noAttempt.verdict()).isEqualTo(Verdict.UNVERIFIABLE);
        assertThat(emptyAttempt.verdict()).isEqualTo(Verdict.UNVERIFIABLE);
        assertThat(noAttempt.groundedShare()).isEqualTo(MisconceptionEvidence.UNMEASURED);
        assertThat(noAttempt.verdict()).isNotEqualTo(Verdict.UNGROUNDED);
        assertThat(noAttempt.action()).isEqualTo(Action.REJECTED);
    }

    /** Nothing a course can teach against is nothing worth recording as state. */
    @Test
    void rejectsLabelsThatNameNoMisconception() {
        assertThat(MisconceptionEvidence.of(null, ENTROPY, List.of()).verdict()).isEqualTo(Verdict.MALFORMED);
        assertThat(MisconceptionEvidence.of("   ", ENTROPY, List.of()).verdict()).isEqualTo(Verdict.MALFORMED);
        assertThat(MisconceptionEvidence.of("none", ENTROPY, List.of()).verdict()).isEqualTo(Verdict.MALFORMED);
        assertThat(MisconceptionEvidence.of("no misconception detected", ENTROPY, List.of()).verdict()).isEqualTo(Verdict.MALFORMED);
        assertThat(MisconceptionEvidence.of("not applicable", ENTROPY, List.of()).verdict()).isEqualTo(Verdict.MALFORMED);
        assertThat(MisconceptionEvidence.of("the student was confused", ENTROPY, List.of()))
                .as("framing words only: it describes having a misconception without naming one")
                .satisfies(finding -> {
                    assertThat(finding.verdict()).isEqualTo(Verdict.MALFORMED);
                    assertThat(finding.action()).isEqualTo(Action.REJECTED);
                    assertThat(finding.groundedShare()).isEqualTo(MisconceptionEvidence.UNMEASURED);
                    assertThat(finding.clusterSimilarity()).isEqualTo(MisconceptionEvidence.UNMEASURED);
                });
    }

    /** A grader that returned an essay is recorded, bounded to what the column holds, and admitted to nothing. */
    @Test
    void boundsAnOverlongCandidateInsteadOfStoringIt() {
        Finding finding = MisconceptionEvidence.of("believes entropy is temperature ".repeat(20), ENTROPY, List.of());

        assertThat(finding.verdict()).isEqualTo(Verdict.MALFORMED);
        assertThat(finding.label()).hasSize(300);
    }

    /**
     * Two phrasings of one belief are one misconception with two occurrences, not two with one each. On exact-string
     * matching, which is what StudyOS did before, neither ever became severe enough for the planner to act on.
     */
    @Test
    void treatsARephrasingAsTheSameMisconception() {
        UUID established = UUID.randomUUID();

        Finding finding = MisconceptionEvidence.of("thinks that entropy just measures temperature", ENTROPY,
                List.of(new Known(established, "believes entropy is temperature")));

        assertThat(finding.action()).isEqualTo(Action.REINFORCED);
        assertThat(finding.misconceptionId()).isEqualTo(established);
        assertThat(finding.clusterSimilarity()).isCloseTo(2d / 3, within(1e-9));
    }

    /**
     * And two different beliefs about the same idea stay apart, because they need different teaching. The measured
     * similarity is kept even though it lost: it is the evidence that this really is a new misconception.
     */
    @Test
    void keepsTwoDifferentBeliefsAboutOneIdeaApart() {
        Attempt capacity = new Attempt(.3, "Explain what entropy measures in an isolated system.",
                "Entropy measures the number of accessible microstates.", "Entropy equals the heat capacity of the gas.");

        Finding finding = MisconceptionEvidence.of("believes entropy equals heat capacity", capacity,
                List.of(new Known(UUID.randomUUID(), "believes entropy is temperature")));

        assertThat(finding.action()).isEqualTo(Action.CREATED);
        assertThat(finding.misconceptionId()).isNull();
        assertThat(finding.clusterSimilarity()).as("measured, and below the threshold on purpose").isEqualTo(.25);
    }

    /** When two recorded misconceptions match equally well, the one already acted on wins rather than an arbitrary row. */
    @Test
    void breaksAClusteringTieTowardsTheStrongerMisconception() {
        UUID strongest = UUID.randomUUID();

        Finding finding = MisconceptionEvidence.of("thinks that entropy just measures temperature", ENTROPY,
                List.of(new Known(strongest, "entropy is temperature"), new Known(UUID.randomUUID(), "temperature is entropy")));

        assertThat(finding.misconceptionId()).isEqualTo(strongest);
    }

    /** The excerpt is a sentence the learner wrote, chosen for carrying the most of the candidate's vocabulary. */
    @Test
    void quotesTheLearnersOwnSentence() {
        Attempt working = new Attempt(.3, "Explain what entropy measures in an isolated system.",
                "Entropy measures the number of accessible microstates.",
                "I set up the integral first. Entropy is just the temperature of the system. Then I substituted.");

        Finding finding = MisconceptionEvidence.of("believes entropy is temperature", working, List.of());

        assertThat(finding.learnerExcerpt()).isEqualTo("Entropy is just the temperature of the system.");
    }

    /** The same judgement in five subjects the class knows nothing about. */
    @Test
    void judgesAnySubjectTheSameWay() {
        Finding renal = MisconceptionEvidence.of("believes the loop of Henle reabsorbs glucose",
                new Attempt(.3, "Which segment reabsorbs glucose?", "The proximal convoluted tubule.",
                        "The loop of Henle reabsorbs glucose before the collecting duct."), List.of());
        Finding coding = MisconceptionEvidence.of("treats the CRC remainder as the codeword",
                new Attempt(.25, "What is transmitted after the CRC division?", "The message with the remainder appended.",
                        "I sent the remainder as the codeword."), List.of());
        Finding law = MisconceptionEvidence.of("assumes a gratuitous promise is enforceable",
                new Attempt(.3, "Is a gratuitous promise binding?", "No, it lacks consideration.",
                        "A gratuitous promise is enforceable without consideration."), List.of());

        assertThat(List.of(renal, coding, law)).allSatisfy(finding -> {
            assertThat(finding.verdict()).isEqualTo(Verdict.LEARNER_STATED);
            assertThat(finding.action()).isEqualTo(Action.CREATED);
        });
    }

    /** Only one verdict may put a new belief into durable state, and anything that may create may also strengthen. */
    @Test
    void letsExactlyOneVerdictCreateDurableState() {
        assertThat(List.of(Verdict.values()).stream().filter(Verdict::mayCreate).toList()).containsExactly(Verdict.LEARNER_STATED);
        for (Verdict verdict : Verdict.values()) {
            if (verdict.mayCreate()) assertThat(verdict.mayReinforce()).as("%s creates, so it must also be allowed to strengthen", verdict).isTrue();
            if (!verdict.mayReinforce()) assertThat(verdict.mayCreate()).as("%s cannot strengthen, so it cannot create either", verdict).isFalse();
        }
    }

    /** The same candidate and the same attempt must always be judged the same way; nothing may depend on set order. */
    @Test
    void isRepeatableForTheSameEvidence() {
        List<Known> known = List.of(new Known(UUID.randomUUID(), "believes entropy is temperature"),
                new Known(UUID.randomUUID(), "believes entropy equals heat capacity"));

        assertThat(MisconceptionEvidence.of("thinks that entropy just measures temperature", ENTROPY, known))
                .isEqualTo(MisconceptionEvidence.of("thinks that entropy just measures temperature", ENTROPY, known));
    }
}
