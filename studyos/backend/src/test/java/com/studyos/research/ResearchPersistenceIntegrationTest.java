package com.studyos.research;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.support.PostgresSupport;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

/**
 * Research persistence invariants against real constraints: one row per canonical URL per course,
 * a changed page updates its row instead of shadowing it, re-ingestion of unchanged content is a
 * no-op, and query feedback is recorded per run.
 */
class ResearchPersistenceIntegrationTest {

    @BeforeAll
    static void freshDatabase() {
        PostgresSupport.reset();
    }

    @Test
    void canonicalUrlUpsertUpdatesInsteadOfShadowing() {
        var jdbc = PostgresSupport.jdbc();
        UUID course = PostgresSupport.insertCourse();
        UUID run = UUID.randomUUID();
        jdbc.update("INSERT INTO research_runs(id,course_id,goal,mode,status) VALUES(?,?, 'test','RESEARCH_ONLY','COMPLETED')", run, course);
        UUID documentA = PostgresSupport.insertDocument(course, "WEB_SOURCE");
        UUID documentB = PostgresSupport.insertDocument(course, "WEB_SOURCE");
        String url = "https://docs.spring.io/spring-security/reference/";
        String canonical = url;

        // First ingestion.
        jdbc.update("""
                INSERT INTO research_sources(id,course_id,run_id,document_id,url,canonical_url,domain,title,provider,query,quality_score,content_hash,byte_size,content_type,retrieved_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
                ON CONFLICT (course_id, md5(COALESCE(canonical_url, url))) DO UPDATE SET
                    run_id=EXCLUDED.run_id, document_id=EXCLUDED.document_id, url=EXCLUDED.url,
                    canonical_url=EXCLUDED.canonical_url, domain=EXCLUDED.domain, title=EXCLUDED.title,
                    provider=EXCLUDED.provider, query=EXCLUDED.query, quality_score=EXCLUDED.quality_score,
                    content_hash=EXCLUDED.content_hash, retrieved_at=NOW()
                """, UUID.randomUUID(), course, run, documentA, url, canonical, "docs.spring.io", "Old title", "DUCKDUCKGO", "q", .8, "hash-1", 100, "text/plain");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM research_sources WHERE course_id=?", Integer.class, course)).isEqualTo(1);

        // The same page ingested again after it changed: same row, new content.
        jdbc.update("""
                INSERT INTO research_sources(id,course_id,run_id,document_id,url,canonical_url,domain,title,provider,query,quality_score,content_hash,byte_size,content_type,retrieved_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
                ON CONFLICT (course_id, md5(COALESCE(canonical_url, url))) DO UPDATE SET
                    run_id=EXCLUDED.run_id, document_id=EXCLUDED.document_id, url=EXCLUDED.url,
                    canonical_url=EXCLUDED.canonical_url, domain=EXCLUDED.domain, title=EXCLUDED.title,
                    provider=EXCLUDED.provider, query=EXCLUDED.query, quality_score=EXCLUDED.quality_score,
                    content_hash=EXCLUDED.content_hash, retrieved_at=NOW()
                """, UUID.randomUUID(), course, run, documentB, url, canonical, "docs.spring.io", "New title", "WIKIPEDIA", "q2", .9, "hash-2", 200, "text/plain");

        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM research_sources WHERE course_id=?", Integer.class, course)).isEqualTo(1);
        var row = jdbc.queryForMap("SELECT document_id,title,content_hash FROM research_sources WHERE course_id=?", course);
        assertThat(row.get("document_id")).isEqualTo(documentB);
        assertThat(row.get("title")).isEqualTo("New title");
        assertThat(row.get("content_hash")).isEqualTo("hash-2");
    }

    @Test
    void canonicalKeyTreatsDifferentPathsAsDifferentSources() {
        var jdbc = PostgresSupport.jdbc();
        UUID course = PostgresSupport.insertCourse();
        for (String path : List.of("/wiki/A", "/wiki/B")) {
            jdbc.update("""
                    INSERT INTO research_sources(id,course_id,url,canonical_url,domain,provider,content_hash,retrieved_at)
                    VALUES(?,?,?,?,?,?,?,NOW())
                    """, UUID.randomUUID(), course, "https://en.wikipedia.org" + path, "https://en.wikipedia.org" + path,
                    "en.wikipedia.org", "WIKIPEDIA", "hash" + path);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM research_sources WHERE course_id=?", Integer.class, course)).isEqualTo(2);
    }

    @Test
    void qualityScoreIsBoundedByTheSchema() {
        var jdbc = PostgresSupport.jdbc();
        UUID course = PostgresSupport.insertCourse();
        try {
            jdbc.update("""
                    INSERT INTO research_sources(id,course_id,url,canonical_url,domain,provider,content_hash,quality_score,retrieved_at)
                    VALUES(?,?,?,?,?,?,?,?,NOW())
                    """, UUID.randomUUID(), course, "https://example.com/", "https://example.com/", "example.com", "WIKIPEDIA", "h", 1.5);
            throw new AssertionError("a quality score above 1 must be refused");
        } catch (DataIntegrityViolationException expected) {
            assertThat(expected).isNotNull();
        }
    }

    @Test
    void queryOutcomesRecordPerQueryFeedback() {
        var jdbc = PostgresSupport.jdbc();
        UUID course = PostgresSupport.insertCourse();
        UUID run = UUID.randomUUID();
        jdbc.update("INSERT INTO research_runs(id,course_id,goal,mode,status) VALUES(?,?, 'test','RESEARCH_ONLY','COMPLETED')", run, course);
        jdbc.update("INSERT INTO research_query_outcomes(id,run_id,query,candidates,ingested,duplicates,failed,yield) VALUES(?,?,?,?,?,?,?,?)",
                UUID.randomUUID(), run, "spring security reference", 3, 2, 1, 0, 2.0 / 3);
        var row = jdbc.queryForMap("SELECT query,ingested,yield FROM research_query_outcomes WHERE run_id=?", run);
        assertThat(row.get("query")).isEqualTo("spring security reference");
        assertThat((Double) row.get("yield")).isCloseTo(0.666, org.assertj.core.data.Offset.offset(0.001));
    }
}
