package com.studyos.ingestion;

import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import com.studyos.WorkspaceNotReadyException;
import com.studyos.retrieval.EmbeddingCacheService;
import com.studyos.knowledge.TopicExtractionService;
import com.studyos.knowledge.TopicCapsuleService;
import com.studyos.knowledge.TopicModelService;
import com.studyos.knowledge.TopicObjectiveService;
import com.studyos.summary.SummaryService;
import com.studyos.assessment.AssessmentExtractionService;
import com.studyos.assessment.ExamAnalysisService;
import com.studyos.assessment.SyllabusService;

@Service
public class IngestionService {
    private static final Logger log = LoggerFactory.getLogger(IngestionService.class);
    private final DocumentTextExtractor extractor;
    private final StructureAwareChunker chunker;
    private final ExtractionValidator validator;
    private final EmbeddingCacheService embeddingCache;
    private final TopicExtractionService topics;
    private final SummaryService summaries;
    private final AssessmentExtractionService assessments;
    private final ExamAnalysisService examAnalysis;
    private final TopicCapsuleService capsules;
    private final SyllabusService syllabus;
    private final TopicObjectiveService objectives;
    private final TopicModelService topicModel;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;

    public IngestionService(DocumentTextExtractor extractor, StructureAwareChunker chunker, ExtractionValidator validator, EmbeddingCacheService embeddingCache, TopicExtractionService topics, SummaryService summaries, AssessmentExtractionService assessments, ExamAnalysisService examAnalysis, TopicCapsuleService capsules,SyllabusService syllabus, TopicObjectiveService objectives, TopicModelService topicModel, JdbcTemplate jdbc, PlatformTransactionManager transactionManager) {
        this.extractor = extractor; this.chunker = chunker; this.validator = validator; this.embeddingCache=embeddingCache; this.topics = topics; this.summaries = summaries; this.assessments = assessments; this.examAnalysis = examAnalysis;this.capsules=capsules;this.syllabus=syllabus;this.objectives=objectives;this.topicModel=topicModel; this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
    }

    @Async("ingestionExecutor")
    public void process(UUID documentId) {
        try {
            stage(documentId, "EXTRACTING", 10, null);
            Map<String, Object> document = jdbc.queryForMap("SELECT course_id,storage_path,name,document_type FROM documents WHERE id=?", documentId);
            ExtractedDocument extracted = extractor.extract(Path.of((String) document.get("storage_path")));
            ExtractionValidator.Validation validation = validator.validate(extracted);
            if (!validation.valid()) { stage(documentId, "NEEDS_OCR", 100, validation.error()); return; }

            if (DocumentType.OTHER.name().equals(document.get("document_type"))) {
                String sourceText = classificationSample(extracted);
                SourceClassifier.Classification classification = SourceClassifier.classify((String) document.get("name"), sourceText);
                jdbc.update("UPDATE documents SET document_type=?,source_metadata=COALESCE(source_metadata,'{}'::jsonb)||jsonb_build_object('classification','AUTO','classificationConfidence',?,'classificationReason',?) WHERE id=?",
                    classification.type().name(), classification.confidence(), classification.reason(), documentId);
            }

            stage(documentId, "STRUCTURING", 25, null);
            UUID courseId = (UUID) document.get("course_id");
            String documentName = (String) document.get("name");
            // Sections come from the outline the chunker walks, so the text has to be chunked before it can be
            // structured. The stages a client polls are unchanged: this one still reports structuring, and the
            // chunk rows are still written under CHUNKING below.
            var chunks = chunker.chunk(extracted);
            DocumentOutline.Outline outline = structure(documentId, documentName, chunks);

            stage(documentId, "CHUNKING", 45, null);
            // What each chunk is part of, prepended before indexing and embedding but stored apart from the
            // content so a citation still quotes source text and nothing else.
            List<String> headers = chunks.stream().map(chunk -> ChunkContext.header(documentName, chunk.headingPath())).toList();
            List<String> contextual = new java.util.ArrayList<>(chunks.size());
            for (int i = 0; i < chunks.size(); i++) contextual.add(ChunkContext.contextual(headers.get(i), chunks.get(i).content()));
            // One transaction, so a crash between the delete and the inserts can never leave a document with
            // some of its chunks: partial chunk state would silently shrink what retrieval can see.
            transaction.executeWithoutResult(status -> {
                jdbc.update("DELETE FROM chunks WHERE document_id=?", documentId);
                for (int i = 0; i < chunks.size(); i++) {
                    Chunk chunk = chunks.get(i);
                    UUID sectionId = outline.chunkSections().get(chunk.id());
                    // The hash keys the embedding cache, so it covers exactly the text that was embedded.
                    jdbc.update("INSERT INTO chunks(id,course_id,document_id,section_id,ordinal,page_start,page_end,content,context_header,token_count,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)", chunk.id(), courseId, documentId, sectionId, chunk.ordinal(), chunk.pageStart(), chunk.pageEnd(), chunk.content(), headers.get(i), chunk.tokenCount(), embeddingCache.hash(contextual.get(i)));
                }
            });
            stage(documentId, "EMBEDDING", 70, null);
            try {
                var vectors = embeddingCache.vectors(courseId, documentId, contextual);
                for (int i = 0; i < Math.min(chunks.size(), vectors.size()); i++) jdbc.update("UPDATE chunks SET embedding=CAST(? AS vector) WHERE id=?", vectorLiteral(vectors.get(i)), chunks.get(i).id());
            } catch (RuntimeException error) {
                // A chat-only provider can still support lexical retrieval; vectors remain NULL until an embedding provider is configured.
                log.warn("Embedding unavailable for document {}; lexical retrieval still works: {}", documentId, safeMessage(error));
            }

            // ---- Core ingestion is complete: the document's text, sections, chunks and embeddings are in. ----
            // Everything after this is enrichment. A provider outage or a failing rebuild here must not mark the
            // document FAILED — that would hide usable material behind a status clients treat as broken — so each
            // stage fails on its own and the document completes with enrichment_status='PARTIAL' instead.
            stage(documentId, "EXTRACTING_TOPICS", 85, null);
            LinkedHashSet<String> enrichmentFailures = new LinkedHashSet<>();
            runStage("topic extraction", enrichmentFailures, () -> topics.extract(courseId, chunks));
            runStage("assessment extraction", enrichmentFailures, () -> assessments.extractDocument(documentId, courseId));
            runStage("syllabus parsing", enrichmentFailures, () -> syllabus.extractDocument(courseId, documentId));
            runStage("exam analysis", enrichmentFailures, () -> examAnalysis.rebuild(courseId));
            // Objectives need this document's topics and, if it is a syllabus, its units; the topic model needs
            // the exam signals the line above writes. Both are ordered after their inputs rather than beside them.
            runStage("objective extraction", enrichmentFailures, () -> objectives.extractDocument(courseId, documentId));
            runStage("topic model", enrichmentFailures, () -> topicModel.rebuild(courseId));
            runStage("summaries", enrichmentFailures, () -> summaries.rebuild(courseId));
            runStage("topic capsules", enrichmentFailures, () -> capsules.rebuild(courseId));
            stage(documentId, "COMPLETED", 100, null);
            jdbc.update("UPDATE documents SET status='COMPLETED',page_count=?,processed_at=NOW(),enrichment_status=?,processing_error=? WHERE id=?",
                    extracted.pageCount(), enrichmentFailures.isEmpty() ? "COMPLETE" : "PARTIAL",
                    enrichmentFailures.isEmpty() ? null : ("AI enrichment did not finish for: " + String.join(", ", enrichmentFailures)),
                    documentId);
        } catch (Exception error) {
            log.error("Ingestion failed for document {}", documentId, error);
            jdbc.update("UPDATE documents SET status='FAILED',processing_stage='FAILED',processing_progress=100,processing_error=? WHERE id=?", safeMessage(error), documentId);
        }
    }

    /**
     * Runs one enrichment stage, recording its name rather than failing the document when it breaks.
     * Catches {@link Throwable}, not just RuntimeException: a missing class or other Error must still
     * strand nothing — the stage is recorded, the document completes as PARTIAL, and the queue moves on.
     */
    private void runStage(String stage, Set<String> failures, Runnable work) {
        try { work.run(); }
        catch (Throwable error) { failures.add(stage); log.error("Enrichment stage '{}' failed; the document itself is unaffected", stage, error); }
    }

    /**
     * Rebuilds one document's section tree from its stored file, and rebinds its chunks to it.
     *
     * <p>Documents ingested before sections were a tree hold a flat row per page, and they keep it: nothing
     * rewrites them on its own, so a workspace would otherwise be split between documents StudyOS understands the
     * structure of and documents it does not. This is the way across, and it is cheap because the chunker is
     * deterministic — the same file yields the same chunks in the same order, so the outline can be re-derived and
     * the existing chunk rows pointed at it. No chunk id changes, no text changes, no context header changes, and
     * nothing is re-embedded, so a re-structured document costs no provider calls and keeps every vector it had.
     *
     * <p>That guarantee is checked rather than assumed. If re-chunking this file does not reproduce the stored
     * chunks exactly — a different count, a gap in the ordinals, or any differing text — the document is left
     * untouched and the reason is reported, because binding sections to chunks that have moved would attribute
     * passages to sections they are not in.
     */
    public Restructured restructure(UUID documentId) {
        Map<String, Object> document = jdbc.queryForMap("SELECT course_id,storage_path,name,status FROM documents WHERE id=?", documentId);
        if (!"COMPLETED".equals(document.get("status"))) throw new WorkspaceNotReadyException("This source has not finished processing yet, so its structure cannot be rebuilt");
        ExtractedDocument extracted;
        try {
            extracted = extractor.extract(Path.of((String) document.get("storage_path")));
        } catch (java.io.IOException error) {
            throw new WorkspaceNotReadyException("The stored file for this source could not be read, so its structure cannot be rebuilt");
        }
        List<Chunk> rechunked = chunker.chunk(extracted);
        List<StoredChunk> stored = jdbc.query("SELECT id,ordinal,content FROM chunks WHERE document_id=? ORDER BY ordinal", (rs, row) -> new StoredChunk(rs.getObject("id", UUID.class), rs.getInt("ordinal"), rs.getString("content")), documentId);
        if (stored.size() != rechunked.size()) throw new WorkspaceNotReadyException("This source now splits into " + rechunked.size() + " passages rather than the " + stored.size() + " already stored, so its structure cannot be rebuilt without re-processing it");
        List<Chunk> rekeyed = new java.util.ArrayList<>(stored.size());
        for (int i = 0; i < stored.size(); i++) {
            StoredChunk row = stored.get(i);
            Chunk fresh = rechunked.get(i);
            if (row.ordinal() != i || !row.content().equals(fresh.content())) throw new WorkspaceNotReadyException("The stored passages of this source no longer match the file it came from, so its structure cannot be rebuilt without re-processing it");
            // The outline is keyed onto the chunk rows that already exist, so the sections it produces bind to the
            // stored ids rather than to the throwaway ids re-chunking just generated.
            rekeyed.add(new Chunk(row.id(), fresh.ordinal(), fresh.pageStart(), fresh.pageEnd(), fresh.content(), fresh.tokenCount(), fresh.headingPath(), fresh.headingTrail()));
        }
        DocumentOutline.Outline outline = structure(documentId, (String) document.get("name"), rekeyed);
        int rebound = 0;
        for (Map.Entry<UUID, UUID> binding : outline.chunkSections().entrySet()) rebound += jdbc.update("UPDATE chunks SET section_id=? WHERE id=? AND document_id=?", binding.getValue(), binding.getKey(), documentId);
        summaries.rebuild((UUID) document.get("course_id"));
        return new Restructured(documentId, outline.nodes().size(), outline.depth(), rebound);
    }

    /** Replaces the document's stored outline, parents before children — which is the order it is produced in. */
    private DocumentOutline.Outline structure(UUID documentId, String documentName, List<Chunk> chunks) {
        DocumentOutline.Outline outline = DocumentOutline.of(documentName, chunks);
        jdbc.update("DELETE FROM document_sections WHERE document_id=?", documentId);
        for (DocumentOutline.Node node : outline.nodes()) {
            jdbc.update("INSERT INTO document_sections(id,document_id,parent_section_id,title,level,ordinal,page_start,page_end,raw_text,path,token_count) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                node.id(), documentId, node.parentId(), node.title(), node.level(), node.ordinal(), node.pageStart(), node.pageEnd(), node.rawText(), node.path(), node.tokenCount());
        }
        return outline;
    }

    private void stage(UUID documentId, String stage, int progress, String error) {
        jdbc.update("UPDATE documents SET status=?,processing_stage=?,processing_progress=?,processing_error=? WHERE id=?", stage, stage, progress, error, documentId);
    }
    private String classificationSample(ExtractedDocument document) { StringBuilder sample=new StringBuilder();for(ParsedPage page:document.pages()){if(sample.length()>=30_000)break;sample.append(page.text(),0,Math.min(page.text().length(),30_000-sample.length())).append('\n');}return sample.toString(); }
    private String safeMessage(Exception error) { String message = error.getMessage(); return message == null ? error.getClass().getSimpleName() : message.substring(0, Math.min(1000, message.length())); }
    private String vectorLiteral(float[] vector) { StringBuilder result = new StringBuilder("["); for (int i = 0; i < vector.length; i++) { if (i > 0) result.append(','); result.append(vector[i]); } return result.append(']').toString(); }
    public IngestionPreview preview(byte[] fileBytes) { ExtractedDocument document = extractor.extract(fileBytes); var chunks = chunker.chunk(document); return new IngestionPreview(document.pageCount(), document.characterCount(), chunks.size(), validator.validate(document).valid() ? "EXTRACTED_AND_CHUNKED" : "NEEDS_OCR"); }
    public record IngestionPreview(int pages, int characters, int chunks, String stage) {}
    /** @param depth the deepest heading level found, 0 when the document offers no headings to nest by. */
    public record Restructured(UUID documentId, int sections, int depth, int chunksRebound) {}
    private record StoredChunk(UUID id, int ordinal, String content) {}
}
