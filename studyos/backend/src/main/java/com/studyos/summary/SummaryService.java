package com.studyos.summary;

import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Builds the course's summary tree: one node for the course, one per document, and one per section of each
 * document, each composed from what sits beneath it by {@link HierarchicalSummarizer}.
 */
@Service
public class SummaryService {
    private static final String FROM = " FROM summary_nodes s LEFT JOIN document_sections d ON d.id=s.section_id LEFT JOIN documents doc ON doc.id=s.document_id WHERE s.course_id=?";
    /**
     * The course, then its documents by name, then each document's sections in the order they appear in it.
     * Sections used to be ordered by title, which was harmless while a section was a page and misleads now that
     * they are a tree: by title, "1.10" precedes "1.2" and a chapter sorts away from its own subsections.
     */
    private static final String ORDER = " ORDER BY CASE s.level WHEN 'COURSE' THEN 0 WHEN 'DOCUMENT' THEN 1 ELSE 2 END, doc.name NULLS FIRST, COALESCE(d.ordinal,0), s.title";

    private final JdbcTemplate jdbc;

    public SummaryService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public void rebuild(UUID courseId) {
        jdbc.update("DELETE FROM summary_nodes WHERE course_id=?", courseId);
        List<DocumentRow> documents = jdbc.query("SELECT id,name,document_type FROM documents WHERE course_id=? AND status='COMPLETED' ORDER BY name", (rs,row) -> new DocumentRow(rs.getObject("id",UUID.class),rs.getString("name"),rs.getString("document_type")), courseId);
        List<String> topicNames = jdbc.query("SELECT canonical_name FROM topics WHERE course_id=? ORDER BY canonical_name", (rs,row) -> rs.getString(1), courseId);
        UUID courseSummaryId = UUID.randomUUID();
        String courseSummary = courseSummary(documents, topicNames);
        insert(courseSummaryId, courseId, null, null, null, "COURSE", "Course overview", courseSummary, documents.size());
        for (DocumentRow document:documents) buildDocument(courseId, courseSummaryId, document);
    }

    public String compact(UUID courseId) {
        List<SummaryRow> rows = jdbc.query("SELECT s.level,s.title,s.summary"+FROM+ORDER+" LIMIT 12", (rs,row) -> new SummaryRow(rs.getString("level"),rs.getString("title"),rs.getString("summary")), courseId);
        if (rows.isEmpty()) return "Course summaries: (not generated yet)\n";
        StringBuilder result = new StringBuilder("Hierarchical course summaries:\n");
        for (SummaryRow row:rows) result.append("[ ").append(row.level()).append(" ] ").append(row.title()).append(": ").append(row.summary()).append("\n");
        return result.toString();
    }

    public List<SummaryView> list(UUID courseId) {
        return jdbc.query("SELECT s.id,s.parent_id,s.document_id,s.section_id,s.level,s.title,s.summary,s.source_count,s.token_count,s.updated_at"+FROM+ORDER, (rs,row) -> new SummaryView(rs.getObject("id",UUID.class),rs.getObject("parent_id",UUID.class),rs.getObject("document_id",UUID.class),rs.getObject("section_id",UUID.class),rs.getString("level"),rs.getString("title"),rs.getString("summary"),rs.getInt("source_count"),rs.getInt("token_count"),rs.getTimestamp("updated_at")), courseId);
    }

    /**
     * The document's own sections, summarised upwards. The document summary is the root section's composition, so
     * it describes the whole document rather than — as it did while sections were pages — its first eight chunks.
     */
    private void buildDocument(UUID courseId, UUID parentId, DocumentRow document) {
        List<HierarchicalSummarizer.Node> sections = jdbc.query("SELECT id,parent_section_id,level,ordinal,title,raw_text FROM document_sections WHERE document_id=? ORDER BY ordinal",
                (rs,row) -> new HierarchicalSummarizer.Node(rs.getObject("id",UUID.class),rs.getObject("parent_section_id",UUID.class),rs.getInt("level"),rs.getInt("ordinal"),rs.getString("title"),rs.getString("raw_text")), document.id());
        HierarchicalSummarizer.Result result = HierarchicalSummarizer.summarize(sections);
        String summary = result.documentSummary();
        int sourceCount = result.documentSourceCount();
        if (summary.isBlank()) {
            // Nothing in the tree to compose from — a document whose sections hold no text, or one stored before
            // sections carried any. Its own chunks are still an honest basis, and an empty node would not be.
            List<String> chunks = jdbc.query("SELECT content FROM chunks WHERE document_id=? ORDER BY ordinal LIMIT 8", (rs,row) -> rs.getString(1), document.id());
            summary = HierarchicalSummarizer.condense(String.join(" ", chunks), HierarchicalSummarizer.DOCUMENT_MAX);
            sourceCount = chunks.size();
        }
        UUID documentSummaryId = UUID.randomUUID();
        insert(documentSummaryId, courseId, document.id(), parentId, null, "DOCUMENT", document.name()+" · "+document.type(), summary, sourceCount);
        Map<UUID,UUID> summaryIds = new HashMap<>();
        for (HierarchicalSummarizer.Section section:result.sections()) {
            UUID id = UUID.randomUUID();
            summaryIds.put(section.nodeId(), id);
            // Sections arrive in document order, so a parent's summary node already exists. A section whose parent
            // is the document's own root — and every row of a page-per-section document, which has no parent at
            // all — hangs off the document summary instead.
            UUID sectionParent = section.parentNodeId()==null ? documentSummaryId : summaryIds.getOrDefault(section.parentNodeId(), documentSummaryId);
            insert(id, courseId, document.id(), sectionParent, section.nodeId(), "SECTION", section.title(), section.summary(), section.sourceCount());
        }
    }

    private String courseSummary(List<DocumentRow> documents,List<String> topics) {
        String sourceText = documents.isEmpty() ? "No completed sources yet." : documents.size()+" completed sources: "+documents.stream().limit(8).map(document -> document.name()+" ("+document.type()+")").reduce((a,b)->a+", "+b).orElse("");
        String topicText = topics.isEmpty() ? "No topics extracted yet." : "Key topics: "+String.join(", ",topics.stream().limit(20).toList())+".";
        return sourceText+". "+topicText;
    }

    private void insert(UUID id,UUID courseId,UUID documentId,UUID parentId,UUID sectionId,String level,String title,String summary,int sourceCount) {
        // A summary with no text has zero tokens, not one: this column is read as a size, and a floor of one turns
        // "there was nothing to summarise" into "there was a little".
        int tokenCount = summary == null || summary.isBlank() ? 0 : Math.max(1, summary.length()/4);
        jdbc.update("INSERT INTO summary_nodes(id,course_id,document_id,parent_id,section_id,level,title,summary,source_count,token_count,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,NOW())",id,courseId,documentId,parentId,sectionId,level,title,summary,sourceCount,tokenCount);
    }

    private record DocumentRow(UUID id,String name,String type) {}
    private record SummaryRow(String level,String title,String summary) {}
    /** @param sectionId the section this summarises, null for the course and document nodes. */
    public record SummaryView(UUID id,UUID parentId,UUID documentId,UUID sectionId,String level,String title,String summary,int sourceCount,int tokenCount,java.sql.Timestamp updatedAt) {}
}
