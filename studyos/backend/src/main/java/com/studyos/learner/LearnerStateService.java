package com.studyos.learner;

import com.studyos.assessment.MisconceptionService;
import com.studyos.mastery.RetentionModel;
import java.sql.Timestamp;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class LearnerStateService {
    private static final Set<String> PREFERENCE_KEYS=Set.of("EXPLANATION_ORDER","SESSION_LENGTH","EXPLANATION_LANGUAGE","EXERCISE_DIFFICULTY","NOTATION_STYLE","FEEDBACK_STYLE");
    private final JdbcTemplate jdbc;private final MisconceptionService misconceptions;
    public LearnerStateService(JdbcTemplate jdbc,MisconceptionService misconceptions){this.jdbc=jdbc;this.misconceptions=misconceptions;}

    public LearnerState get(UUID workspaceId){
        java.time.Instant now=java.time.Instant.now();
        List<TopicState> topics=jdbc.query("SELECT t.id,t.canonical_name,COALESCE(s.measured_mastery,s.mastery,0),COALESCE(s.confidence,0),s.last_assessed_at,COALESCE(s.evidence_count,0),s.learned_probability,s.stability_days,COALESCE(s.last_studied_at,s.last_assessed_at,s.updated_at),s.review_due_at FROM topics t LEFT JOIN student_topic_state s ON s.topic_id=t.id AND s.course_id=t.course_id WHERE t.course_id=? ORDER BY COALESCE(s.measured_mastery,s.mastery,0) DESC,t.canonical_name",(rs,row)->{
            Timestamp anchor=rs.getTimestamp(9);Double known=(Double)rs.getObject(7);Double stability=(Double)rs.getObject(8);
            // Computed now, not read back from the row. The stored estimate is written as one at the moment of
            // the attempt, so a column read reports every topic as perfectly retained however long ago that was.
            double retention=RetentionModel.retention(anchor==null?null:anchor.toInstant(),now,stability==null?0:stability);
            Double recall=known==null||stability==null?null:known*retention;
            return new TopicState(rs.getObject(1,UUID.class),rs.getString(2),rs.getDouble(3),rs.getDouble(4),retention,rs.getTimestamp(5),rs.getInt(6),recall,rs.getTimestamp(10));
        },workspaceId);
        List<Preference> preferences=jdbc.query("SELECT preference_key,preference_value,source,updated_at FROM workspace_preferences WHERE course_id=? ORDER BY preference_key",(rs,row)->new Preference(rs.getString(1),rs.getString(2),rs.getString(3),rs.getTimestamp(4)),workspaceId);
        List<HistoryItem> history=jdbc.query("SELECT e.id,e.event_type,e.payload::text,e.occurred_at,t.canonical_name FROM learning_events e LEFT JOIN topics t ON t.id=e.topic_id WHERE e.course_id=? ORDER BY e.occurred_at DESC LIMIT 20",(rs,row)->new HistoryItem(rs.getObject(1,UUID.class),rs.getString(2),rs.getString(3),rs.getTimestamp(4),rs.getString(5)),workspaceId);
        return new LearnerState(strengths(topics),weaknesses(topics),unassessed(topics),preferences,misconceptions.active(workspaceId),history);
    }

    private static final double STRONG_FROM=.75, WEAK_BELOW=.6;
    private static final int REPORTED=8, REPORTED_UNASSESSED=12;

    static List<TopicState> strengths(List<TopicState> topics){
        return topics.stream().filter(TopicState::assessed).filter(topic->topic.mastery()>=STRONG_FROM).limit(REPORTED).toList();
    }

    /** Measured and low. A topic nobody has tested is not a weakness, however little mastery is recorded for it. */
    static List<TopicState> weaknesses(List<TopicState> topics){
        return topics.stream().filter(TopicState::assessed).filter(topic->topic.mastery()<WEAK_BELOW)
                .sorted(java.util.Comparator.comparingDouble(TopicState::mastery)).limit(REPORTED).toList();
    }

    /**
     * Reported as its own list rather than dropped or folded into the weaknesses: calling an untested topic a
     * weakness states a measurement nobody took, and hiding it is how it never gets assessed either.
     */
    static List<TopicState> unassessed(List<TopicState> topics){
        return topics.stream().filter(topic->!topic.assessed()).limit(REPORTED_UNASSESSED).toList();
    }

    public Preference putPreference(UUID workspaceId,String key,String value){String normalized=key==null?"":key.trim().toUpperCase(java.util.Locale.ROOT);if(!PREFERENCE_KEYS.contains(normalized))throw new IllegalArgumentException("Unsupported learning preference");jdbc.update("INSERT INTO workspace_preferences(course_id,preference_key,preference_value,source) VALUES(?,?,?,'USER') ON CONFLICT(course_id,preference_key) DO UPDATE SET preference_value=EXCLUDED.preference_value,source='USER',updated_at=NOW()",workspaceId,normalized,value.trim());return jdbc.query("SELECT preference_key,preference_value,source,updated_at FROM workspace_preferences WHERE course_id=? AND preference_key=?",rs->{rs.next();return new Preference(rs.getString(1),rs.getString(2),rs.getString(3),rs.getTimestamp(4));},workspaceId,normalized);}
    public void deletePreference(UUID workspaceId,String key){jdbc.update("DELETE FROM workspace_preferences WHERE course_id=? AND preference_key=?",workspaceId,key.toUpperCase(java.util.Locale.ROOT));}
    public void resolveMisconception(UUID workspaceId,UUID misconceptionId){misconceptions.resolve(workspaceId,misconceptionId);}

    public record LearnerState(List<TopicState> strongTopics,List<TopicState> weakTopics,List<TopicState> unassessedTopics,List<Preference> preferences,List<MisconceptionService.View> openMisconceptions,List<HistoryItem> recentHistory){}
    /**
     * @param retention what is left of the measurement now, on this topic's own forgetting curve
     * @param recallProbability probability the learner could answer today, or null when never traced
     */
    public record TopicState(UUID topicId,String topic,double mastery,double confidence,double retention,Timestamp lastAssessedAt,int evidenceCount,Double recallProbability,Timestamp reviewDueAt){
        /** No recorded attempt means no measurement, so this topic is neither a strength nor a weakness. */
        public boolean assessed(){return evidenceCount>0||lastAssessedAt!=null;}
    }
    public record Preference(String key,String value,String source,Timestamp updatedAt){}
    public record HistoryItem(UUID id,String type,String payload,Timestamp occurredAt,String topic){}
}
