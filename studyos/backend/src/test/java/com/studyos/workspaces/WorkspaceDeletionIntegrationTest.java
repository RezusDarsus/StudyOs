package com.studyos.workspaces;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.support.PostgresSupport;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Workspace deletion against real PostgreSQL: one DELETE on {@code courses} removes the workspace
 * and every course-scoped child through FK cascades, cost history survives via SET NULL, and a
 * second delete of the same workspace reports not-found without effect.
 */
class WorkspaceDeletionIntegrationTest {

    @BeforeAll
    static void freshDatabase() {
        PostgresSupport.reset();
    }

    private final JdbcTemplate jdbc = PostgresSupport.jdbc();
    private final LearningWorkspaceService service = new LearningWorkspaceService(jdbc);

    @Test
    void deletingAWorkspaceRemovesItsStateWithoutOrphans() {
        UUID course = PostgresSupport.insertCourse();
        UUID document = PostgresSupport.insertDocument(course, "PAST_EXAM");
        UUID chunk = PostgresSupport.insertChunk(course, document, 0, "Show that the protocol is fair (20 Pt)");
        UUID topic = PostgresSupport.insertTopic(course, "Fairness");
        UUID item = UUID.randomUUID();
        jdbc.update("INSERT INTO assessment_items(id,course_id,document_id,topic_id,source_type,type,prompt,points,difficulty) VALUES(?,?,?,?,?,?,?,?,?)",
                item, course, document, topic, "PAST_EXAM", "PROBLEM_SOLVING", "Fairness proof", 10.0, 0.5);
        jdbc.update("INSERT INTO student_topic_state(course_id,topic_id,mastery,confidence) VALUES(?,?,0.5,0.6)", course, topic);
        jdbc.update("INSERT INTO learning_events(id,course_id,topic_id,event_type,payload) VALUES(?,?,?,?,CAST(? AS jsonb))",
                UUID.randomUUID(), course, topic, "TEST_EVENT", "{}");
        jdbc.update("INSERT INTO ai_usage(id,course_id,operation) VALUES(?,?,?)", UUID.randomUUID(), course, "TEST");

        long documentCountBefore = countOf("documents");
        assertThat(service.delete(course)).isTrue();

        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM courses WHERE id=?", Integer.class, course)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM documents WHERE id=?", Integer.class, document)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM chunks WHERE id=?", Integer.class, chunk)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE id=?", Integer.class, topic)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM assessment_items WHERE id=?", Integer.class, item)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM student_topic_state WHERE topic_id=?", Integer.class, topic)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM learning_events WHERE course_id=?", Integer.class, course)).isZero();
        // Provider cost history is global: the reference detaches instead of disappearing.
        Integer detachedUsage = jdbc.queryForObject("SELECT COUNT(*) FROM ai_usage WHERE course_id IS NULL AND operation='TEST'", Integer.class);
        assertThat(detachedUsage).isGreaterThanOrEqualTo(1);
        // No collateral damage beyond this workspace's own rows.
        assertThat(countOf("documents")).isEqualTo(documentCountBefore - 1);
    }

    @Test
    void deletingAnUnknownWorkspaceIsANoOp() {
        assertThat(service.delete(UUID.randomUUID())).isFalse();
    }

    private long countOf(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class);
    }
}
