package com.studyos.learning;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class LearningService {
    private final JdbcTemplate jdbc;
    public LearningService(JdbcTemplate jdbc){this.jdbc=jdbc;}
    /**
     * Records a learning event for history. Deliberately no mastery side effects: durable learner
     * state changes only through a graded attempt (QuizService.submit → MasteryService), never
     * because a client posted a score. The event stream is evidence, not a write path into it.
     */
    public void record(UUID courseId, EventRequest event){ jdbc.update("INSERT INTO learning_events(id,course_id,topic_id,event_type,payload) VALUES(?,?,?,?,?::jsonb)",UUID.randomUUID(),courseId,event.topicId(),event.eventType(),event.payload()==null?"{}":event.payload()); }
    public java.util.List<Event> list(UUID courseId) { return jdbc.query("SELECT e.id,e.topic_id,t.canonical_name,e.event_type,e.payload,e.occurred_at FROM learning_events e LEFT JOIN topics t ON t.id=e.topic_id WHERE e.course_id=? ORDER BY e.occurred_at DESC LIMIT 100", (rs,row) -> new Event(rs.getObject("id",UUID.class),rs.getObject("topic_id",UUID.class),rs.getString("canonical_name"),rs.getString("event_type"),rs.getString("payload"),rs.getTimestamp("occurred_at")), courseId); }
    public record EventRequest(UUID topicId,String eventType,String payload){}
    public record Event(UUID id,UUID topicId,String topicName,String eventType,String payload,java.sql.Timestamp occurredAt){}
}
