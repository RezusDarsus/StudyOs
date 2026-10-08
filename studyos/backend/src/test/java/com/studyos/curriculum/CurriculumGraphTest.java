package com.studyos.curriculum;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class CurriculumGraphTest {
    private final UUID basics = UUID.randomUUID();
    private final UUID middle = UUID.randomUUID();
    private final UUID advanced = UUID.randomUUID();

    private CurriculumGraph.Lesson lesson(UUID id, String title, int module, int ordinal, double mastery) {
        return new CurriculumGraph.Lesson(id, UUID.randomUUID(), title, module, ordinal, 3, 25, mastery);
    }

    /** basics -> middle -> advanced, with mastery supplied per lesson. */
    private CurriculumGraph chain(double basicsMastery, double middleMastery, double advancedMastery) {
        return CurriculumGraph.of(
                List.of(lesson(basics, "Basics", 0, 0, basicsMastery),
                        lesson(middle, "Middle", 0, 1, middleMastery),
                        lesson(advanced, "Advanced", 1, 0, advancedMastery)),
                List.of(new CurriculumGraph.Edge(middle, basics), new CurriculumGraph.Edge(advanced, middle)));
    }

    @Test
    void teachesPrerequisitesBeforeWhatBuildsOnThem() {
        var order = chain(0, 0, 0).teachingOrder();

        assertThat(order).containsExactly(basics, middle, advanced);
    }

    @Test
    void aLessonIsLockedWhileWhatItRestsOnIsStillWeak() {
        var graph = chain(.2, 0, 0);

        assertThat(graph.isUnlocked(basics)).isTrue();
        assertThat(graph.isUnlocked(middle)).isFalse();
        assertThat(graph.blockers(middle)).extracting(CurriculumGraph.Lesson::title).containsExactly("Basics");
    }

    @Test
    void masteringAPrerequisiteUnlocksTheNextLesson() {
        var graph = chain(.9, .1, 0);

        assertThat(graph.isUnlocked(middle)).isTrue();
        assertThat(graph.blockers(middle)).isEmpty();
        assertThat(graph.next().title()).isEqualTo("Middle");
    }

    @Test
    void theFrontierSkipsWhatIsAlreadyMasteredAndWhatIsStillBlocked() {
        var graph = chain(.9, .9, .1);

        assertThat(graph.frontier()).extracting(CurriculumGraph.Lesson::title).containsExactly("Advanced");
    }

    @Test
    void transitivePrerequisitesAreReported() {
        assertThat(chain(0, 0, 0).prerequisiteClosure(advanced)).containsExactlyInAnyOrder(basics, middle);
    }

    @Test
    void aCycleIsReportedAsBlockedRatherThanHangingOrThrowing() {
        UUID left = UUID.randomUUID();
        UUID right = UUID.randomUUID();
        var graph = CurriculumGraph.of(List.of(lesson(left, "Left", 0, 0, .9), lesson(right, "Right", 0, 1, .9)),
                List.of(new CurriculumGraph.Edge(left, right), new CurriculumGraph.Edge(right, left)));

        assertThat(graph.isUnlocked(left)).isFalse();
        assertThat(graph.isUnlocked(right)).isFalse();
        assertThat(graph.teachingOrder()).containsExactlyInAnyOrder(left, right);
    }

    @Test
    void coverageIsWeightedByHowLongEachLessonTakes() {
        var graph = CurriculumGraph.of(
                List.of(new CurriculumGraph.Lesson(basics, null, "Short", 0, 0, 3, 10, 1.0),
                        new CurriculumGraph.Lesson(middle, null, "Long", 0, 1, 3, 90, 0.0)),
                List.of());

        assertThat(graph.coverage()).isEqualTo(10 / 100.0);
    }

    @Test
    void criticalGapsRankWeakLessonsByHowMuchDependsOnThem() {
        var graph = chain(.1, .1, .1);

        assertThat(graph.criticalGaps()).extracting(CurriculumGraph.Lesson::title).startsWith("Basics");
    }

    @Test
    void selfEdgesAndUnknownLessonsAreIgnored() {
        var graph = CurriculumGraph.of(List.of(lesson(basics, "Basics", 0, 0, .1)),
                List.of(new CurriculumGraph.Edge(basics, basics), new CurriculumGraph.Edge(basics, UUID.randomUUID())));

        assertThat(graph.directPrerequisites(basics)).isEmpty();
        assertThat(graph.isUnlocked(basics)).isTrue();
    }

    @Test
    void whenEverythingIsBlockedTheWeakestUnmasteredLessonIsStillOffered() {
        UUID left = UUID.randomUUID();
        UUID right = UUID.randomUUID();
        var graph = CurriculumGraph.of(List.of(lesson(left, "Left", 0, 0, .5), lesson(right, "Right", 0, 1, .2)),
                List.of(new CurriculumGraph.Edge(left, right), new CurriculumGraph.Edge(right, left)));

        assertThat(graph.frontier()).isEmpty();
        assertThat(graph.next().title()).isEqualTo("Right");
    }

    @Test
    void anEmptyCurriculumIsSafeToQuery() {
        var graph = CurriculumGraph.of(List.of(), List.of());

        assertThat(graph.size()).isZero();
        assertThat(graph.frontier()).isEmpty();
        assertThat(graph.next()).isNull();
        assertThat(graph.coverage()).isZero();
        assertThat(graph.criticalGaps()).isEmpty();
    }
}
