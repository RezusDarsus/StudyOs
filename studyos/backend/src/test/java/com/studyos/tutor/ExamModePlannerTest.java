package com.studyos.tutor;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ExamModePlannerTest {

    private ExamModePlanner.Candidate candidate(String name, double mastery, double relevance, double severity,
                                                boolean reviewDue, boolean recentFailure, String prerequisite, double prerequisiteMastery) {
        return new ExamModePlanner.Candidate(UUID.randomUUID(), name, mastery, relevance, severity, reviewDue, recentFailure, prerequisite, prerequisiteMastery);
    }

    private final List<ExamModePlanner.Structure> structures = List.of(
            new ExamModePlanner.Structure("MCQ", 0.8),
            new ExamModePlanner.Structure("SHORT_ANSWER", 0.6),
            new ExamModePlanner.Structure("PROOF", 0.3));

    @Test
    void blocksFollowTheSpecShapeWithReasons() {
        var candidates = List.of(
                candidate("Sliding window", .48, .8, 0, false, true, null, 1),
                candidate("Leader election", .67, .85, 0, true, false, null, 1),
                candidate("CRC", .9, .4, 0, false, false, null, 1),
                candidate("Fairness", .3, .75, 0, false, false, null, 1));
        var plan = ExamModePlanner.plan(candidates, structures, 74, 12L);

        assertThat(plan.daysToExam()).isEqualTo(12);
        assertThat(plan.totalMinutes()).isLessThanOrEqualTo(74);
        assertThat(plan.blocks()).isNotEmpty();
        assertThat(plan.blocks()).anySatisfy(block -> {
            assertThat(block.title()).contains("Sliding window");
            assertThat(block.reasonCodes()).contains(ExamModePlanner.MASTERY_WEAK);
        });
        assertThat(plan.blocks()).anySatisfy(block -> assertThat(block.reasonCodes()).contains(ExamModePlanner.EXAM_STRUCTURE_MIX));
        assertThat(plan.blocks()).anySatisfy(block -> assertThat(block.title()).contains("Session summary"));
        assertThat(plan.blocks()).allSatisfy(block -> {
            assertThat(block.minutes()).isPositive();
            assertThat(block.reason()).isNotBlank();
            assertThat(block.ordinal()).isGreaterThanOrEqualTo(0);
        });
    }

    @Test
    void misconceptionOrWeakPrerequisiteCreatesTheFirstRemediationBlock() {
        var withMisconception = List.of(
                candidate("Leader election", .5, .9, .7, false, false, null, 1),
                candidate("Routing", .3, .8, 0, false, false, null, 1));
        var plan = ExamModePlanner.plan(withMisconception, structures, 74, 5L);
        var first = plan.blocks().get(0);
        assertThat(first.reasonCodes()).contains(ExamModePlanner.MISCONCEPTION_ACTIVE);
        assertThat(first.title()).contains("misconception");

        var withWeakPrerequisite = List.of(
                candidate("Spring Security", .5, .9, 0, false, false, "Dependency Injection", .2));
        var secondPlan = ExamModePlanner.plan(withWeakPrerequisite, structures, 74, 5L);
        var secondFirst = secondPlan.blocks().get(0);
        assertThat(secondFirst.reasonCodes()).contains(ExamModePlanner.PREREQUISITE_GAP);
        assertThat(secondFirst.title()).contains("Dependency Injection");
    }

    @Test
    void dueReviewBecomesARetrievalCheck() {
        var candidates = List.of(
                candidate("CRC", .85, .5, 0, true, false, null, 1),
                candidate("Fairness", .3, .75, 0, false, false, null, 1));
        var plan = ExamModePlanner.plan(candidates, structures, 74, 20L);
        assertThat(plan.blocks()).anySatisfy(block -> {
            assertThat(block.title()).contains("CRC");
            assertThat(block.reasonCodes()).contains(ExamModePlanner.RETENTION_RISK);
        });
    }

    @Test
    void budgetIsNeverExceededAndMinutesSumToIt() {
        var candidates = List.of(
                candidate("A", .2, .9, .8, true, true, "P", .1),
                candidate("B", .3, .8, 0, true, false, null, 1),
                candidate("C", .4, .7, 0, false, false, null, 1),
                candidate("D", .5, .6, 0, false, false, null, 1));
        var plan = ExamModePlanner.plan(candidates, structures, 74, 3L);
        assertThat(plan.totalMinutes()).isLessThanOrEqualTo(74);
        assertThat(plan.blocks().stream().mapToInt(ExamModePlanner.Block::minutes).sum()).isEqualTo(plan.totalMinutes());
        // The summary block is a closing note, not a dump for the whole remaining budget.
        plan.blocks().stream().filter(block -> block.title().contains("Session summary"))
                .forEach(block -> assertThat(block.minutes()).isLessThanOrEqualTo(10));
    }

    @Test
    void emptyEvidenceProducesAnHonestEmptyPlan() {
        var plan = ExamModePlanner.plan(List.of(), structures, 74, null);
        assertThat(plan.blocks()).isEmpty();
        assertThat(plan.note()).isNotBlank();
    }
}
