package com.studyos.support;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Migrations must take an empty database from V1 to the latest version, be idempotent on re-run,
 * and leave every subsystem's tables in place. This is the test that would have caught broken
 * migration chains long before a live smoke test did.
 */
class PostgresMigrationIntegrationTest {

    @BeforeAll
    static void connect() {
        PostgresSupport.reset();
    }

    @Test
    void allExpectedTablesExistAfterFullMigration() {
        List<String> tables = PostgresSupport.jdbc().query(
                "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
                (rs, row) -> rs.getString(1));
        assertThat(tables).contains(
                "courses", "documents", "chunks", "topics", "topic_aliases", "topic_edges",
                "chunk_topics", "student_topic_state", "assessment_items", "assessment_item_topics",
                "exam_topic_signals", "syllabus_units", "syllabus_assessments", "research_runs",
                "research_sources", "research_query_outcomes", "curricula", "curriculum_modules",
                "curriculum_lessons", "curriculum_lesson_prerequisites", "topic_objectives",
                "topic_ladder_state", "misconceptions", "topic_reconciliations", "study_plans", "study_tasks");
    }

    @Test
    void pgvectorExtensionIsAvailableForEmbeddingColumns() {
        String extension = PostgresSupport.jdbc().queryForObject(
                "SELECT extname FROM pg_extension WHERE extname='vector'", String.class);
        assertThat(extension).isEqualTo("vector");
        // The topics embedding column actually exists with a vector type.
        String type = PostgresSupport.jdbc().queryForObject("""
                SELECT udt_name FROM information_schema.columns
                WHERE table_name='topics' AND column_name='embedding'
                """, String.class);
        assertThat(type).isEqualTo("vector");
    }

    @Test
    void reRunningMigrationsIsIdempotent() {
        Flyway.configure()
                .dataSource(PostgresSupport.dataSource())
                .load()
                .migrate();
        Integer applied = PostgresSupport.jdbc().queryForObject(
                "SELECT COUNT(*) FROM flyway_schema_history WHERE success=true", Integer.class);
        assertThat(applied).isGreaterThanOrEqualTo(47);
    }
}
