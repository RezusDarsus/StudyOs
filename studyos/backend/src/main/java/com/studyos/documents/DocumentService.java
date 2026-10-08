package com.studyos.documents;

import com.studyos.ingestion.DocumentType;
import java.io.IOException;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import java.util.List;
import java.nio.charset.StandardCharsets;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import com.studyos.ingestion.IngestionService;
import com.studyos.storage.FileStorageService;

@Service
public class DocumentService {
    private final JdbcTemplate jdbc;
    private final IngestionService ingestion;
    private final FileStorageService storage;
    public DocumentService(JdbcTemplate jdbc, IngestionService ingestion, FileStorageService storage) { this.jdbc = jdbc; this.ingestion = ingestion; this.storage = storage; }
    public DocumentController.QueuedDocument queue(UUID courseId, MultipartFile file, DocumentType type) {
        try {
            if (file == null || file.isEmpty()) throw new IllegalArgumentException("A non-empty source file is required");
            String filename = file.getOriginalFilename() == null ? "" : file.getOriginalFilename().toLowerCase(java.util.Locale.ROOT);
            if (!supported(filename)) throw new IllegalArgumentException("Supported source formats are PDF, TXT, Markdown, and pasted text");
            UUID id = UUID.randomUUID(); String path = storage.save(courseId, id, file);
            jdbc.update("INSERT INTO documents(id,course_id,name,document_type,storage_path,status,processing_stage,processing_progress,content_hash,media_type) VALUES (?,?,?,?,?,?,?,?,?,?)", id, courseId, file.getOriginalFilename(), type.name(), path, "UPLOADED", "QUEUED", 0, sha256(storage.resolve(path)), mediaType(filename));
            ingestion.process(id);
            return new DocumentController.QueuedDocument(id, "UPLOADED");
        } catch (IOException exception) { throw new IllegalStateException("Could not store document", exception); }
    }

    public DocumentController.QueuedDocument queueText(UUID courseId, String title, String content, DocumentType type) {
        if (content == null || content.isBlank()) throw new IllegalArgumentException("Pasted text cannot be empty");
        if (content.length() > 2_000_000) throw new IllegalArgumentException("Pasted text is limited to 2,000,000 characters");
        String safeTitle = title == null || title.isBlank() ? "Pasted notes" : title.trim();
        String filename = safeTitle.replaceAll("[^a-zA-Z0-9._ -]", "_") + ".txt";
        try {
            UUID id = UUID.randomUUID();
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            String path = storage.save(courseId, id, filename, bytes);
            jdbc.update("INSERT INTO documents(id,course_id,name,document_type,storage_path,status,processing_stage,processing_progress,content_hash,media_type,source_metadata) VALUES (?,?,?,?,?,?,?,?,?,?,CAST(? AS jsonb))",
                id, courseId, safeTitle, type.name(), path, "UPLOADED", "QUEUED", 0,
                sha256(bytes), "text/plain", "{\"origin\":\"PASTED_TEXT\"}");
            ingestion.process(id);
            return new DocumentController.QueuedDocument(id, "UPLOADED");
        } catch (IOException exception) {
            throw new IllegalStateException("Could not store pasted text", exception);
        }
    }

    /**
     * Re-queues a document whose ingestion died mid-flight (JVM restart, a crashed enrichment run):
     * status goes back to QUEUED and the pipeline runs from the top. Embeddings are content-hash
     * cached, so the only real cost is the enrichment the document never finished.
     */
    public DocumentController.QueuedDocument reprocess(UUID courseId, UUID documentId) {
        Integer owned = jdbc.query("SELECT 1 FROM documents WHERE id=? AND course_id=?", rs -> rs.next() ? 1 : null, documentId, courseId);
        if (owned == null) throw new IllegalArgumentException("That source is not in this workspace");
        jdbc.update("UPDATE documents SET status='UPLOADED',processing_stage='QUEUED',processing_progress=0,processing_error=NULL WHERE id=?", documentId);
        ingestion.process(documentId);
        return new DocumentController.QueuedDocument(documentId, "UPLOADED");
    }

    private static boolean supported(String filename) {
        return filename.endsWith(".pdf") || filename.endsWith(".txt") || filename.endsWith(".md") || filename.endsWith(".markdown")
                || filename.endsWith(".html") || filename.endsWith(".htm") || filename.endsWith(".srt") || filename.endsWith(".vtt");
    }

    /**
     * Rebuilds this source's section tree from the file already stored for it. What it is for: a workspace filled
     * before StudyOS derived real structure holds a flat row per page, and without this those documents would stay
     * that way while newly uploaded ones did not — two classes of source behaving differently in the same course.
     * Nothing is re-embedded and no chunk changes, so it costs no provider calls.
     */
    public IngestionService.Restructured restructure(UUID courseId, UUID documentId) {
        Integer owned = jdbc.query("SELECT 1 FROM documents WHERE id=? AND course_id=?", rs -> rs.next() ? 1 : null, documentId, courseId);
        if (owned == null) throw new IllegalArgumentException("That source is not in this workspace");
        return ingestion.restructure(documentId);
    }

    private static String mediaType(String filename) {
        if (filename.endsWith(".pdf")) return "application/pdf";
        if (filename.endsWith(".md") || filename.endsWith(".markdown")) return "text/markdown";
        if (filename.endsWith(".html") || filename.endsWith(".htm")) return "text/html";
        if (filename.endsWith(".srt") || filename.endsWith(".vtt")) return "text/vtt";
        return "text/plain";
    }
    static String sha256(byte[] bytes) { try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); } catch (Exception e) { throw new IllegalStateException(e); } }
    static String sha256(Path path) { try (var input = Files.newInputStream(path)) { var digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[8192]; int read; while ((read = input.read(buffer)) >= 0) if (read > 0) digest.update(buffer, 0, read); return HexFormat.of().formatHex(digest.digest()); } catch (Exception e) { throw new IllegalStateException(e); } }
    public List<DocumentSummary> list(UUID courseId) { return jdbc.query("SELECT id,name,document_type,media_type,status,processing_stage,processing_progress,processing_error,page_count,created_at,processed_at FROM documents WHERE course_id=? ORDER BY created_at DESC", (rs,row) -> new DocumentSummary(rs.getObject("id",UUID.class),rs.getString("name"),rs.getString("document_type"),rs.getString("media_type"),rs.getString("status"),rs.getString("processing_stage"),rs.getInt("processing_progress"),rs.getString("processing_error"),rs.getObject("page_count",Integer.class),rs.getTimestamp("created_at"),rs.getTimestamp("processed_at")), courseId); }
    public void delete(UUID courseId, UUID documentId) { jdbc.query("SELECT storage_path FROM documents WHERE id=? AND course_id=?", rs -> { if (rs.next()) { try { storage.delete(rs.getString("storage_path")); } catch (IOException ignored) {} } }, documentId, courseId); jdbc.update("DELETE FROM documents WHERE id=? AND course_id=?", documentId, courseId); }
    public record DocumentSummary(UUID id,String name,String type,String mediaType,String status,String processingStage,int progress,String error,Integer pageCount,java.sql.Timestamp createdAt,java.sql.Timestamp processedAt) {}
}
