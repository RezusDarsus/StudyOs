package com.studyos.assessment;

import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class ExamPredictionService {
    /** Every prediction report names the model that produced it, for backtesting and calibration. */
    public static final String MODEL_VERSION = "EXAM_TOPIC_V1";

    private final JdbcTemplate jdbc;
    public ExamPredictionService(JdbcTemplate jdbc){this.jdbc=jdbc;}

    public PredictionReport predict(UUID workspaceId){
        int pastExams=jdbc.queryForObject("SELECT COUNT(*) FROM documents WHERE course_id=? AND document_type='PAST_EXAM' AND status='COMPLETED'",Integer.class,workspaceId);
        int pastQuestions=jdbc.queryForObject("SELECT COUNT(*) FROM assessment_items WHERE course_id=? AND source_type='PAST_EXAM'",Integer.class,workspaceId);
        if(pastExams==0||pastQuestions<2)return new PredictionReport("INSUFFICIENT_EVIDENCE","LOW","I do not have enough past-exam evidence to make a reliable structural prediction.",List.of(),List.of(),pastExams,pastQuestions,MODEL_VERSION);
        List<TopicPrediction> topics=jdbc.query("SELECT t.id,t.canonical_name,s.relevance,s.evidence_confidence,s.evidence::text FROM exam_topic_signals s JOIN topics t ON t.id=s.topic_id WHERE s.course_id=? AND s.relevance>0 ORDER BY s.relevance DESC LIMIT 20",(rs,row)->new TopicPrediction(rs.getObject(1,UUID.class),rs.getString(2),rs.getDouble(3),confidence(rs.getDouble(4)),"Syllabus, lecture, homework, and past-exam signals",rs.getString(5)),workspaceId)
                .stream()
                // The learner-facing list shows canonical, structurally valid concepts only.
                .filter(topic -> com.studyos.knowledge.TopicCandidateQuality.evaluate(topic.topic()).accepted())
                .limit(8)
                .toList();
        List<StructurePrediction> structures=jdbc.query("SELECT type,COUNT(*) AS frequency,AVG(COALESCE(points,0)) AS avg_points,COUNT(DISTINCT document_id) AS exams,STRING_AGG(DISTINCT d.name,', ' ORDER BY d.name) AS documents FROM assessment_items a LEFT JOIN documents d ON d.id=a.document_id WHERE a.course_id=? AND a.source_type='PAST_EXAM' GROUP BY type ORDER BY frequency DESC,type LIMIT 8",(rs,row)->{int frequency=rs.getInt(2),exams=rs.getInt(4);double probability=Math.min(.95,(double)exams/Math.max(1,pastExams)*.7+(double)frequency/Math.max(1,pastQuestions)*.3);return new StructurePrediction(rs.getString(1),probability,confidence(probability),"Appeared "+frequency+" times across "+exams+" past exam(s)",rs.getString(5),rs.getDouble(3));},workspaceId);
        double evidence=Math.min(1,.35*pastExams+.08*pastQuestions);
        return new PredictionReport("EVIDENCE_AVAILABLE",confidence(evidence),"Predictions describe recurring topics and question structures, not guaranteed exam content.",topics,structures,pastExams,pastQuestions,MODEL_VERSION);
    }
    static String confidence(double value){return value>=.75?"HIGH":value>=.45?"MEDIUM":"LOW";}
    public record PredictionReport(String status,String confidence,String disclaimer,List<TopicPrediction> likelyTopics,List<StructurePrediction> likelyStructures,int pastExamDocuments,int pastExamQuestions,String modelVersion){}
    public record TopicPrediction(UUID topicId,String topic,double probability,String confidence,String why,String evidence){}
    public record StructurePrediction(String questionType,double probability,String confidence,String why,String sourceEvidence,double averageMarks){}
}
