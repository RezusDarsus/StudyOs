package com.studyos.mastery;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.knowledge.TopicRegistry;
import com.studyos.support.PostgresSupport;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Concurrency invariants that unit tests with mocked JDBC can never see: the first-attempt mastery
 * race (two transactions creating the same state row at once), duplicate research source upserts
 * landing concurrently, and concurrent re-ingestion of the same document identity.
 *
 * <p>All synchronization under test is at the database — advisory locks and atomic upserts —
 * because process-local locking cannot protect a second instance.
 */
class ConcurrencyIntegrationTest {

    @BeforeAll
    static void freshDatabase() {
        PostgresSupport.reset();
    }

    @Test
    void concurrentFirstAttemptsAllCountAsEvidence() throws Exception {
        var jdbc = PostgresSupport.jdbc();
        UUID course = PostgresSupport.insertCourse();
        UUID topic = PostgresSupport.insertTopic(course, "Leader Election");
        MasteryService service = new MasteryService(jdbc);
        TransactionTemplate transaction = new TransactionTemplate(PostgresSupport.transactionManager());
        int threads = 12;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            List<Callable<Object>> tasks = new java.util.ArrayList<>();
            for (int index = 0; index < threads; index++) {
                double score = index % 2 == 0 ? 0.9 : 0.4;
                tasks.add(() -> {
                    // Mirrors production, where @Transactional wraps the whole read-decide-write.
                    transaction.executeWithoutResult(status ->
                            service.recordAssessmentResult(course, topic, score, 0.5, null, null, null, null, null, "{}"));
                    return null;
                });
            }
            pool.invokeAll(tasks);
        } finally {
            pool.shutdown();
            assertThat(pool.awaitTermination(60, TimeUnit.SECONDS)).isTrue();
        }

        // Every attempt's evidence survived: nothing was dropped to a read-modify-write race.
        var state = jdbc.queryForMap("SELECT alpha,beta,evidence_count FROM student_topic_state WHERE course_id=? AND topic_id=?", course, topic);
        assertThat((Integer) state.get("evidence_count")).isEqualTo(threads);
        // Beta-evidence semantics: every attempt adds its weight to alpha+beta exactly once. A lost
        // race would leave the state short of the sum recorded across the attempts table.
        double recordedWeight = jdbc.queryForObject("SELECT COALESCE(SUM(evidence_weight),0) FROM assessment_attempts WHERE course_id=? AND topic_id=?", Double.class, course, topic);
        assertThat((Double) state.get("alpha") + (Double) state.get("beta")).isEqualTo(4 + recordedWeight);
        assertThat(recordedWeight).isGreaterThan(0);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM assessment_attempts WHERE course_id=? AND topic_id=?", Integer.class, course, topic)).isEqualTo(threads);
    }

    @Test
    void concurrentResearchUpsertsCollapseToOneRow() throws Exception {
        var jdbc = PostgresSupport.jdbc();
        UUID course = PostgresSupport.insertCourse();
        UUID run = UUID.randomUUID();
        jdbc.update("INSERT INTO research_runs(id,course_id,goal,mode,status) VALUES(?,?, 'test','RESEARCH_ONLY','COMPLETED')", run, course);
        final var sourceSql = """
                INSERT INTO research_sources(id,course_id,run_id,document_id,url,canonical_url,domain,title,provider,query,quality_score,content_hash,byte_size,content_type,retrieved_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
                ON CONFLICT (course_id, md5(COALESCE(canonical_url, url))) DO UPDATE SET
                    run_id=EXCLUDED.run_id, document_id=EXCLUDED.document_id, retrieved_at=NOW()
                """;
        int threads = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            List<Callable<Object>> tasks = new java.util.ArrayList<>();
            for (int index = 0; index < threads; index++) {
                final UUID documentId = PostgresSupport.insertDocument(course, "WEB_SOURCE");
                final String title = "title " + index;
                tasks.add(() -> {
                    jdbc.update(sourceSql, UUID.randomUUID(), course, run, documentId,
                            "https://example.com/same", "https://example.com/same", "example.com",
                            title, "DUCKDUCKGO", "query", 0.5, "hash", 10, "text/plain");
                    return null;
                });
            }
            pool.invokeAll(tasks);
        } finally {
            pool.shutdown();
            assertThat(pool.awaitTermination(60, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM research_sources WHERE course_id=?", Integer.class, course)).isEqualTo(1);
    }

    @Test
    void concurrentTopicResolutionCreatesOneTopic() throws Exception {
        var jdbc = PostgresSupport.jdbc();
        var registry = new TopicRegistry(jdbc);
        UUID course = PostgresSupport.insertCourse();
        int threads = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        java.util.List<Callable<UUID>> tasks = new java.util.ArrayList<>();
        for (int index = 0; index < threads; index++) {
            tasks.add(() -> registry.resolveOrCreate(course, "Hyperparameter Tuning", null));
        }
        java.util.List<java.util.concurrent.Future<UUID>> futures = pool.invokeAll(tasks);
        pool.shutdown();
        assertThat(pool.awaitTermination(60, TimeUnit.SECONDS)).isTrue();
        UUID first = futures.get(0).get();
        for (java.util.concurrent.Future<UUID> future : futures) {
            assertThat(future.get()).isEqualTo(first);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE course_id=? AND normalized_name='hyperparameter tuning'", Integer.class, course)).isEqualTo(1);
    }
}
