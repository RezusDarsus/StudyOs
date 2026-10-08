package com.studyos.learner;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import com.studyos.adaptive.CognitiveLevel;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class LearnerProfilerTest {
    /** Between the weakness and strength bars, so a topic contributes no area trait of its own. */
    private static final double NEUTRAL_MASTERY = .6;

    // ---- acquisition speed ------------------------------------------------------------------

    @Test void acquisitionSpeedIsJudgedAgainstTheStudentsOwnUsualRate() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(topicsOnly(
                topic("Quick one", 4, .40), topic("Usual one", 4, .20), topic("Slow one", 4, .04)));
        assertThat(subjectsOf(traits, LearnerTraitKind.FAST_ACQUISITION)).containsExactly("Quick one");
        assertThat(subjectsOf(traits, LearnerTraitKind.SLOW_ACQUISITION)).containsExactly("Slow one");
    }

    @Test void aStudentWhoIsUniformlySlowInAbsoluteTermsStillHasAFastestTopic() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(topicsOnly(
                topic("Quick for them", 5, .05), topic("Usual for them", 5, .02), topic("Slow for them", 5, .005)));
        assertThat(subjectsOf(traits, LearnerTraitKind.FAST_ACQUISITION)).containsExactly("Quick for them");
        assertThat(subjectsOf(traits, LearnerTraitKind.SLOW_ACQUISITION)).containsExactly("Slow for them");
    }

    @Test void noAcquisitionClaimIsMadeFromASingleTopic() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(topicsOnly(topic("Only topic", 9, .60)));
        assertThat(kindsOf(traits)).doesNotContain(LearnerTraitKind.FAST_ACQUISITION, LearnerTraitKind.SLOW_ACQUISITION);
    }

    @Test void topicsWithTooFewAttemptsAreNotComparable() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(topicsOnly(
                topic("Well practised", LearnerProfiler.MIN_TOPIC_ATTEMPTS, .30),
                topic("Barely touched", LearnerProfiler.MIN_TOPIC_ATTEMPTS - 1, .01)));
        assertThat(kindsOf(traits)).doesNotContain(LearnerTraitKind.FAST_ACQUISITION, LearnerTraitKind.SLOW_ACQUISITION);
    }

    @Test void aStudentWhoHasGainedNothingYetGetsNoAcquisitionVerdict() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(topicsOnly(
                topic("First", 4, 0), topic("Second", 4, 0), topic("Third", 4, .10)));
        assertThat(kindsOf(traits)).doesNotContain(LearnerTraitKind.FAST_ACQUISITION, LearnerTraitKind.SLOW_ACQUISITION);
    }

    // ---- strong and weak areas -------------------------------------------------------------

    @Test void areasSplitOnEffectiveMasteryNotOnWhatWasOnceMeasured() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(topicsOnly(
                topic("Secure", 4, .10, .82), topic("Middling", 4, .10, .60), topic("Shaky", 4, .10, .31)));
        assertThat(subjectsOf(traits, LearnerTraitKind.STRENGTH)).containsExactly("Secure");
        assertThat(subjectsOf(traits, LearnerTraitKind.WEAKNESS)).containsExactly("Shaky");
    }

    @Test void aTopicWithNoRecordedEvidenceIsNeitherStrongNorWeak() {
        LearnerProfiler.TopicEvidence untouched = new LearnerProfiler.TopicEvidence(
                UUID.randomUUID(), "Never studied", 0, 0, 0, 0, 0, 0);
        assertThat(kindsOf(LearnerProfiler.derive(topicsOnly(untouched))))
                .doesNotContain(LearnerTraitKind.WEAKNESS, LearnerTraitKind.STRENGTH);
    }

    @Test void onlyTheWorstFewWeaknessesAreKeptSoTheProfileStaysReadable() {
        List<LearnerProfiler.TopicEvidence> topics = new ArrayList<>();
        for (int i = 0; i < 7; i++) topics.add(topic("Weak " + i, 4, .10, .05 * i));
        List<LearnerProfiler.Trait> weaknesses = ofKind(
                LearnerProfiler.derive(topicsOnly(topics.toArray(LearnerProfiler.TopicEvidence[]::new))),
                LearnerTraitKind.WEAKNESS);
        assertThat(weaknesses).hasSize(5);
        assertThat(weaknesses.get(0).subject()).isEqualTo("Weak 0");
        assertThat(subjectsOf(weaknesses, LearnerTraitKind.WEAKNESS)).doesNotContain("Weak 5", "Weak 6");
    }

    // ---- recurring mistakes ----------------------------------------------------------------

    @Test void aMistakeBecomesATraitOnlyOnceItHasComeBack() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(mistakesOnly(
                mistake("Came back", LearnerProfiler.MIN_MISTAKE_OCCURRENCES, .8, "OPEN"),
                mistake("One-off slip", LearnerProfiler.MIN_MISTAKE_OCCURRENCES - 1, .9, "OPEN")));
        assertThat(subjectsOf(traits, LearnerTraitKind.RECURRING_MISTAKE)).containsExactly("Came back");
    }

    @Test void aResolvedMistakeIsNoLongerHeldAgainstTheStudent() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(mistakesOnly(
                mistake("Still open", 3, .5, "OPEN"), mistake("Cleared up", 9, .9, "resolved")));
        assertThat(subjectsOf(traits, LearnerTraitKind.RECURRING_MISTAKE)).containsExactly("Still open");
    }

    @Test void anUnlabelledMistakeIsSkippedRatherThanReportedAsBlank() {
        assertThat(kindsOf(LearnerProfiler.derive(mistakesOnly(
                mistake(null, 4, .9, "OPEN"), mistake("   ", 4, .9, "OPEN")))))
                .doesNotContain(LearnerTraitKind.RECURRING_MISTAKE);
    }

    @Test void severeAndFrequentMistakesOutrankMildOnes() {
        List<LearnerProfiler.Trait> traits = ofKind(LearnerProfiler.derive(mistakesOnly(
                mistake("Mild and rare", 2, .2, "OPEN"), mistake("Severe and frequent", 6, .9, "OPEN"))),
                LearnerTraitKind.RECURRING_MISTAKE);
        assertThat(traits).extracting(LearnerProfiler.Trait::subject)
                .containsExactly("Severe and frequent", "Mild and rare");
    }

    // ---- level ceiling ---------------------------------------------------------------------

    @Test void theCeilingIsTheLowestLevelReliablyFailedAboveALevelThatHolds() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(levelsOnly(
                level(CognitiveLevel.L2_UNDERSTAND, 5, .85), level(CognitiveLevel.L3_APPLY, 4, .35),
                level(CognitiveLevel.L4_ANALYZE, 4, .20)));
        assertThat(ofKind(traits, LearnerTraitKind.LEVEL_CEILING)).hasSize(1);
        assertThat(subjectsOf(traits, LearnerTraitKind.LEVEL_CEILING)).containsExactly(CognitiveLevel.L3_APPLY.label());
    }

    @Test void failingEverythingFromTheStartIsNotACeilingBecauseNothingHoldsBeneathIt() {
        assertThat(kindsOf(LearnerProfiler.derive(levelsOnly(
                level(CognitiveLevel.L1_RECALL, 6, .30), level(CognitiveLevel.L2_UNDERSTAND, 6, .20)))))
                .doesNotContain(LearnerTraitKind.LEVEL_CEILING);
    }

    @Test void aLevelStillWithinReachIsNotCalledACeiling() {
        assertThat(kindsOf(LearnerProfiler.derive(levelsOnly(
                level(CognitiveLevel.L2_UNDERSTAND, 6, .80), level(CognitiveLevel.L3_APPLY, 6, .55)))))
                .doesNotContain(LearnerTraitKind.LEVEL_CEILING);
    }

    @Test void aLevelWithTooLittleEvidenceCannotBeACeiling() {
        assertThat(kindsOf(LearnerProfiler.derive(levelsOnly(
                level(CognitiveLevel.L2_UNDERSTAND, 6, .80),
                level(CognitiveLevel.L3_APPLY, LearnerProfiler.MIN_LEVEL_ATTEMPTS - 1, .10)))))
                .doesNotContain(LearnerTraitKind.LEVEL_CEILING);
    }

    @Test void levelsArrivingOutOfOrderStillYieldTheLowestCeiling() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(levelsOnly(
                level(CognitiveLevel.L5_COMBINE, 4, .10), level(CognitiveLevel.L1_RECALL, 5, .90),
                level(CognitiveLevel.L4_ANALYZE, 4, .30)));
        assertThat(subjectsOf(traits, LearnerTraitKind.LEVEL_CEILING)).containsExactly(CognitiveLevel.L4_ANALYZE.label());
    }

    // ---- behaviour -------------------------------------------------------------------------

    @Test void leaningOnHintsIsReportedWithTheCountsBehindIt() {
        List<LearnerProfiler.Trait> traits = ofKind(LearnerProfiler.derive(behaviourOnly(
                new LearnerProfiler.BehaviourEvidence(10, 6, 2, 0, 0, 0, 0, 0, 0))), LearnerTraitKind.SUPPORT_RELIANCE);
        assertThat(traits).hasSize(1);
        assertThat(traits.get(0).value()).isCloseTo(.6, within(.0001));
        assertThat(traits.get(0).detail()).contains("6 of 10").contains("2 times");
    }

    @Test void occasionalHintUseIsNotAReliance() {
        assertThat(kindsOf(LearnerProfiler.derive(behaviourOnly(
                new LearnerProfiler.BehaviourEvidence(10, 3, 0, 0, 0, 0, 0, 0, 0)))))
                .doesNotContain(LearnerTraitKind.SUPPORT_RELIANCE);
    }

    @Test void hintUseIsNotJudgedFromAlmostNoAttempts() {
        assertThat(kindsOf(LearnerProfiler.derive(behaviourOnly(
                new LearnerProfiler.BehaviourEvidence(LearnerProfiler.MIN_TOPIC_ATTEMPTS - 1, 2, 0, 0, 0, 0, 0, 0, 0)))))
                .doesNotContain(LearnerTraitKind.SUPPORT_RELIANCE);
    }

    @Test void masteryThatDoesNotSurviveToTheNextSessionIsARetentionRisk() {
        List<LearnerProfiler.Trait> traits = ofKind(LearnerProfiler.derive(new LearnerProfiler.Evidence(
                List.of(topic("Decayed", 4, .10, .80, .40), topic("Also decayed", 4, .10, .60, .30)),
                List.of(), List.of(), behaviour())), LearnerTraitKind.RETENTION_RISK);
        assertThat(traits).hasSize(1);
        assertThat(traits.get(0).value()).isCloseTo(.5, within(.0001));
    }

    @Test void masteryThatHoldsBetweenSessionsIsNotFlagged() {
        assertThat(kindsOf(LearnerProfiler.derive(new LearnerProfiler.Evidence(
                List.of(topic("Held", 4, .10, .80, .78)), List.of(), List.of(), behaviour()))))
                .doesNotContain(LearnerTraitKind.RETENTION_RISK);
    }

    @Test void skippingAShareOfPlannedStepsIsReported() {
        List<LearnerProfiler.Trait> traits = ofKind(LearnerProfiler.derive(behaviourOnly(
                new LearnerProfiler.BehaviourEvidence(0, 0, 0, 0, 0, 0, 0, 6, 4))), LearnerTraitKind.TASK_AVOIDANCE);
        assertThat(traits).hasSize(1);
        assertThat(traits.get(0).value()).isCloseTo(.4, within(.0001));
        assertThat(traits.get(0).detail()).contains("4 of 10");
    }

    @Test void finishingAlmostEveryStepIsNotAvoidance() {
        assertThat(kindsOf(LearnerProfiler.derive(behaviourOnly(
                new LearnerProfiler.BehaviourEvidence(0, 0, 0, 0, 0, 0, 0, 9, 1)))))
                .doesNotContain(LearnerTraitKind.TASK_AVOIDANCE);
    }

    @Test void rhythmAndSessionLengthAreDescribedWithoutBeingJudged() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(behaviourOnly(
                new LearnerProfiler.BehaviourEvidence(0, 0, 0, 7, 28, 45, 6, 0, 0)));
        assertThat(ofKind(traits, LearnerTraitKind.STUDY_RHYTHM)).singleElement()
                .satisfies(trait -> {
                    assertThat(trait.value()).isCloseTo(.25, within(.0001));
                    assertThat(trait.detail()).contains("7 of the last 28 days");
                });
        assertThat(ofKind(traits, LearnerTraitKind.SESSION_LENGTH)).singleElement()
                .satisfies(trait -> {
                    assertThat(trait.value()).isCloseTo(.375, within(.0001));
                    assertThat(trait.detail()).contains("45 minutes");
                });
        assertThat(traits).allSatisfy(trait -> assertThat(trait.value()).isBetween(0d, 1d));
    }

    @Test void aStudentWhoHasNotShownUpYetGetsNoRhythmTrait() {
        assertThat(kindsOf(LearnerProfiler.derive(behaviourOnly(
                new LearnerProfiler.BehaviourEvidence(0, 0, 0, 0, 28, 0, 0, 0, 0)))))
                .doesNotContain(LearnerTraitKind.STUDY_RHYTHM, LearnerTraitKind.SESSION_LENGTH);
    }

    // ---- shape, ordering and generalization ------------------------------------------------

    @Test void traitsComeBackGroupedByKindAndRankedWithinIt() {
        List<LearnerProfiler.Trait> traits = LearnerProfiler.derive(new LearnerProfiler.Evidence(
                List.of(topic("Weakest", 4, .10, .10), topic("Less weak", 4, .10, .40)),
                List.of(mistake("Recurring", 4, .8, "OPEN")),
                List.of(level(CognitiveLevel.L1_RECALL, 5, .90), level(CognitiveLevel.L3_APPLY, 5, .20)),
                new LearnerProfiler.BehaviourEvidence(8, 6, 1, 5, 28, 30, 4, 5, 5)));
        assertThat(kindsOf(traits)).isSorted();
        assertThat(subjectsOf(traits, LearnerTraitKind.WEAKNESS)).containsExactly("Weakest", "Less weak");
        assertThat(traits).allSatisfy(trait -> {
            assertThat(trait.kind()).isNotNull();
            assertThat(trait.subject()).isNotBlank();
            assertThat(trait.detail()).isNotBlank();
            assertThat(trait.value()).isBetween(0d, 1d);
            assertThat(trait.confidence()).isBetween(0d, .95);
        });
    }

    /**
     * The same evidence shape has to produce the same profile whatever the course is about, because
     * every subject string comes from the workspace's own recorded topics and mistakes.
     */
    @Test void theSameEvidenceShapeYieldsTheSameProfileForAnySubject() {
        List<LearnerProfiler.Trait> chemistry = LearnerProfiler.derive(new LearnerProfiler.Evidence(
                List.of(topic("Titration", 5, .40, .30), topic("Stoichiometry", 5, .20, .80), topic("Le Chatelier", 5, .03, .45)),
                List.of(mistake("Forgets to balance the equation", 3, .7, "OPEN")),
                List.of(level(CognitiveLevel.L2_UNDERSTAND, 5, .80), level(CognitiveLevel.L4_ANALYZE, 5, .25)),
                new LearnerProfiler.BehaviourEvidence(12, 7, 3, 9, 28, 40, 7, 6, 4)));
        List<LearnerProfiler.Trait> law = LearnerProfiler.derive(new LearnerProfiler.Evidence(
                List.of(topic("Offer and acceptance", 5, .40, .30), topic("Consideration", 5, .20, .80), topic("Promissory estoppel", 5, .03, .45)),
                List.of(mistake("Confuses the burden of proof", 3, .7, "OPEN")),
                List.of(level(CognitiveLevel.L2_UNDERSTAND, 5, .80), level(CognitiveLevel.L4_ANALYZE, 5, .25)),
                new LearnerProfiler.BehaviourEvidence(12, 7, 3, 9, 28, 40, 7, 6, 4)));
        assertThat(kindsOf(law)).isEqualTo(kindsOf(chemistry));
        assertThat(law).extracting(LearnerProfiler.Trait::value).isEqualTo(chemistry.stream().map(LearnerProfiler.Trait::value).toList());
        assertThat(subjectsOf(law, LearnerTraitKind.FAST_ACQUISITION)).containsExactly("Offer and acceptance");
        assertThat(subjectsOf(law, LearnerTraitKind.RECURRING_MISTAKE)).containsExactly("Confuses the burden of proof");
    }

    @Test void anEmptyOrAbsentEvidenceSetIsSafeToDerive() {
        assertThat(LearnerProfiler.derive(null)).isEmpty();
        assertThat(LearnerProfiler.derive(new LearnerProfiler.Evidence(null, null, null, null))).isEmpty();
        assertThat(LearnerProfiler.derive(new LearnerProfiler.Evidence(List.of(), List.of(), List.of(), null))).isEmpty();
    }

    // ---- helpers under test ----------------------------------------------------------------

    @Test void confidenceRisesWithEvidenceAndNeverReachesCertainty() {
        assertThat(LearnerProfiler.confidence(0)).isZero();
        assertThat(LearnerProfiler.confidence(-5)).isZero();
        assertThat(LearnerProfiler.confidence(4)).isCloseTo(.5, within(.0001));
        assertThat(LearnerProfiler.confidence(10_000)).isEqualTo(.95);
        double previous = -1;
        for (int count = 0; count < 60; count++) {
            double confidence = LearnerProfiler.confidence(count);
            assertThat(confidence).isGreaterThanOrEqualTo(previous).isLessThanOrEqualTo(.95);
            previous = confidence;
        }
    }

    @Test void medianHandlesOddEvenAndEmptyInputWithoutReorderingTheCaller() {
        assertThat(LearnerProfiler.median(new double[0])).isZero();
        assertThat(LearnerProfiler.median(null)).isZero();
        assertThat(LearnerProfiler.median(new double[]{7})).isEqualTo(7);
        assertThat(LearnerProfiler.median(new double[]{4, 1, 3})).isEqualTo(3);
        assertThat(LearnerProfiler.median(new double[]{4, 1, 3, 2})).isCloseTo(2.5, within(.0001));
        double[] caller = {9, 1, 5};
        LearnerProfiler.median(caller);
        assertThat(caller).containsExactly(9, 1, 5);
    }

    // ---- fixtures --------------------------------------------------------------------------

    private LearnerProfiler.TopicEvidence topic(String name, int attempts, double masteryGain) {
        return topic(name, attempts, masteryGain, NEUTRAL_MASTERY);
    }

    private LearnerProfiler.TopicEvidence topic(String name, int attempts, double masteryGain, double mastery) {
        return topic(name, attempts, masteryGain, mastery, mastery);
    }

    private LearnerProfiler.TopicEvidence topic(String name, int attempts, double masteryGain, double measured, double effective) {
        return new LearnerProfiler.TopicEvidence(UUID.randomUUID(), name, attempts, attempts, .6, masteryGain, measured, effective);
    }

    private LearnerProfiler.MistakeEvidence mistake(String label, int occurrences, double severity, String status) {
        return new LearnerProfiler.MistakeEvidence(label, UUID.randomUUID(), "Some topic", occurrences, severity, status);
    }

    private LearnerProfiler.LevelEvidence level(CognitiveLevel level, int attempts, double meanScore) {
        return new LearnerProfiler.LevelEvidence(level.rank(), attempts, meanScore);
    }

    /** Behaviour counts that on their own produce no trait, for isolating the topic-driven ones. */
    private LearnerProfiler.BehaviourEvidence behaviour() {
        return new LearnerProfiler.BehaviourEvidence(0, 0, 0, 0, 0, 0, 0, 0, 0);
    }

    private LearnerProfiler.Evidence topicsOnly(LearnerProfiler.TopicEvidence... topics) {
        return new LearnerProfiler.Evidence(List.of(topics), List.of(), List.of(), null);
    }

    private LearnerProfiler.Evidence mistakesOnly(LearnerProfiler.MistakeEvidence... mistakes) {
        return new LearnerProfiler.Evidence(List.of(), List.of(mistakes), List.of(), null);
    }

    private LearnerProfiler.Evidence levelsOnly(LearnerProfiler.LevelEvidence... levels) {
        return new LearnerProfiler.Evidence(List.of(), List.of(), List.of(levels), null);
    }

    private LearnerProfiler.Evidence behaviourOnly(LearnerProfiler.BehaviourEvidence behaviour) {
        return new LearnerProfiler.Evidence(List.of(), List.of(), List.of(), behaviour);
    }

    private List<LearnerProfiler.Trait> ofKind(List<LearnerProfiler.Trait> traits, LearnerTraitKind kind) {
        return traits.stream().filter(trait -> trait.kind() == kind).toList();
    }

    private List<String> subjectsOf(List<LearnerProfiler.Trait> traits, LearnerTraitKind kind) {
        return ofKind(traits, kind).stream().map(LearnerProfiler.Trait::subject).toList();
    }

    private List<LearnerTraitKind> kindsOf(List<LearnerProfiler.Trait> traits) {
        return traits.stream().map(LearnerProfiler.Trait::kind).toList();
    }
}
