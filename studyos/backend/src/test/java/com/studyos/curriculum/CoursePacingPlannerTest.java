package com.studyos.curriculum;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class CoursePacingPlannerTest {

    private CoursePacingPlanner.LessonWork lesson(String title, int minutes, double mastery, double importance, double difficulty, UUID... prerequisites) {
        return new CoursePacingPlanner.LessonWork(UUID.randomUUID(), UUID.randomUUID(), title, minutes, mastery, importance, difficulty, 3, List.of(prerequisites));
    }

    @Test
    void planFitsWhenCapacityAllows() {
        UUID di = UUID.randomUUID();
        var lessons = List.of(
                lesson("Dependency injection", 60, 0, 0.8, 0.2),
                lesson("Spring Security", 60, 0, 0.7, 0.4, di));
        var plan = CoursePacingPlanner.plan(lessons, 28, 60, 4);
        assertThat(plan.fits()).isTrue();
        assertThat(plan.weeksAvailable()).isEqualTo(4);
        assertThat(plan.weeks()).isNotEmpty();
        // DI must land no later than its dependent.
        int diWeek = weekOf(plan, "Dependency injection");
        int securityWeek = weekOf(plan, "Spring Security");
        assertThat(diWeek).isLessThanOrEqualTo(securityWeek);
        assertThat(plan.weeks().stream().mapToInt(CoursePacingPlanner.WeekPlan::minutes).sum()).isLessThanOrEqualTo(4 * 4 * 60);
    }

    @Test
    void capacityViolationIsReportedAndPrioritized() {
        List<CoursePacingPlanner.LessonWork> lessons = new java.util.ArrayList<>();
        for (int index = 0; index < 20; index++) {
            double importance = index < 4 ? 0.9 : 0.2;
            lessons.add(lesson("Lesson " + index, 120, 0, importance, 0.3));
        }
        var plan = CoursePacingPlanner.plan(lessons, 7, 60, 5);
        assertThat(plan.fits()).isFalse();
        assertThat(plan.requiredMinutes()).isGreaterThan(plan.availableMinutes());
        assertThat(plan.notes()).anySatisfy(note -> assertThat(note).contains("exceeds available time"));
        // What is scheduled should be dominated by the important (critical/high tier) work.
        long scheduledImportant = plan.weeks().stream().flatMap(week -> week.tasks().stream())
                .filter(task -> task.tier() == CoursePacingPlanner.Tier.CRITICAL || task.tier() == CoursePacingPlanner.Tier.HIGH).count();
        long scheduledOptional = plan.weeks().stream().flatMap(week -> week.tasks().stream())
                .filter(task -> task.tier() == CoursePacingPlanner.Tier.OPTIONAL).count();
        assertThat(scheduledImportant).isGreaterThanOrEqualTo(scheduledOptional);
        assertThat(plan.dropped()).isNotEmpty();
    }

    @Test
    void masteredLessonsReduceToReviewLoad() {
        var mastered = lesson("Already known", 60, 1.0, 0.5, 0.3);
        var fresh = lesson("New material", 60, 0, 0.5, 0.3);
        var plan = CoursePacingPlanner.plan(List.of(mastered, fresh), 7, 60, 5);
        assertThat(plan.reviewMinutes()).isEqualTo(8);
        assertThat(plan.requiredMinutes()).isLessThan(120);
        var known = plan.weeks().stream().flatMap(week -> week.tasks().stream()).filter(task -> task.title().equals("Already known")).toList();
        // Fully mastered work either shrinks to nothing or appears only as a small review task.
        known.forEach(task -> assertThat(task.minutes()).isLessThanOrEqualTo(10));
    }

    @Test
    void openEndedCoursesGetADefaultHorizon() {
        var lessons = List.of(lesson("Something", 30, 0, 0.5, 0.3));
        var plan = CoursePacingPlanner.plan(lessons, null, 60, 5);
        assertThat(plan.weeksAvailable()).isEqualTo(8);
        assertThat(plan.fits()).isTrue();
    }

    @Test
    void tiersFollowImportanceAndDifficulty() {
        assertThat(CoursePacingPlanner.tier(0.9, 0.5, 3)).isEqualTo(CoursePacingPlanner.Tier.CRITICAL);
        assertThat(CoursePacingPlanner.tier(0.5, 0.3, 1)).isEqualTo(CoursePacingPlanner.Tier.HIGH);
        assertThat(CoursePacingPlanner.tier(0.25, 0.2, 0)).isEqualTo(CoursePacingPlanner.Tier.MEDIUM);
        assertThat(CoursePacingPlanner.tier(0.05, 0.1, 0)).isEqualTo(CoursePacingPlanner.Tier.OPTIONAL);
    }

    private int weekOf(CoursePacingPlanner.Plan plan, String title) {
        return plan.weeks().stream().filter(week -> week.tasks().stream().anyMatch(task -> task.title().equals(title)))
                .findFirst().orElseThrow().week();
    }
}
