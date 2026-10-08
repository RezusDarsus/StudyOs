package com.studyos.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.studyos.knowledge.TopicModel.Assessment;
import com.studyos.knowledge.TopicModel.Corpus;
import com.studyos.knowledge.TopicModel.Coverage;
import com.studyos.knowledge.TopicModel.Demand;
import com.studyos.knowledge.TopicModel.Observation;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Importance and difficulty are what the planner ranks by, what the ladder aims at, and what the topic list shows
 * a learner first. They are computed here with no database and no model call, so they can be pinned to fixtures.
 *
 * <p>Two failures these guard against above all. The first is treating an absence as a zero: a course whose
 * documents have no derived structure, no prerequisite edges and no past exams must come out unmeasured, not
 * uniformly unimportant, because a figure of 0 is a claim and a missing figure is not. The second is subject
 * knowledge creeping in — every figure here is relative to the course's own corpus, so the same numbers come out
 * whether the material is coding theory or contract law.
 */
class TopicModelTest {

    private static final int RUNGS = 5;

    /** The busiest topic in a fully measured course: every component is at its maximum except prominence. */
    @Test
    void scoresTheCentralTopicOfAFullyMeasuredCourse() {
        double importance = TopicModel.importance(new Coverage(10, 8, 2, 2), new Corpus(2, 8, 40), 1.0);
        // .40 * 1 + .20 * 1 + .15 * (2/3) + .25 * 1, over a full weight of 1.
        assertThat(importance).isCloseTo(.95, within(1e-9));
    }

    /**
     * The renormalisation rule, and the reason it matters. The same topic in a course with no derived structure and
     * no exam evidence reads 1.0 rather than 0.6: it is the busiest topic in everything that could be measured, and
     * dropping the two unmeasurable components must not be indistinguishable from scoring zero on them.
     */
    @Test
    void renormalisesRatherThanScoringZeroForWhatWasNotMeasured() {
        Coverage coverage = new Coverage(10, 8, 2, 0);
        assertThat(TopicModel.importance(coverage, new Corpus(2, 8, 0), null)).isCloseTo(1.0, within(1e-9));
    }

    /**
     * The distinction that renormalisation exists to preserve. Both courses have the same topic; one has structured
     * documents and this topic is never a section's title, the other has no structure at all. The first is a
     * measured zero on prominence and must drag the figure down; the second is unmeasured and must not.
     */
    @Test
    void separatesAMeasuredZeroFromAnUnmeasuredComponent() {
        Coverage coverage = new Coverage(5, 4, 1, 0);
        double structuredCourse = TopicModel.importance(coverage, new Corpus(2, 8, 40), null);
        double unstructuredCourse = TopicModel.importance(coverage, new Corpus(2, 8, 0), null);
        assertThat(structuredCourse).isCloseTo(.4, within(1e-9));
        assertThat(unstructuredCourse).isCloseTo(.5, within(1e-9));
        assertThat(structuredCourse).isLessThan(unstructuredCourse);
    }

    /** With nothing measurable at all the answer is not a number. A brand new workspace ranks nothing. */
    @Test
    void reportsImportanceUnmeasuredWhenThereIsNoCorpusToBeAShareOf() {
        assertThat(TopicModel.importance(new Coverage(0, 0, 0, 0), new Corpus(0, 0, 0), null)).isEqualTo(TopicModel.UNMEASURED);
        assertThat(TopicModel.importance(null, new Corpus(2, 8, 40), 1.0)).isEqualTo(TopicModel.UNMEASURED);
        assertThat(TopicModel.importance(new Coverage(1, 1, 1, 1), null, 1.0)).isEqualTo(TopicModel.UNMEASURED);
    }

    /**
     * Importance is a share of this course's own busiest topic, never an absolute count. The same topic measured
     * against a busier course is less central, which is what lets one implementation rank any subject.
     */
    @Test
    void measuresCoverageRelativeToTheCoursesOwnBusiestTopic() {
        Coverage coverage = new Coverage(5, 4, 2, 1);
        double inQuietCourse = TopicModel.importance(coverage, new Corpus(2, 4, 40), null);
        double inBusyCourse = TopicModel.importance(coverage, new Corpus(2, 16, 40), null);
        assertThat(inQuietCourse).isGreaterThan(inBusyCourse);
    }

    /**
     * An unaided correct answer is the strongest evidence a topic is not hard, and the shrink keeps three of them
     * from claiming certainty: the figure lands near a third, not at zero.
     */
    @Test
    void readsUnaidedCorrectAnswersAsEvidenceOfEase() {
        assertThat(TopicModel.observedDifficulty(attempts(3, 1, 0))).isCloseTo(2.0 / 7, within(1e-9));
        assertThat(TopicModel.observedDifficulty(attempts(3, 0, 0))).isCloseTo(5.0 / 7, within(1e-9));
    }

    /**
     * The reason the score alone is not what gets averaged. A right answer that needed every hint is not the same
     * evidence as one that needed none, and a model that averaged scores would call both topics equally easy.
     */
    @Test
    void countsAnAnswerThatNeededEveryHintAsHarderThanAnUnaidedOne() {
        double unaided = TopicModel.observedDifficulty(attempts(3, 1, 0));
        double fullyAssisted = TopicModel.observedDifficulty(attempts(3, 1, RUNGS));
        assertThat(unaided).isLessThan(fullyAssisted);
        assertThat(fullyAssisted).isCloseTo(.5, within(1e-9));
        assertThat(TopicModel.observed(new Observation(1, RUNGS, RUNGS))).isCloseTo(.5, within(1e-9));
        assertThat(TopicModel.observed(new Observation(1, 0, RUNGS))).isEqualTo(0);
        assertThat(TopicModel.observed(new Observation(0, 0, RUNGS))).isEqualTo(1);
    }

    /**
     * Two attempts must say nothing. One bad day would otherwise mark a topic as the hardest in the course, and the
     * ladder would hold a learner at recall level on the strength of it.
     */
    @Test
    void refusesToCallATopicHardOnFewerThanThreeAttempts() {
        assertThat(TopicModel.observedDifficulty(attempts(2, 0, 0))).isEqualTo(TopicModel.UNMEASURED);
        assertThat(TopicModel.observedDifficulty(List.of())).isEqualTo(TopicModel.UNMEASURED);
        assertThat(TopicModel.observedDifficulty(null)).isEqualTo(TopicModel.UNMEASURED);
        assertThat(TopicModel.observedDifficulty(attempts(3, 0, 0))).isNotEqualTo(TopicModel.UNMEASURED);
    }

    /**
     * A topic nobody has attempted still has a difficulty when the course sets questions on it. This is the whole
     * point of difficulty being the course's demand rather than one learner's record — a learner most needs to be
     * told what is hard before attempting it.
     */
    @Test
    void measuresDifficultyFromTheCoursesOwnQuestionsBeforeAnyAttemptExists() {
        assertThat(TopicModel.difficulty(new Demand(.8, 4, null), List.of())).isCloseTo(.8, within(1e-9));
        assertThat(TopicModel.difficulty(new Demand(null, 0, 3), List.of())).isCloseTo(.75, within(1e-9));
    }

    /** All three components together, each carrying its own weight over a full renormalised denominator. */
    @Test
    void combinesAuthoredDemandDepthAndAttempts() {
        // .40 * .8 + .25 * (3/4) + .35 * (5/7), over a full weight of 1.
        assertThat(TopicModel.difficulty(new Demand(.8, 4, 3), attempts(3, 0, 0))).isCloseTo(.7575, within(1e-9));
    }

    /**
     * Depth 0 is a measurement and null is not. A course with a built graph whose topic starts a chain scores 0 on
     * depth; a course with no graph has that component dropped, and the two must not produce the same figure.
     */
    @Test
    void treatsDepthZeroAsMeasuredAndNullDepthAsUnmeasured() {
        double rootOfABuiltGraph = TopicModel.difficulty(new Demand(.8, 4, 0), List.of());
        double noGraphAtAll = TopicModel.difficulty(new Demand(.8, 4, null), List.of());
        assertThat(rootOfABuiltGraph).isCloseTo(.32 / .65, within(1e-9));
        assertThat(noGraphAtAll).isCloseTo(.8, within(1e-9));
        assertThat(rootOfABuiltGraph).isLessThan(noGraphAtAll);
    }

    /** Nothing measured means no figure, however the emptiness arrives. */
    @Test
    void reportsDifficultyUnmeasuredWhenNoneOfItsThreeComponentsExist() {
        assertThat(TopicModel.difficulty(null, List.of())).isEqualTo(TopicModel.UNMEASURED);
        assertThat(TopicModel.difficulty(new Demand(null, 0, null), null)).isEqualTo(TopicModel.UNMEASURED);
        // A mean difficulty over no items is not a measurement, whatever value came with it.
        assertThat(TopicModel.difficulty(new Demand(.9, 0, null), List.of())).isEqualTo(TopicModel.UNMEASURED);
        // Two attempts are below the threshold, so a topic with only those is still unmeasured.
        assertThat(TopicModel.difficulty(new Demand(null, 0, null), attempts(2, 0, 0))).isEqualTo(TopicModel.UNMEASURED);
    }

    /**
     * The assembled result, including the figures that are measured from a single attempt. {@code meanScore} and
     * {@code assistanceShare} describe the attempts themselves rather than the topic, so they need no threshold —
     * but {@code observed} still does, and one attempt must leave it unmeasured.
     */
    @Test
    void assemblesTheAssessmentAndKeepsPerAttemptFiguresApartFromTheTopicFigure() {
        Assessment one = TopicModel.assess(new Coverage(4, 2, 1, 1), new Corpus(2, 8, 40), .5, new Demand(.6, 2, 1),
                List.of(new Observation(.5, 1, RUNGS)));
        assertThat(one.observations()).isEqualTo(1);
        assertThat(one.meanScore()).isCloseTo(.5, within(1e-9));
        assertThat(one.assistanceShare()).isCloseTo(.2, within(1e-9));
        assertThat(one.observed()).isEqualTo(TopicModel.UNMEASURED);
        assertThat(one.difficulty()).isNotEqualTo(TopicModel.UNMEASURED);
        assertThat(one.examRelevance()).isEqualTo(.5);

        Assessment none = TopicModel.assess(new Coverage(0, 0, 0, 0), new Corpus(0, 0, 0), null, null, List.of());
        assertThat(none.importance()).isEqualTo(TopicModel.UNMEASURED);
        assertThat(none.difficulty()).isEqualTo(TopicModel.UNMEASURED);
        assertThat(none.observed()).isEqualTo(TopicModel.UNMEASURED);
        assertThat(none.meanScore()).isEqualTo(TopicModel.UNMEASURED);
        assertThat(none.assistanceShare()).isEqualTo(TopicModel.UNMEASURED);
        assertThat(none.observations()).isZero();
    }

    /**
     * Out-of-range evidence must not escape into a stored figure. A negative score or a hint count above the ladder
     * would otherwise push a topic outside 0..1 and break the CHECK constraint the column carries.
     */
    @Test
    void keepsEveryFigureInsideZeroToOneWhateverTheEvidenceSays() {
        assertThat(TopicModel.importance(new Coverage(99, 99, 99, 99), new Corpus(1, 1, 1), 9.0)).isBetween(0.0, 1.0);
        assertThat(TopicModel.importance(new Coverage(0, -5, 0, 0), new Corpus(1, 1, 1), -9.0)).isBetween(0.0, 1.0);
        assertThat(TopicModel.difficulty(new Demand(9.0, 1, 40), attempts(3, 9, 99))).isBetween(0.0, 1.0);
        assertThat(TopicModel.observed(new Observation(-3, -3, 0))).isBetween(0.0, 1.0);
        assertThat(TopicModel.observed(null)).isEqualTo(TopicModel.UNMEASURED);
    }

    /** A gap in the evidence rows must not be counted as an attempt or throw on the way past. */
    @Test
    void ignoresMissingObservationsRatherThanCountingThem() {
        List<Observation> withGaps = new ArrayList<>(attempts(3, 0, 0));
        withGaps.add(null);
        withGaps.add(null);
        assertThat(TopicModel.assess(null, null, null, null, withGaps).observations()).isEqualTo(3);
        assertThat(TopicModel.observedDifficulty(withGaps)).isEqualTo(TopicModel.observedDifficulty(attempts(3, 0, 0)));
    }

    /** The same evidence must always give the same figures; nothing here may consult a clock or a provider. */
    @Test
    void isRepeatableForTheSameEvidence() {
        Coverage coverage = new Coverage(6, 3, 2, 2);
        Corpus corpus = new Corpus(3, 9, 25);
        Demand demand = new Demand(.55, 7, 2);
        List<Observation> observations = attempts(5, .4, 2);
        assertThat(TopicModel.assess(coverage, corpus, .3, demand, observations))
                .isEqualTo(TopicModel.assess(coverage, corpus, .3, demand, observations));
    }

    private static List<Observation> attempts(int count, double score, int supportUsed) {
        List<Observation> observations = new ArrayList<>(count);
        for (int index = 0; index < count; index++) observations.add(new Observation(score, supportUsed, RUNGS));
        return List.copyOf(observations);
    }
}
