package com.studyos.documents;

import com.studyos.ingestion.DocumentType;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.List;
import org.springframework.web.multipart.MultipartFile;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping({"/api/courses/{courseId}/documents", "/api/workspaces/{courseId}/sources"})
public class DocumentController {
    private final DocumentService documentService;
    public DocumentController(DocumentService documentService) { this.documentService = documentService; }
    @PostMapping(consumes = "multipart/form-data")
    public ResponseEntity<QueuedDocument> upload(@PathVariable UUID courseId, @RequestPart("file") MultipartFile file, @RequestParam(defaultValue = "OTHER") DocumentType type) {
        return ResponseEntity.accepted().body(documentService.queue(courseId, file, type));
    }
    @PostMapping(path = "/text", consumes = "application/json")
    public ResponseEntity<QueuedDocument> paste(@PathVariable UUID courseId, @Valid @RequestBody PastedText request) {
        return ResponseEntity.accepted().body(documentService.queueText(courseId, request.title(), request.content(), request.type() == null ? DocumentType.STUDENT_NOTE : request.type()));
    }
    @GetMapping public List<DocumentService.DocumentSummary> list(@PathVariable UUID courseId) { return documentService.list(courseId); }
    /** Rebuilds this source's section tree from the file already stored for it, without re-embedding anything. */
    @PostMapping("/{documentId}/restructure")
    public com.studyos.ingestion.IngestionService.Restructured restructure(@PathVariable UUID courseId, @PathVariable UUID documentId) { return documentService.restructure(courseId, documentId); }
    /** Re-queues a document stranded mid-pipeline by a crashed run; costs only the unfinished enrichment. */
    @PostMapping("/{documentId}/reprocess")
    public ResponseEntity<QueuedDocument> reprocess(@PathVariable UUID courseId, @PathVariable UUID documentId) { return ResponseEntity.accepted().body(documentService.reprocess(courseId, documentId)); }
    @DeleteMapping("/{documentId}") public ResponseEntity<Void> delete(@PathVariable UUID courseId, @PathVariable UUID documentId) { documentService.delete(courseId, documentId); return ResponseEntity.noContent().build(); }
    public record QueuedDocument(UUID documentId, String status) {}
    public record PastedText(@Size(max = 500) String title, @NotBlank String content, DocumentType type) {}
}
