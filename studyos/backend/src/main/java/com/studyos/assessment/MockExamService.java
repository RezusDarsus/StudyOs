package com.studyos.assessment;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.adaptive.CognitiveLevel;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class MockExamService {
    private final JdbcTemplate jdbc;private final QuizService quizzes;private final ObjectMapper mapper;private final com.studyos.prediction.ReadinessValidationService readinessValidation;
    public MockExamService(JdbcTemplate jdbc,QuizService quizzes,ObjectMapper mapper,com.studyos.prediction.ReadinessValidationService readinessValidation){this.jdbc=jdbc;this.quizzes=quizzes;this.mapper=mapper;this.readinessValidation=readinessValidation;}

    public MockExam create(UUID workspaceId,int requestedItems,int requestedMinutes){
        int count=Math.max(2,Math.min(12,requestedItems));int minutes=Math.max(15,Math.min(240,requestedMinutes));
        // The mock's start is the natural moment to snapshot the readiness forecast, so the pair
        // (forecast at start, actual mock result) can be validated later by readiness validation.
        try { readinessValidation.recordForecast(workspaceId, "MOCK_EXAM", null); }
        catch (RuntimeException error) { /* a failed snapshot never blocks the exam itself */ }
        List<Topic> topics=jdbc.query("SELECT t.id,t.canonical_name,COALESCE(es.relevance,0),COALESCE(s.measured_mastery,s.mastery,0) FROM topics t LEFT JOIN exam_topic_signals es ON es.topic_id=t.id AND es.course_id=t.course_id LEFT JOIN student_topic_state s ON s.topic_id=t.id AND s.course_id=t.course_id WHERE t.course_id=? AND EXISTS(SELECT 1 FROM chunk_topics ct WHERE ct.topic_id=t.id) ORDER BY COALESCE(es.relevance,0)*(1-COALESCE(s.measured_mastery,s.mastery,0)) DESC,COALESCE(es.relevance,0) DESC,t.canonical_name LIMIT 6",(rs,row)->new Topic(rs.getObject(1,UUID.class),rs.getString(2),rs.getDouble(3),rs.getDouble(4)),workspaceId);
        if(topics.isEmpty())throw new IllegalArgumentException("Add processed source material before creating a mock exam");
        UUID assessmentId=UUID.randomUUID();String title="Adaptive mock exam";jdbc.update("INSERT INTO assessments(id,course_id,kind,title,status,estimated_minutes,topic_mix,instructions) VALUES(?,?,?,?,?,?,CAST(? AS jsonb),?)",assessmentId,workspaceId,"MOCK_EXAM",title,"GENERATING",minutes,json(topics),"Answer every question on your own. Hints and worked solutions stay locked during a mock exam — you get full feedback once it is graded.");
        List<QuizService.Question> questions=new ArrayList<>();
        try{
            for(int index=0;index<count;index++){Topic topic=topics.get(index%topics.size());double difficulty=Math.max(.45,Math.min(.9,.62+(topic.mastery()-.5)*.25));List<QuizService.Question> generated=quizzes.generate(workspaceId,topic.id(),1,difficulty,"EXAM_STYLE",ActivityKind.MOCK_EXAM.name(),topic.relevance()>=.7?CognitiveLevel.L6_NOVEL.rank():CognitiveLevel.L5_COMBINE.rank());if(!generated.isEmpty()){QuizService.Question question=generated.getFirst();questions.add(question);jdbc.update("UPDATE assessment_items SET assessment_id=?,ordinal=? WHERE id=? AND course_id=?",assessmentId,questions.size(),question.id(),workspaceId);}}
            String status=questions.size()<2?"FAILED":"READY";jdbc.update("UPDATE assessments SET status=? WHERE id=?",status,assessmentId);if("FAILED".equals(status))throw new com.studyos.WorkspaceNotReadyException("StudyOS could not generate enough supported mock-exam questions");
            return get(workspaceId,assessmentId);
        }catch(RuntimeException error){jdbc.update("UPDATE assessments SET status='FAILED' WHERE id=?",assessmentId);throw error;}
    }

    public MockExam start(UUID workspaceId,UUID assessmentId){jdbc.update("UPDATE assessments SET status='ACTIVE',started_at=COALESCE(started_at,NOW()) WHERE id=? AND course_id=? AND status='READY'",assessmentId,workspaceId);return get(workspaceId,assessmentId);}
    public MockExam complete(UUID workspaceId,UUID assessmentId){MockExam exam=get(workspaceId,assessmentId);List<Double> scores=jdbc.query("SELECT DISTINCT ON (ai.id) aa.score FROM assessment_items ai LEFT JOIN assessment_attempts aa ON aa.item_id=ai.id WHERE ai.assessment_id=? AND aa.id IS NOT NULL ORDER BY ai.id,aa.created_at DESC",(rs,row)->rs.getDouble(1),assessmentId);if(scores.size()<exam.questions().size())throw new IllegalArgumentException("Answer every mock-exam question before completing it");double score=scores.stream().mapToDouble(Double::doubleValue).average().orElse(0);jdbc.update("UPDATE assessments SET status='COMPLETED',completed_at=NOW(),score=? WHERE id=? AND course_id=?",score,assessmentId,workspaceId);jdbc.update("INSERT INTO learning_events(id,course_id,event_type,payload) VALUES(?,?,?,CAST(? AS jsonb))",UUID.randomUUID(),workspaceId,"MOCK_EXAM_COMPLETED",json(Map.of("assessmentId",assessmentId,"score",score,"answered",scores.size(),"total",exam.questions().size())));try { readinessValidation.recordActual(workspaceId, score); } catch (RuntimeException error) { /* validation bookkeeping must not fail the exam completion */ }return get(workspaceId,assessmentId);}
    public MockExam get(UUID workspaceId,UUID assessmentId){
        Header header=jdbc.query("SELECT id,title,status,estimated_minutes,instructions,score,created_at,started_at,completed_at FROM assessments WHERE id=? AND course_id=? AND kind='MOCK_EXAM'",rs->rs.next()?new Header(rs.getObject(1,UUID.class),rs.getString(2),rs.getString(3),rs.getInt(4),rs.getString(5),rs.getObject(6,Double.class),rs.getTimestamp(7),rs.getTimestamp(8),rs.getTimestamp(9)):null,assessmentId,workspaceId);if(header==null)throw new IllegalArgumentException("Mock exam was not found");
        List<ExamQuestion> questions=jdbc.query("SELECT id,topic_id,prompt,difficulty,answer_type,ordinal,source_basis::text FROM assessment_items WHERE assessment_id=? ORDER BY ordinal",(rs,row)->new ExamQuestion(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getString(3),rs.getObject(4,Double.class),rs.getString(5),rs.getInt(6),rs.getString(7)),assessmentId);
        return new MockExam(header.id(),workspaceId,header.title(),header.status(),header.minutes(),header.instructions(),header.score(),questions,header.createdAt(),header.startedAt(),header.completedAt());
    }
    public List<MockExam> list(UUID workspaceId){return jdbc.query("SELECT id FROM assessments WHERE course_id=? AND kind='MOCK_EXAM' ORDER BY created_at DESC LIMIT 30",(rs,row)->rs.getObject(1,UUID.class),workspaceId).stream().map(id->get(workspaceId,id)).toList();}
    private String json(Object value){try{return mapper.writeValueAsString(value);}catch(Exception ignored){return "[]";}}
    private record Topic(UUID id,String name,double relevance,double mastery){}
    private record Header(UUID id,String title,String status,int minutes,String instructions,Double score,Timestamp createdAt,Timestamp startedAt,Timestamp completedAt){}
    public record MockExam(UUID id,UUID workspaceId,String title,String status,int estimatedMinutes,String instructions,Double score,List<ExamQuestion> questions,Timestamp createdAt,Timestamp startedAt,Timestamp completedAt){}
    public record ExamQuestion(UUID id,UUID topicId,String prompt,Double difficulty,String answerType,int ordinal,String sourceBasis){}
}
