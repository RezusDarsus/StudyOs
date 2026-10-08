package com.studyos.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.support.PostgresSupport;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * A merge must move every topic-level reference to the canonical topic inside one transaction and
 * leave the merged-away row as a redirect — mastery evidence combined, aliases carried over,
 * curriculum lessons repointed, exam signals folded. Verified against real foreign keys.
 */
class TopicMergeIntegrationTest {

    @BeforeAll
    static void freshDatabase() {
        PostgresSupport.reset();
    }

    private final TopicReconciliationService service = new TopicReconciliationService(
            PostgresSupport.jdbc(), new TopicRegistry(PostgresSupport.jdbc()), PostgresSupport.transactionManager(),
            null, null, null, null);

    @Test
    void mergeMovesEveryReferenceAndLeavesARedirect() {
        var jdbc = PostgresSupport.jdbc();
        UUID course = PostgresSupport.insertCourse();
        UUID chunk = PostgresSupport.insertChunk(course, PostgresSupport.insertDocument(course, "LECTURE"), 0, "Content about dependency injection.");
        UUID kept = PostgresSupport.insertTopic(course, "Dependency Injection");
        UUID dropped = PostgresSupport.insertTopic(course, "Dependency Injection and Inversion of Control");

        jdbc.update("INSERT INTO chunk_topics(chunk_id,topic_id,relevance) VALUES(?,?,?)", chunk, kept, .6);
        jdbc.update("INSERT INTO chunk_topics(chunk_id,topic_id,relevance) VALUES(?,?,?)", chunk, dropped, .9);
        jdbc.update("INSERT INTO student_topic_state(course_id,topic_id,mastery,alpha,beta,evidence_count) VALUES(?,?,.3,5,5,4)", course, kept);
        jdbc.update("INSERT INTO student_topic_state(course_id,topic_id,mastery,alpha,beta,evidence_count) VALUES(?,?,.9,10,5,6)", course, dropped);
        jdbc.update("INSERT INTO topic_aliases(id,course_id,topic_id,alias,normalized_alias) VALUES(?,?,?,?,?)", UUID.randomUUID(), course, dropped, "DI and IoC", "di and ioc");
        UUID lesson = UUID.randomUUID();
        UUID module = UUID.randomUUID();
        UUID curriculum = UUID.randomUUID();
        jdbc.update("INSERT INTO curricula(id,course_id,mode,title,status) VALUES(?,?, 'SOURCES','t','ACTIVE')", curriculum, course);
        jdbc.update("INSERT INTO curriculum_modules(id,curriculum_id,course_id,ordinal,title) VALUES(?,?,?,?, 'm')", module, curriculum, course, 0);
        jdbc.update("INSERT INTO curriculum_lessons(id,module_id,course_id,topic_id,ordinal,title) VALUES(?,?,?,?,0,'lesson')", lesson, module, course, dropped);
        jdbc.update("INSERT INTO exam_topic_signals(id,course_id,topic_id,relevance) VALUES(?,?,?,.7)", UUID.randomUUID(), course, dropped);
        jdbc.update("INSERT INTO exam_topic_signals(id,course_id,topic_id,relevance) VALUES(?,?,?,.5)", UUID.randomUUID(), course, kept);
        jdbc.update("INSERT INTO misconceptions(id,course_id,topic_id,label) VALUES(?,?,?,'confusion')", UUID.randomUUID(), course, dropped);
        jdbc.update("INSERT INTO topic_edges(id,course_id,source_topic_id,target_topic_id,relation_type) VALUES(?,?,?,?,'PREREQUISITE_OF')",
                UUID.randomUUID(), course, dropped, kept);
        jdbc.update("INSERT INTO topic_edges(id,course_id,source_topic_id,target_topic_id,relation_type) VALUES(?,?,?,?,'PREREQUISITE_OF')",
                UUID.randomUUID(), course, kept, dropped); // would become a self-loop after the merge
        UUID ioc = PostgresSupport.insertTopic(course, "Inversion of Control");
        jdbc.update("INSERT INTO topic_edges(id,course_id,source_topic_id,target_topic_id,relation_type) VALUES(?,?,?,?,'PREREQUISITE_OF')",
                UUID.randomUUID(), course, ioc, dropped); // survives as (IoC -> kept) after the merge
        // Objectives: one moves cleanly, one collides with an existing statement and is dropped.
        jdbc.update("INSERT INTO topic_objectives(id,course_id,topic_id,statement,normalized_statement,cognitive_level,source_kind) VALUES(?,?,?,?,?,2,'MATERIAL')",
                UUID.randomUUID(), course, dropped, "Define dependency injection", "define dependency injection");
        jdbc.update("INSERT INTO topic_objectives(id,course_id,topic_id,statement,normalized_statement,cognitive_level,source_kind) VALUES(?,?,?,?,?,3,'MATERIAL')",
                UUID.randomUUID(), course, kept, "Use DI in a container", "use di in a container");

        var verdict = new TopicReconciliationCore.Verdict(ReconciliationDecision.SAME, 0.95, "test merge",
                1.0, 0, 0, java.util.List.of());
        boolean merged = service.mergeTopics(course, new TopicReconciliationService.TopicRow(kept, "Dependency Injection", "dependency injection", null, null),
                new TopicReconciliationService.TopicRow(dropped, "Dependency Injection and Inversion of Control", "dependency injection and inversion of control", null, null), verdict);
        assertThat(merged).isTrue();

        // Redirect survives as an audit marker, nothing was deleted.
        String redirect = jdbc.queryForObject("SELECT canonical_topic_id FROM topics WHERE id=?", UUID.class, dropped).toString();
        assertThat(redirect).isEqualTo(kept.toString());
        java.sql.Timestamp mergedAt = jdbc.queryForObject("SELECT merged_at FROM topics WHERE id=?", java.sql.Timestamp.class, dropped);
        assertThat(mergedAt).isNotNull();

        // Evidence moved to the kept topic: chunk bindings merged with the higher relevance kept.
        Double relevance = jdbc.queryForObject("SELECT relevance FROM chunk_topics WHERE topic_id=? AND chunk_id=?", Double.class, kept, chunk);
        assertThat(relevance).isEqualTo(0.9);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM chunk_topics WHERE topic_id=?", Integer.class, dropped)).isZero();

        // Mastery evidence combined: alpha 5+10, beta 5+5, evidence 4+6, mastery weighted (0.3*4+0.9*6)/10=0.66.
        var state = jdbc.queryForMap("SELECT alpha,beta,evidence_count,mastery FROM student_topic_state WHERE course_id=? AND topic_id=?", course, kept);
        assertThat(state.get("alpha")).isEqualTo(15.0);
        assertThat(state.get("beta")).isEqualTo(10.0);
        assertThat(state.get("evidence_count")).isEqualTo(10);
        assertThat((Double) state.get("mastery")).isEqualTo(0.66);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM student_topic_state WHERE topic_id=?", Integer.class, dropped)).isZero();

        // Alias carried over, curriculum lesson repointed, misconception moved.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM topic_aliases WHERE topic_id=? AND normalized_alias='di and ioc'", Integer.class, kept)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT topic_id FROM curriculum_lessons WHERE id=?", UUID.class, lesson)).isEqualTo(kept);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM misconceptions WHERE topic_id=?", Integer.class, kept)).isEqualTo(1);
        // Objectives moved with fresh ids; the colliding statement was dropped, the unique one survives.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM topic_objectives WHERE topic_id=?", Integer.class, kept)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM topic_objectives WHERE topic_id=?", Integer.class, dropped)).isZero();

        // Exam signals folded: the kept row survived with the strongest relevance; the dropped row is gone.
        assertThat(jdbc.queryForObject("SELECT relevance FROM exam_topic_signals WHERE topic_id=?", Double.class, kept)).isEqualTo(0.7);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM exam_topic_signals WHERE topic_id=?", Integer.class, dropped)).isZero();

        // Edges: self-loops created by the merge died; the third-party edge was remapped to the canonical pair.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM topic_edges WHERE course_id=?", Integer.class, course)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM topic_edges WHERE course_id=? AND source_topic_id=? AND target_topic_id=?", Integer.class, course, ioc, kept)).isEqualTo(1);

        // The audit trail records what happened.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM topic_reconciliations WHERE kept_topic_id=? AND merged_topic_id=?", Integer.class, kept, dropped)).isEqualTo(1);
    }

    @Test
    void registryResolvesThroughTheRedirect() {
        var registry = new TopicRegistry(PostgresSupport.jdbc());
        UUID course = PostgresSupport.insertCourse();
        UUID kept = PostgresSupport.insertTopic(course, "Vector Clocks");
        UUID dropped = PostgresSupport.insertTopic(course, "vector clock");

        var verdict = new TopicReconciliationCore.Verdict(ReconciliationDecision.SAME, 0.95, "test", 1.0, 0, 0, java.util.List.of());
        service.mergeTopics(course, new TopicReconciliationService.TopicRow(kept, "Vector Clocks", "vector clocks", null, null),
                new TopicReconciliationService.TopicRow(dropped, "vector clock", "vector clock", null, null), verdict);

        assertThat(registry.find(course, "vector clock")).isEqualTo(kept);
        // resolveOrCreate must not resurrect the merged-away identity.
        UUID resolved = registry.resolveOrCreate(course, "vector clock", "desc");
        assertThat(resolved).isEqualTo(kept);
    }

    @Test
    void refusingAMergeLeavesEverythingUntouched() {
        var jdbc = PostgresSupport.jdbc();
        UUID courseA = PostgresSupport.insertCourse();
        UUID courseB = PostgresSupport.insertCourse();
        UUID topicA = PostgresSupport.insertTopic(courseA, "Lamport Clocks");
        UUID topicB = PostgresSupport.insertTopic(courseB, "Vector Clocks");
        jdbc.update("INSERT INTO chunk_topics(chunk_id,topic_id,relevance) VALUES(?,?,?)",
                PostgresSupport.insertChunk(courseA, PostgresSupport.insertDocument(courseA, "LECTURE"), 0, "x"), topicA, .8);

        var verdict = new TopicReconciliationCore.Verdict(ReconciliationDecision.SAME, 0.95, "bad merge", 1.0, 0, 0, java.util.List.of());
        // Different courses: the guard must refuse instead of merging cross-workspace.
        boolean merged = service.mergeTopics(courseA, new TopicReconciliationService.TopicRow(topicA, "Lamport Clocks", "lamport clocks", null, null),
                new TopicReconciliationService.TopicRow(topicB, "Vector Clocks", "vector clocks", null, null), verdict);
        assertThat(merged).isFalse();
        assertThat(jdbc.queryForObject("SELECT canonical_topic_id FROM topics WHERE id=?", UUID.class, topicB)).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM topic_reconciliations WHERE course_id=?", Integer.class, courseA)).isZero();
    }
}
