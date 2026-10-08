package com.studyos.prediction;

import com.studyos.assessment.ExamAnalysisService;
import com.studyos.documents.DocumentService;
import com.studyos.ingestion.DocumentType;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Imports a dedicated prediction-benchmark workspace from explicit fixture files.
 *
 * <p>Benchmark workspaces are marked by a manifest row, never by naming convention, so they cannot
 * be mistaken for ordinary learner workspaces and their corpora stay reproducible (fixture hash,
 * per-file provenance, real-vs-synthetic label). The importer is subject-neutral: it takes
 * whatever documents the corpus contains — syllabus, lectures, homework, historical exams — and
 * runs them through the ordinary ingestion and exam-analysis pipeline.
 */
@Service
public class PredictionBenchmarkService {
    private static final Logger log = LoggerFactory.getLogger(PredictionBenchmarkService.class);
    private static final String MARKER = "BENCHMARK: ";

    private final JdbcTemplate jdbc;
    private final DocumentService documents;
    private final ExamAnalysisService examAnalysis;

    public PredictionBenchmarkService(JdbcTemplate jdbc, DocumentService documents, ExamAnalysisService examAnalysis,
                                      @Value("${studyos.prediction.benchmark-max-documents:60}") int maxDocuments) {
        this.jdbc = jdbc;
        this.documents = documents;
        this.examAnalysis = examAnalysis;
        this.maxDocuments = maxDocuments;
    }

    private final int maxDocuments;

    public record Fixture(String name, String type, String content, Integer year, String examDate) {}

    public record ImportRequest(String title, String corpusKind, List<Fixture> fixtures) {}

    public record ImportResult(UUID courseId, int imported, int exams, int failed, String fixtureHash, String corpusKind) {}

    /** Every declared benchmark workspace, for the diagnostics surface. */
    public List<Map<String, Object>> manifests() {
        return jdbc.queryForList("""
                SELECT m.course_id, c.name, m.label, m.corpus_kind, m.fixture_hash, m.exam_count,
                       m.fixture_count, m.manifest::text AS manifest, m.created_at
                FROM prediction_benchmark_manifests m JOIN courses c ON c.id=m.course_id
                ORDER BY m.created_at DESC
                """);
    }

    /**
     * Creates the benchmark workspace, imports each fixture through the ordinary text pipeline
     * (PAST_EXAM fixtures carry their year/exam date as metadata), waits for processing, rebuilds
     * the exam analysis, and records the manifest. Idempotent per corpus hash: re-importing the
     * same corpus reuses the existing workspace.
     */
    public ImportResult importCorpus(ImportRequest request) {
        String label = request.title() == null || request.title().isBlank() ? "Prediction benchmark" : request.title().trim();
        String corpusKind = request.corpusKind() == null || request.corpusKind().isBlank() ? "MIXED" : request.corpusKind().trim().toUpperCase();
        List<Fixture> fixtures = request.fixtures() == null ? List.of() : request.fixtures();
        if (fixtures.isEmpty()) throw new IllegalArgumentException("A benchmark corpus needs at least one fixture document");
        if (fixtures.size() > maxDocuments) throw new IllegalArgumentException("Benchmark corpus exceeds the document cap of " + maxDocuments);

        String fixtureHash = sha256(fixtures);
        UUID existing = jdbc.query("SELECT course_id FROM prediction_benchmark_manifests WHERE fixture_hash=?",
                rs -> rs.next() ? rs.getObject(1, UUID.class) : null, fixtureHash);
        if (existing != null) {
            return new ImportResult(existing, fixtureCount(existing), examCount(existing), 0, fixtureHash, corpusKind);
        }
        // Recovery: a previous import may have created the marked workspace but failed before its
        // manifest row was written. Reuse it instead of duplicating the corpus — but only when the
        // stored document names exactly match this request, so a different corpus never hijacks it.
        UUID recoverable = jdbc.query("SELECT id FROM courses WHERE name=? ORDER BY created_at DESC LIMIT 1",
                rs -> rs.next() ? rs.getObject(1, UUID.class) : null, MARKER + label);
        if (recoverable != null && storedNames(recoverable).equals(requestedNames(fixtures))) {
            log.info("Recovering benchmark manifest for previously imported corpus {} ({})", recoverable, label);
            recordManifest(recoverable, label, corpusKind, fixtureHash, examCount(recoverable), fixtureCount(recoverable), manifestEntries(fixtures));
            return new ImportResult(recoverable, fixtureCount(recoverable), examCount(recoverable), 0, fixtureHash, corpusKind);
        }

        UUID courseId = UUID.randomUUID();
        jdbc.update("INSERT INTO courses(id,name,description) VALUES(?,?,?)",
                courseId, MARKER + label, "Dedicated prediction-benchmark workspace. Corpus kind: " + corpusKind + ". Not a learner workspace.");
        int imported = 0;
        int exams = 0;
        int failed = 0;
        List<UUID> documentIds = new ArrayList<>();
        List<Map<String, Object>> manifestEntries = new ArrayList<>();
        for (Fixture fixture : fixtures) {
            String type = fixture.type() == null ? "OTHER" : fixture.type().trim().toUpperCase();
            DocumentType documentType;
            try {
                documentType = DocumentType.valueOf(type);
            } catch (IllegalArgumentException error) {
                documentType = DocumentType.OTHER;
            }
            try {
                com.studyos.documents.DocumentController.QueuedDocument queued = documents.queueText(courseId,
                        fixture.name() == null ? "fixture-" + imported : fixture.name(),
                        fixture.content() == null ? "" : fixture.content(), documentType);
                documentIds.add(queued.documentId());
                imported++;
                if (documentType == DocumentType.PAST_EXAM) exams++;
                Map<String, Object> entry = new HashMap<>();
                entry.put("name", fixture.name());
                entry.put("type", type);
                entry.put("year", fixture.year());
                entry.put("examDate", fixture.examDate());
                manifestEntries.add(entry);
            } catch (Exception error) {
                failed++;
                log.warn("Benchmark fixture {} could not be imported: {}", fixture.name(), error.getMessage());
            }
        }

        // Exam year/date land on the documents as metadata so the corpus is reproducible even if
        // the extraction parser changes; the ordinary ingestion pipeline does the rest.
        for (int index = 0; index < documentIds.size(); index++) {
            Map<String, Object> entry = manifestEntries.get(index);
            String year = entry.get("year") == null ? "null" : entry.get("year").toString();
            String examDate = entry.get("examDate") == null ? "null" : "\"" + entry.get("examDate") + "\"";
            jdbc.update("UPDATE documents SET source_metadata=source_metadata||CAST(? AS jsonb) WHERE id=?",
                    "{\"benchmark\":{\"year\":" + year + ",\"examDate\":" + examDate + "}}", documentIds.get(index));
        }

        awaitProcessing(documentIds);
        try {
            examAnalysis.rebuild(courseId);
        } catch (RuntimeException error) {
            log.warn("Exam analysis rebuild after benchmark import failed for course {}: {}", courseId, error.getMessage());
        }

        recordManifest(courseId, label, corpusKind, fixtureHash, exams, imported, manifestEntries(fixtures));
        return new ImportResult(courseId, imported, exams, failed, fixtureHash, corpusKind);
    }

    /** Provenance for every fixture in a request, stored with the manifest row. */
    private static List<Map<String, Object>> manifestEntries(List<Fixture> fixtures) {
        List<Map<String, Object>> entries = new ArrayList<>();
        for (Fixture fixture : fixtures) {
            Map<String, Object> entry = new HashMap<>();
            entry.put("name", fixture.name());
            entry.put("type", fixture.type());
            entry.put("year", fixture.year());
            entry.put("examDate", fixture.examDate());
            entries.add(entry);
        }
        return entries;
    }

    private void recordManifest(UUID courseId, String label, String corpusKind, String fixtureHash,
                                int examCount, int fixtureCount, List<Map<String, Object>> entries) {
        jdbc.update("""
                INSERT INTO prediction_benchmark_manifests(course_id,label,corpus_kind,fixture_hash,exam_count,fixture_count,manifest)
                VALUES(?,?,?,?,?,?,CAST(? AS jsonb)) ON CONFLICT (course_id) DO UPDATE SET
                    label=EXCLUDED.label, corpus_kind=EXCLUDED.corpus_kind, fixture_hash=EXCLUDED.fixture_hash,
                    exam_count=EXCLUDED.exam_count, fixture_count=EXCLUDED.fixture_count, manifest=EXCLUDED.manifest
                """, courseId, label, corpusKind, fixtureHash, examCount, fixtureCount, json(Map.of("fixtures", entries)));
    }

    private java.util.Set<String> storedNames(UUID courseId) {
        return new java.util.HashSet<>(jdbc.queryForList("SELECT name FROM documents WHERE course_id=?", String.class, courseId));
    }

    private static java.util.Set<String> requestedNames(List<Fixture> fixtures) {
        java.util.Set<String> names = new java.util.HashSet<>();
        for (Fixture fixture : fixtures) names.add(fixture.name() == null ? "" : fixture.name());
        return names;
    }

    private void awaitProcessing(List<UUID> documentIds) {
        long deadline = System.currentTimeMillis() + 600_000;
        while (System.currentTimeMillis() < deadline) {
            int notFinished = 0;
            for (UUID documentId : documentIds) {
                String status = jdbc.query("SELECT status FROM documents WHERE id=?", rs -> rs.next() ? rs.getString(1) : null, documentId);
                if (status == null || !("COMPLETED".equals(status) || "FAILED".equals(status) || "NEEDS_OCR".equals(status))) notFinished++;
            }
            if (notFinished == 0) return;
            try { Thread.sleep(2000); } catch (InterruptedException error) { Thread.currentThread().interrupt(); return; }
        }
    }

    private int fixtureCount(UUID courseId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM documents WHERE course_id=?", Integer.class, courseId);
        return count == null ? 0 : count;
    }

    private int examCount(UUID courseId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM documents WHERE course_id=? AND document_type='PAST_EXAM'", Integer.class, courseId);
        return count == null ? 0 : count;
    }

    private String json(Object value) {
        try { return new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(value); } catch (Exception error) { return "{}"; }
    }

    static String sha256(List<Fixture> fixtures) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            for (Fixture fixture : fixtures) {
                digest.update((fixture.name() + "\n" + fixture.type() + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                digest.update((fixture.content() == null ? "" : fixture.content()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            StringBuilder result = new StringBuilder();
            for (byte b : digest.digest()) result.append(String.format("%02x", b));
            return result.toString();
        } catch (Exception error) {
            return "unavailable";
        }
    }
}
