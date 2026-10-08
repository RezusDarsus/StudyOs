package com.studyos.learning;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.studyos.adaptive.DifficultyLadder;
import com.studyos.adaptive.LadderAction;
import com.studyos.mastery.BetaEvidenceModel;
import com.studyos.mastery.KnowledgeTracing;
import com.studyos.mastery.SpacedRepetition;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The deterministic learning-loop benchmark: simulated learner histories pushed through the same
 * pure models the live loop uses (BetaEvidenceModel, KnowledgeTracing, SpacedRepetition,
 * DifficultyLadder), asserting the pedagogical contract for each scenario. No AI, no database —
 * this is the loop's behavioural specification, runnable on every build.
 */
class LearningLoopBenchmarkTest {

    /** Drives one graded attempt through the full pure stack, exactly as MasteryService does. */
    private record Attempt(BetaEvidenceModel.State evidence, SpacedRepetition.State schedule,
                           double known, DifficultyLadder.State ladder, LadderAction lastAction) {}

    private Attempt attempt(Attempt prior, double score, double difficulty, int supportUsed, boolean weakPrerequisite) {
        BetaEvidenceModel.Result evidence = BetaEvidenceModel.update(prior.evidence(), score, difficulty,
                supportUsed == 0 ? 1.0 : HintLadderWeight(supportUsed));
        int grade = SpacedRepetition.grade(evidence.boundedScore(), supportUsed);
        SpacedRepetition.State schedule = prior.schedule() == null
                ? SpacedRepetition.first(grade)
                : SpacedRepetition.next(prior.schedule(), grade, 1.0);
        KnowledgeTracing.Estimate knowledge = KnowledgeTracing.update(prior.known(), evidence.boundedScore(), difficulty, supportUsed);
        DifficultyLadder.Context context = new DifficultyLadder.Context(
                evidence.mastery(), com.studyos.adaptive.CognitiveLevel.L6_NOVEL, weakPrerequisite);
        DifficultyLadder.Decision decision = DifficultyLadder.decide(prior.ladder(),
                new DifficultyLadder.Attempt(score, supportUsed), context);
        DifficultyLadder.State ladder = new DifficultyLadder.State(decision.level(), decision.returnLevel(),
                decision.consecutiveSuccess(), decision.consecutiveFailure(), prior.ladder().attempts() + 1,
                decision.diagnosticPending());
        return new Attempt(new BetaEvidenceModel.State(evidence.alpha(), evidence.beta(), evidence.evidenceCount()),
                schedule, knowledge.known(), ladder, decision.action());
    }

    private static Attempt fresh() {
        return new Attempt(new BetaEvidenceModel.State(2, 2, 0), null, KnowledgeTracing.PRIOR_KNOWN,
                DifficultyLadder.State.fresh(com.studyos.adaptive.CognitiveLevel.L3_APPLY), LadderAction.HOLD);
    }

    private double HintLadderWeight(int supportUsed) { return com.studyos.assessment.HintLadder.evidenceWeight(supportUsed); }

    @Test
    void fastLearnerClimbsWithoutRemediation() {
        Attempt state = fresh();
        state = attempt(state, .95, .5, 0, false);  // correct
        state = attempt(state, .9, .5, 0, false);   // correct → promoted
        state = attempt(state, .95, .8, 0, false);  // correct on a harder one
        double mastery = state.evidence().alpha() / (state.evidence().alpha() + state.evidence().beta());
        assertThat(mastery).isGreaterThan(.7);
        assertThat(state.known()).isGreaterThan(.7);
        assertThat(state.ladder().level().rank()).isGreaterThanOrEqualTo(4);
        assertThat(state.ladder().diagnosticPending()).isFalse();
        // A fast learner's schedule expands: stability well above the first-review floor.
        assertThat(state.schedule().stability()).isGreaterThan(1);
    }

    @Test
    void strugglingLearnerDoesNotFakeMasteryAndGetsADiagnostic() {
        Attempt state = fresh();
        state = attempt(state, .15, .5, 0, false);  // wrong
        state = attempt(state, .3, .5, 0, false);   // wrong again
        double mastery = state.evidence().alpha() / (state.evidence().alpha() + state.evidence().beta());
        assertThat(mastery).isLessThan(.45);
        // Two misses put the ladder into a diagnosing posture at a lower level, never into promotion.
        assertThat(state.ladder().diagnosticPending()).isTrue();
        assertThat(state.ladder().level().rank()).isLessThan(3);
        // A hinted success on the way back counts for less than a clean one would have.
        Attempt hinted = attempt(state, .8, .5, 1, false);
        double masteryAfterHint = hinted.evidence().alpha() / (hinted.evidence().alpha() + hinted.evidence().beta());
        assertThat(masteryAfterHint).isLessThan(.5);
    }

    @Test
    void failingADiagnosticWithAWeakPrerequisiteTriggersRemediation() {
        Attempt state = fresh();
        state = attempt(state, .15, .5, 0, false);  // wrong
        state = attempt(state, .3, .5, 0, false);   // wrong again → DIAGNOSE
        assertThat(state.ladder().diagnosticPending()).isTrue();
        // The diagnostic itself fails, and a weak prerequisite is known: repair it first.
        Attempt diagnostic = attempt(state, .1, .3, 0, true);
        assertThat(diagnostic.lastAction()).isEqualTo(LadderAction.REMEDIATE_PREREQUISITE);
    }

    @Test
    void aGuidedSuccessIsWeakerEvidenceThanAnIndependentOne() {
        Attempt guidedPath = attempt(fresh(), .85, .5, 1, false);
        Attempt independentPath = attempt(fresh(), .85, .5, 0, false);
        double guidedMastery = guidedPath.evidence().alpha() / (guidedPath.evidence().alpha() + guidedPath.evidence().beta());
        double independentMastery = independentPath.evidence().alpha() / (independentPath.evidence().alpha() + independentPath.evidence().beta());
        assertThat(independentMastery).isGreaterThan(guidedMastery);
        // Same for the knowledge-tracing estimate: support discounts it.
        assertThat(independentPath.known()).isGreaterThan(guidedPath.known());
    }

    @Test
    void spacedReviewExpandsAfterIndependentSuccessAndShrinksAfterFailure() {
        Attempt state = fresh();
        state = attempt(state, .9, .5, 0, false);
        SpacedRepetition.State afterSuccess = state.schedule();
        Attempt failing = attempt(new Attempt(state.evidence(), afterSuccess, state.known(), state.ladder(), state.lastAction()), .1, .5, 0, false);
        assertThat(failing.schedule().stability()).isLessThan(afterSuccess.stability());
        Attempt repeatedSuccess = attempt(new Attempt(state.evidence(), afterSuccess, state.known(), state.ladder(), state.lastAction()), .9, .5, 0, false);
        assertThat(repeatedSuccess.schedule().stability()).isGreaterThan(afterSuccess.stability());
    }

    @Test
    void masteryAndConfidenceStaySeparateFacts() {
        // One strong first attempt: the mastery point estimate can be high while the evidence behind
        // it is thin. Both figures are reported, never merged.
        Attempt oneShot = attempt(fresh(), .95, .5, 0, false);
        double mastery = oneShot.evidence().alpha() / (oneShot.evidence().alpha() + oneShot.evidence().beta());
        assertThat(oneShot.evidence().evidenceCount()).isEqualTo(1);
        assertThat(mastery).isGreaterThan(.6);
        // With more evidence the same performance tightens the estimate upward, not downward.
        Attempt more = attempt(oneShot, .95, .5, 0, false);
        double tightened = more.evidence().alpha() / (more.evidence().alpha() + more.evidence().beta());
        assertThat(tightened).isGreaterThan(mastery);
    }

    @Test
    void reviewGradesFollowTheSupportContract() {
        // Unaided strong recall → GOOD; hinted → capped at HARD; near-perfect unaided → EASY; wrong → AGAIN.
        assertThat(SpacedRepetition.grade(.85, 0)).isEqualTo(SpacedRepetition.GOOD);
        assertThat(SpacedRepetition.grade(.95, 0)).isEqualTo(SpacedRepetition.EASY);
        assertThat(SpacedRepetition.grade(.95, 2)).isEqualTo(SpacedRepetition.HARD);
        assertThat(SpacedRepetition.grade(.1, 0)).isEqualTo(SpacedRepetition.AGAIN);
        // Interval after a GOOD expands; after AGAIN it stays at the floor.
        SpacedRepetition.State good = SpacedRepetition.next(SpacedRepetition.first(SpacedRepetition.GOOD), SpacedRepetition.GOOD, 1);
        SpacedRepetition.State again = SpacedRepetition.next(SpacedRepetition.first(SpacedRepetition.GOOD), SpacedRepetition.AGAIN, 1);
        assertThat(good.stability()).isGreaterThan(again.stability());
    }
}
