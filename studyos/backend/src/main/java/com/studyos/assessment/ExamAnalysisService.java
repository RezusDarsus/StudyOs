package com.studyos.assessment;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** Computes explainable exam relevance from extracted assessment and source provenance. */
@Service
public class ExamAnalysisService {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public ExamAnalysisService(JdbcTemplate jdbc, ObjectMapper mapper) { this.jdbc = jdbc; this.mapper = mapper; }

    public synchronized void rebuild(UUID courseId) {
        jdbc.update("DELETE FROM exam_topic_signals WHERE course_id=?", courseId);
        int pastDocuments = countDocuments(courseId, "PAST_EXAM");
        int homeworkItems = countItems(courseId, "HOMEWORK", false);
        int quizItems = countItems(courseId, "QUIZ", false);
        int lectureDocuments = countDocuments(courseId, "LECTURE");
        double totalPastPoints = number("SELECT COALESCE(SUM(COALESCE(points,0)),0) FROM assessment_items WHERE course_id=? AND source_type='PAST_EXAM'", courseId).doubleValue();
        int maxCentrality = Math.max(1, number("SELECT COALESCE(MAX(n),0) FROM (SELECT COUNT(*) AS n FROM topic_edges WHERE course_id=? GROUP BY source_topic_id) x", courseId).intValue());

        // The prediction universe is canonical, quality-valid topics only: merged redirect rows and
        // structurally invalid names ("(20 Pt)" packaging, instruction verbs) never enter the
        // probability space again, even if they survive as referenced rows.
        record TopicRow(UUID id, String name) {}
        List<TopicRow> candidates = jdbc.query("SELECT id, canonical_name FROM topics WHERE course_id=? AND canonical_topic_id IS NULL ORDER BY canonical_name", (rs, row) -> new TopicRow(rs.getObject("id", UUID.class), rs.getString("canonical_name")), courseId);
        List<UUID> topics = candidates.stream()
                .filter(topic -> com.studyos.knowledge.TopicCandidateQuality.evaluate(topic.name()).accepted())
                .map(TopicRow::id).toList();
        for (UUID topicId : topics) {
            TopicStats stats = stats(courseId, topicId);
            ExamRelevanceCalculator.Result result = ExamRelevanceCalculator.calculate(new ExamRelevanceCalculator.Input(stats.pastDocuments(), stats.pastPoints(), stats.pastItems(), stats.homeworkItems(), stats.quizItems(), stats.lectureDocuments(), stats.syllabusDocuments(), stats.centrality(), pastDocuments, totalPastPoints, homeworkItems, quizItems, lectureDocuments, maxCentrality));
            jdbc.update("INSERT INTO exam_topic_signals(id,course_id,topic_id,past_exam_frequency,past_exam_points,homework_frequency,lecture_coverage,syllabus_importance,professor_emphasis,quiz_frequency,recent_lecture_emphasis,topic_centrality,relevance,evidence_confidence,evidence,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,NOW())",
                    UUID.randomUUID(), courseId, topicId, result.pastFrequency(), result.pastPoints(), result.homeworkFrequency(), result.lectureCoverage(), result.syllabusImportance(), result.professorEmphasis(), result.quizFrequency(), result.recentLectureEmphasis(), result.centrality(), result.relevance(), result.confidence(), evidence(stats, pastDocuments, homeworkItems, lectureDocuments));
        }
    }

    public List<Signal> list(UUID courseId) {
        return jdbc.query("SELECT t.id,t.canonical_name,s.past_exam_frequency,s.past_exam_points,s.homework_frequency,s.lecture_coverage,s.syllabus_importance,s.professor_emphasis,s.quiz_frequency,s.recent_lecture_emphasis,s.topic_centrality,s.relevance,s.evidence_confidence,s.evidence FROM exam_topic_signals s JOIN topics t ON t.id=s.topic_id WHERE s.course_id=? ORDER BY s.relevance DESC,t.canonical_name", (rs, row) -> new Signal(rs.getObject("id", UUID.class), rs.getString("canonical_name"), rs.getDouble("relevance"), rs.getDouble("evidence_confidence"), new Evidence(rs.getDouble("past_exam_frequency"), rs.getDouble("past_exam_points"), rs.getDouble("homework_frequency"), rs.getDouble("lecture_coverage"), rs.getDouble("syllabus_importance"), rs.getDouble("professor_emphasis"), rs.getDouble("quiz_frequency"), rs.getDouble("recent_lecture_emphasis"), rs.getDouble("topic_centrality")), rs.getString("evidence")), courseId);
    }

    private TopicStats stats(UUID courseId, UUID topicId) {
        TopicStats assessment = jdbc.query("SELECT COUNT(DISTINCT CASE WHEN ai.source_type='PAST_EXAM' THEN ai.document_id END), COALESCE(SUM(CASE WHEN ai.source_type='PAST_EXAM' THEN COALESCE(ai.points,0) ELSE 0 END),0), COUNT(CASE WHEN ai.source_type='PAST_EXAM' THEN 1 END), COUNT(CASE WHEN ai.source_type IN ('HOMEWORK','ASSIGNMENT') THEN 1 END), COUNT(CASE WHEN ai.source_type='QUIZ' THEN 1 END) FROM assessment_item_topics ait LEFT JOIN assessment_items ai ON ai.id=ait.item_id WHERE ait.topic_id=?", rs -> {
            if (!rs.next()) return new TopicStats(0, 0, 0, 0, 0, 0, 0, 0);
            return new TopicStats(rs.getInt(1), rs.getDouble(2), rs.getInt(3), rs.getInt(4), rs.getInt(5), 0, 0, 0);
        }, topicId);
        int lectures = jdbc.queryForObject("SELECT COUNT(DISTINCT d.id) FROM chunk_topics ct JOIN chunks c ON c.id=ct.chunk_id JOIN documents d ON d.id=c.document_id WHERE ct.topic_id=? AND d.course_id=? AND d.document_type='LECTURE' AND d.status='COMPLETED'", Integer.class, topicId, courseId);
        int syllabus = jdbc.queryForObject("SELECT COUNT(DISTINCT d.id) FROM chunk_topics ct JOIN chunks c ON c.id=ct.chunk_id JOIN documents d ON d.id=c.document_id WHERE ct.topic_id=? AND d.course_id=? AND d.document_type='SYLLABUS' AND d.status='COMPLETED'", Integer.class, topicId, courseId);
        int centrality = jdbc.queryForObject("SELECT COUNT(*) FROM topic_edges WHERE course_id=? AND (source_topic_id=? OR target_topic_id=?)", Integer.class, courseId, topicId, topicId);
        return new TopicStats(assessment.pastDocuments(), assessment.pastPoints(), assessment.pastItems(), assessment.homeworkItems(), assessment.quizItems(), lectures, syllabus, centrality);
    }

    private int countDocuments(UUID courseId, String type) { return jdbc.queryForObject("SELECT COUNT(*) FROM documents WHERE course_id=? AND document_type=? AND status='COMPLETED'", Integer.class, courseId, type); }
    private int countItems(UUID courseId, String type, boolean includeAssignments) { if (includeAssignments || "HOMEWORK".equals(type)) return jdbc.queryForObject("SELECT COUNT(*) FROM assessment_items WHERE course_id=? AND source_type IN ('HOMEWORK','ASSIGNMENT')", Integer.class, courseId); return jdbc.queryForObject("SELECT COUNT(*) FROM assessment_items WHERE course_id=? AND source_type=?", Integer.class, courseId, type); }
    private Number number(String sql, UUID courseId) { return jdbc.queryForObject(sql, Number.class, courseId); }
    private String evidence(TopicStats stats, int pastDocuments, int homeworkItems, int lectureDocuments) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("pastExams", stats.pastDocuments() + "/" + pastDocuments);
        value.put("pastExamQuestions", stats.pastItems());
        value.put("pastExamPoints", stats.pastPoints());
        value.put("homeworkQuestions", stats.homeworkItems());
        value.put("homeworkTotal", homeworkItems);
        value.put("lectureCount", stats.lectureDocuments());
        value.put("lectureTotal", lectureDocuments);
        value.put("syllabusDocuments", stats.syllabusDocuments());
        value.put("topicCentrality", stats.centrality());
        try { return mapper.writeValueAsString(value); } catch (JsonProcessingException e) { return "{}"; }
    }

    private record TopicStats(int pastDocuments, double pastPoints, int pastItems, int homeworkItems, int quizItems, int lectureDocuments, int syllabusDocuments, int centrality) {}
    public record Evidence(double pastExamFrequency, double pastExamPoints, double homeworkFrequency, double lectureCoverage, double syllabusImportance, double professorEmphasis, double quizFrequency, double recentLectureEmphasis, double topicCentrality) {}
    public record Signal(UUID topicId, String topic, double relevance, double confidence, Evidence factors, String evidence) {}
}
