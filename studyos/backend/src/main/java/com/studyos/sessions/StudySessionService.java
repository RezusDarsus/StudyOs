package com.studyos.sessions;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.learner.LearnerProfileService;
import com.studyos.planner.StudyPlanService;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class StudySessionService {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final StudyPlanService plans;
    private final LearnerProfileService profiles;

    public StudySessionService(JdbcTemplate jdbc,ObjectMapper mapper,StudyPlanService plans,LearnerProfileService profiles){this.jdbc=jdbc;this.mapper=mapper;this.plans=plans;this.profiles=profiles;}

    public Session start(UUID workspaceId,UUID taskId,UUID requestedTopicId){
        StudyPlanService.TaskDetails task=taskId==null?null:plans.details(taskId,workspaceId);
        UUID topicId=task==null?requestedTopicId:task.topicId();
        if(topicId!=null&&!topicExists(workspaceId,topicId))throw new IllegalArgumentException("Topic was not found in this workspace");
        Double masteryBefore=mastery(workspaceId,topicId);
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO learning_sessions(id,course_id,task_id,topic_id,status,mastery_before) VALUES(?,?,?,?,?,?)",id,workspaceId,taskId,topicId,"ACTIVE",masteryBefore);
        return get(workspaceId,id);
    }

    public Session get(UUID workspaceId,UUID sessionId){
        Session session=jdbc.query("SELECT s.id,s.course_id,s.task_id,s.topic_id,t.canonical_name,s.status,s.started_at,s.completed_at,s.duration_minutes,s.notes,s.mastery_before,s.mastery_after,s.summary::text FROM learning_sessions s LEFT JOIN topics t ON t.id=s.topic_id WHERE s.id=? AND s.course_id=?",rs->rs.next()?new Session(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getObject(3,UUID.class),rs.getObject(4,UUID.class),rs.getString(5),rs.getString(6),rs.getTimestamp(7),rs.getTimestamp(8),rs.getObject(9,Integer.class),rs.getString(10),rs.getObject(11,Double.class),rs.getObject(12,Double.class),rs.getString(13)):null,sessionId,workspaceId);
        if(session==null)throw new IllegalArgumentException("Study session was not found");
        return session;
    }

    public List<Session> list(UUID workspaceId){return jdbc.query("SELECT s.id,s.course_id,s.task_id,s.topic_id,t.canonical_name,s.status,s.started_at,s.completed_at,s.duration_minutes,s.notes,s.mastery_before,s.mastery_after,s.summary::text FROM learning_sessions s LEFT JOIN topics t ON t.id=s.topic_id WHERE s.course_id=? ORDER BY s.started_at DESC LIMIT 100",(rs,row)->new Session(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getObject(3,UUID.class),rs.getObject(4,UUID.class),rs.getString(5),rs.getString(6),rs.getTimestamp(7),rs.getTimestamp(8),rs.getObject(9,Integer.class),rs.getString(10),rs.getObject(11,Double.class),rs.getObject(12,Double.class),rs.getString(13)),workspaceId);}

    public Completion complete(UUID workspaceId,UUID sessionId,Integer requestedMinutes,String notes){
        Session session=get(workspaceId,sessionId);
        if(!"ACTIVE".equals(session.status()))return completion(session);
        Instant start=session.startedAt().toInstant();
        int minutes=requestedMinutes==null?Math.max(1,(int)Duration.between(start,Instant.now()).toMinutes()):Math.max(1,Math.min(720,requestedMinutes));
        String topicFilter=session.topicId()==null?"":" AND topic_id=?";
        Object[] attemptArgs=session.topicId()==null?new Object[]{workspaceId,Timestamp.from(start)}:new Object[]{workspaceId,Timestamp.from(start),session.topicId()};
        AttemptStats attempts=jdbc.query("SELECT COUNT(*),COUNT(*) FILTER (WHERE score>=.85),COUNT(*) FILTER (WHERE score>=.35 AND score<.85),COUNT(*) FILTER (WHERE score<.35),AVG(score) FROM assessment_attempts WHERE course_id=? AND created_at>=?"+topicFilter,rs->{rs.next();return new AttemptStats(rs.getInt(1),rs.getInt(2),rs.getInt(3),rs.getInt(4),rs.getObject(5,Double.class));},attemptArgs);
        Object[] misconceptionArgs=session.topicId()==null?new Object[]{workspaceId,Timestamp.from(start)}:new Object[]{workspaceId,Timestamp.from(start),session.topicId()};
        int newMisconceptions=jdbc.queryForObject("SELECT COUNT(*) FROM misconceptions WHERE course_id=? AND COALESCE(first_seen_at,last_seen_at)>=?"+topicFilter,Integer.class,misconceptionArgs);
        Double masteryAfter=mastery(workspaceId,session.topicId());
        SessionSummary summary=new SessionSummary(minutes,session.topicId(),session.topic(),attempts.total(),attempts.correct(),attempts.partial(),attempts.incorrect(),attempts.averageScore(),newMisconceptions,session.masteryBefore(),masteryAfter,masteryAfter==null||session.masteryBefore()==null?0:masteryAfter-session.masteryBefore());
        String summaryJson=json(summary);
        jdbc.update("UPDATE learning_sessions SET status='COMPLETED',completed_at=NOW(),duration_minutes=?,notes=?,mastery_after=?,summary=CAST(? AS jsonb) WHERE id=? AND course_id=?",minutes,notes,masteryAfter,summaryJson,sessionId,workspaceId);
        jdbc.update("INSERT INTO learning_events(id,course_id,topic_id,event_type,payload) VALUES(?,?,?,?,CAST(? AS jsonb))",UUID.randomUUID(),workspaceId,session.topicId(),"STUDY_SESSION_COMPLETED",summaryJson);
        if(session.taskId()!=null)plans.complete(session.taskId(),minutes,true,null,null,"Completed inside StudyOS session");
        profiles.refresh(workspaceId);
        return new Completion(get(workspaceId,sessionId),summary);
    }

    private Completion completion(Session session){try{return new Completion(session,mapper.readValue(session.summaryJson(),SessionSummary.class));}catch(Exception ignored){return new Completion(session,new SessionSummary(session.durationMinutes()==null?0:session.durationMinutes(),session.topicId(),session.topic(),0,0,0,0,null,0,session.masteryBefore(),session.masteryAfter(),0));}}
    private boolean topicExists(UUID workspaceId,UUID topicId){Integer count=jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE id=? AND course_id=?",Integer.class,topicId,workspaceId);return count!=null&&count>0;}
    private Double mastery(UUID workspaceId,UUID topicId){if(topicId==null)return null;return jdbc.query("SELECT COALESCE(measured_mastery,mastery) FROM student_topic_state WHERE course_id=? AND topic_id=?",rs->rs.next()?rs.getDouble(1):null,workspaceId,topicId);}
    private String json(Object value){try{return mapper.writeValueAsString(value);}catch(Exception ignored){return "{}";}}

    private record AttemptStats(int total,int correct,int partial,int incorrect,Double averageScore){}
    public record Session(UUID id,UUID workspaceId,UUID taskId,UUID topicId,String topic,String status,Timestamp startedAt,Timestamp completedAt,Integer durationMinutes,String notes,Double masteryBefore,Double masteryAfter,String summaryJson){}
    public record SessionSummary(int durationMinutes,UUID topicId,String topic,int exercises,int correct,int partiallyCorrect,int incorrect,Double averageScore,int newMisconceptions,Double masteryBefore,Double masteryAfter,double masteryImpact){}
    public record Completion(Session session,SessionSummary summary){}
}
