package com.studyos.planner;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.mastery.MasteryService;
import com.studyos.support.PostgresSupport;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Mastery-evidence integrity: the only path into student_topic_state is a graded attempt. A
 * client-posted score on study-task completion is a self-report — completing a task and claiming a
 * score must never move durable mastery, confidence or the review schedule.
 */
class MasteryEvidenceIntegrityTest {

    @BeforeAll
    static void freshDatabase() {
        PostgresSupport.reset();
    }

    private final JdbcTemplate jdbc = PostgresSupport.jdbc();

    @Test
    void clientPostedTaskScoresNeverTouchMastery() {
        UUID course = PostgresSupport.insertCourse();
        UUID topic = PostgresSupport.insertTopic(course, "Integrity Topic");

        StudyPlanService plans = new StudyPlanService(jdbc, new ObjectMapper(),
                new com.studyos.planner.PlannerProperties());
        StudyPlanService.Plan plan = plans.generate(course, java.time.LocalDate.now(), 60);
        StudyPlanService.Task task = plan.tasks().stream()
                .filter(candidate -> candidate.topicId() != null && candidate.topicId().equals(topic))
                .findFirst().orElse(null);
        // The planner may not schedule this topic at all; force a task row directly when it did not.
        UUID taskId;
        if (task != null) {
            taskId = task.taskId();
        } else {
            taskId = UUID.randomUUID();
            jdbc.update("""
                    INSERT INTO study_tasks(id,plan_id,topic_id,ordinal,title,reason,duration_minutes,priority,status,action)
                    SELECT ?,p.id,?,0,'Integrity task','test',20,0.5,'PENDING','PRACTICE' FROM study_plans p
                    WHERE p.course_id=? ORDER BY p.created_at DESC LIMIT 1
                    """, taskId, topic, course);
        }

        // The learner claims a perfect score by completing the task.
        plans.complete(taskId, 20, true, 1.0, 0.7, "That went great");

        Double mastery = jdbc.query("SELECT mastery FROM student_topic_state WHERE course_id=? AND topic_id=?",
                rs -> rs.next() ? rs.getDouble(1) : null, course, topic);
        Integer attempts = jdbc.queryForObject(
                "SELECT COUNT(*) FROM assessment_attempts WHERE course_id=? AND topic_id=?", Integer.class, course, topic);
        // No mastery row, no attempt, no evidence: a self-report created none of them.
        assertThat(mastery).isNull();
        assertThat(attempts).isZero();

        // The real path still works: a graded attempt moves mastery.
        new MasteryService(jdbc).recordAssessment(course, topic, .9, .5);
        Double after = jdbc.query("SELECT mastery FROM student_topic_state WHERE course_id=? AND topic_id=?",
                rs -> rs.next() ? rs.getDouble(1) : null, course, topic);
        assertThat(after).isNotNull();
    }
}
