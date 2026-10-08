package com.studyos.assessment;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Runs the syllabus parsing pipeline over an ingested document and stores the normalized result.
 *
 * <p>Pipeline: deterministic detection → deterministic parse → confidence → structured LLM fallback
 * when a syllabus-looking document produced nothing → grounding validation (both parsers) →
 * persistence. The parse outcome — including a refused parse — is recorded on the document's
 * {@code source_metadata}, so a silent zero-result parse is impossible to miss again.
 */
@Service
public class SyllabusService {
    private static final Logger log = LoggerFactory.getLogger(SyllabusService.class);
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final SyllabusLlmParser llmParser;
    public SyllabusService(JdbcTemplate jdbc, ObjectMapper mapper, SyllabusLlmParser llmParser) { this.jdbc = jdbc; this.mapper = mapper; this.llmParser = llmParser; }

    public void extractDocument(UUID workspaceId, UUID documentId) {
        String type = jdbc.query("SELECT document_type FROM documents WHERE id=? AND course_id=?", rs -> rs.next() ? rs.getString(1) : null, documentId, workspaceId);
        if (!"SYLLABUS".equals(type)) return;
        List<ChunkRow> rows = jdbc.query("SELECT id,content,COALESCE(page_start,0) FROM chunks WHERE document_id=? ORDER BY ordinal", (rs, row) -> new ChunkRow(rs.getObject(1, UUID.class), rs.getString(2), rs.getInt(3)), documentId);
        if (rows.isEmpty()) return;
        List<SyllabusParser.ChunkInput> chunks = rows.stream().map(row -> new SyllabusParser.ChunkInput(row.id(), row.content())).toList();
        String joined = String.join("\n", rows.stream().map(row -> row.content() == null ? "" : row.content()).toList());

        SyllabusParser.Detection detection = SyllabusParser.detect(joined);
        SyllabusParser.ParseResult result = SyllabusParser.parseDocument(chunks, detection);
        List<String> issues = new ArrayList<>(result.issues());
        SyllabusParser.ParseConfidence confidence = result.confidence();

        // Zero-result protection: a syllabus-shaped document with nothing parsed escalates to the
        // structured LLM fallback before anything is accepted as "no syllabus content".
        List<SyllabusParser.ParsedUnit> units = new ArrayList<>(result.units());
        List<SyllabusParser.ParsedAssessment> assessments = new ArrayList<>(result.assessments());
        if (result.status() == SyllabusParser.ParseStatus.SYLLABUS_DETECTED_BUT_UNPARSED) {
            SyllabusLlmParser.Fallback fallback = llmParser.extract(chunks);
            issues.addAll(fallback.issues());
            if (fallback.used() && !fallback.units().isEmpty()) {
                units = fallback.units();
                confidence = SyllabusParser.ParseConfidence.MEDIUM;
            }
        }

        jdbc.update("DELETE FROM syllabus_units WHERE document_id=?", documentId);
        jdbc.update("DELETE FROM syllabus_assessments WHERE document_id=?", documentId);
        // Persistence is contained so a schema mismatch can never discard the parse trace below:
        // the fallback result and its issues are the diagnostics that prove the LLM path ran.
        try {
            for (SyllabusParser.ParsedUnit unit : units) {
                jdbc.update("INSERT INTO syllabus_units(id,course_id,document_id,week_number,ordinal,unit_date,title,topics,learning_objectives,required_readings,assignments,parse_confidence,source_chunk_ids,page_start) VALUES(?,?,?,?,?,?,?,CAST(? AS jsonb),CAST(? AS jsonb),CAST(? AS jsonb),CAST(? AS jsonb),?,CAST(? AS jsonb),?)",
                        UUID.randomUUID(), workspaceId, documentId, unit.week(), unit.ordinal(), unit.date(), unit.title(),
                        json(unit.topics()), json(List.of()), json(unit.readings()), json(unit.assignments()),
                        confidence.name(), jsonIds(unit.sourceChunkIds()), firstPage(rows, unit.sourceChunkIds()));
            }
            for (SyllabusParser.ParsedAssessment assessment : assessments) {
                jdbc.update("INSERT INTO syllabus_assessments(id,course_id,document_id,title,assessment_type,assessment_date,weight_percent,parse_confidence,source_chunk_ids,page_start) VALUES(?,?,?,?,?,?,?,?,CAST(? AS jsonb),?)",
                        UUID.randomUUID(), workspaceId, documentId, assessment.title(), assessment.type(), assessment.date(), assessment.weightPercent(),
                        confidence.name(), jsonIds(assessment.sourceChunkIds()), firstPage(rows, assessment.sourceChunkIds()));
                if (assessment.date() != null && assessment.type().contains("EXAM"))
                    jdbc.update("UPDATE courses SET exam_date=COALESCE(exam_date,?),updated_at=NOW() WHERE id=?", assessment.date(), workspaceId);
            }
        } catch (RuntimeException error) {
            issues.add("parsed structure could not be persisted: " + (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage()));
            log.warn("Syllabus structure persistence failed for document {}: {}", documentId, safeMessage(error));
        }

        // Every parse — parsed, refused or not-a-syllabus — leaves an observable trace on the document.
        String metadata = "{\"syllabusParse\":{\"status\":\"" + result.status().name() + "\",\"confidence\":\"" + confidence.name()
                + "\",\"detectionScore\":" + Math.round(detection.score() * 1000) / 1000.0
                + ",\"units\":" + units.size() + ",\"assessments\":" + assessments.size()
                + (issues.isEmpty() ? "" : ",\"issues\":" + json(issues.stream().limit(20).toList())) + "}}";
        // COALESCE keeps the trace when the document has no metadata yet: NULL || jsonb is NULL, and
        // an explicitly typed document skips auto-classification, so its parse outcome would vanish.
        jdbc.update("UPDATE documents SET source_metadata=COALESCE(source_metadata,'{}'::jsonb)||CAST(? AS jsonb) WHERE id=?", metadata, documentId);
        if (result.status() == SyllabusParser.ParseStatus.SYLLABUS_DETECTED_BUT_UNPARSED && units.isEmpty()) {
            log.warn("Syllabus document {} detected but unparseable even with fallback: {}", documentId, issues.isEmpty() ? "no detail" : issues.get(0));
        }
    }

    public SyllabusView get(UUID workspaceId) {
        List<UnitView> units = jdbc.query("SELECT id,document_id,week_number,ordinal,unit_date,title,topics::text,learning_objectives::text,required_readings::text,assignments::text,parse_confidence,source_chunk_ids::text,page_start FROM syllabus_units WHERE course_id=? ORDER BY COALESCE(week_number,ordinal,9999),title",
                (rs, row) -> new UnitView(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, Integer.class), rs.getObject(4, Integer.class), rs.getObject(5, java.time.LocalDate.class), rs.getString(6), rs.getString(7), rs.getString(8), rs.getString(9), rs.getString(10), rs.getString(11), rs.getString(12), rs.getObject(13, Integer.class)), workspaceId);
        List<AssessmentView> assessments = jdbc.query("SELECT id,document_id,title,assessment_type,assessment_date,weight_percent,parse_confidence,source_chunk_ids::text,page_start FROM syllabus_assessments WHERE course_id=? ORDER BY assessment_date NULLS LAST,title",
                (rs, row) -> new AssessmentView(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3), rs.getString(4), rs.getObject(5, java.time.LocalDate.class), rs.getObject(6, Double.class), rs.getString(7), rs.getString(8), rs.getObject(9, Integer.class)), workspaceId);
        // Parse outcome per syllabus document, so the UI can show a visible warning when a syllabus
        // was detected but could not be parsed, instead of presenting an empty syllabus as truth.
        List<ParseInfo> parseStatuses = jdbc.query("""
                SELECT id::text AS document_id, name,
                       COALESCE(source_metadata->'syllabusParse'->>'status','NOT_SYLLABUS') AS status,
                       COALESCE(source_metadata->'syllabusParse'->>'confidence','') AS confidence,
                       COALESCE((source_metadata->'syllabusParse'->>'units')::int,0) AS units
                FROM documents WHERE course_id=? AND document_type='SYLLABUS' ORDER BY created_at DESC LIMIT 10
                """, (rs, row) -> new ParseInfo(rs.getString("document_id"), rs.getString("name"), rs.getString("status"), rs.getString("confidence"), rs.getInt("units")), workspaceId);
        return new SyllabusView(units, assessments, parseStatuses);
    }

    private Integer firstPage(List<ChunkRow> rows, List<UUID> chunkIds) {
        for (UUID chunkId : chunkIds) {
            for (ChunkRow row : rows) if (row.id().equals(chunkId) && row.pageStart() > 0) return row.pageStart();
        }
        return null;
    }

    private String json(Object value) {
        try { return mapper.writeValueAsString(value); } catch (Exception ignored) { return "[]"; }
    }

    private String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null ? error.getClass().getSimpleName() : message.length() > 300 ? message.substring(0, 300) : message;
    }

    private String jsonIds(List<UUID> ids) { return json(ids); }

    private record ChunkRow(UUID id, String content, int pageStart) {}

    public record SyllabusView(List<UnitView> units, List<AssessmentView> assessments, List<ParseInfo> parseStatuses) {}
    public record ParseInfo(String documentId, String documentName, String status, String confidence, int units) {}
    public record UnitView(UUID id, UUID documentId, Integer weekNumber, Integer ordinal, java.time.LocalDate unitDate, String title,
                           String topics, String learningObjectives, String requiredReadings, String assignments,
                           String parseConfidence, String sourceChunkIds, Integer pageStart) {}
    public record AssessmentView(UUID id, UUID documentId, String title, String assessmentType, java.time.LocalDate assessmentDate,
                                 Double weightPercent, String parseConfidence, String sourceChunkIds, Integer pageStart) {}
}
