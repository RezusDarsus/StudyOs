package com.studyos.assessment;

import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/courses/{courseId}/assessments", "/api/workspaces/{courseId}/assessments"})
public class AssessmentController {
    private final JdbcTemplate jdbc;
    public AssessmentController(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @GetMapping
    public List<Item> list(@PathVariable UUID courseId, @RequestParam(required=false) String sourceType) {
        String filter = sourceType == null || sourceType.isBlank() ? "" : " AND ai.source_type=?";
        Object[] args = filter.isBlank() ? new Object[]{courseId} : new Object[]{courseId, sourceType.toUpperCase(Locale.ROOT)};
        return jdbc.query("SELECT ai.id,ai.document_id,d.name,ai.source_type,ai.question_number,ai.type,ai.prompt,ai.points,ai.difficulty,ai.page_start,ai.page_end,COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.canonical_name,'relevance',ait2.relevance) ORDER BY ait2.relevance DESC) FROM assessment_item_topics ait2 JOIN topics t ON t.id=ait2.topic_id WHERE ait2.item_id=ai.id),'[]'::json) FROM assessment_items ai LEFT JOIN documents d ON d.id=ai.document_id WHERE ai.course_id=?" + filter + " ORDER BY ai.source_type,ai.document_id,ai.question_number,ai.created_at", (rs,row) -> new Item(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getString(3),rs.getString(4),rs.getObject(5,Integer.class),rs.getString(6),rs.getString(7),rs.getObject(8,Double.class),rs.getObject(9,Double.class),rs.getObject(10,Integer.class),rs.getObject(11,Integer.class),rs.getString(12)), args);
    }

    public record Item(UUID id,UUID documentId,String documentName,String sourceType,Integer questionNumber,String questionType,String prompt,Double points,Double difficulty,Integer pageStart,Integer pageEnd,String topics) {}
}
