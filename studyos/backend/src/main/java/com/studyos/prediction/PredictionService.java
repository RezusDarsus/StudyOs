package com.studyos.prediction;

import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class PredictionService {
    /** Every readiness forecast carries its model version so history stays comparable and calibratable. */
    public static final String MODEL_VERSION = "READINESS_V1";

    private final JdbcTemplate jdbc;
    public PredictionService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public Forecast forecast(UUID courseId) {
        List<TopicRisk> topics = jdbc.query("SELECT t.id,t.canonical_name,COALESCE(s.mastery,0) AS mastery,COALESCE(s.measured_mastery,s.mastery,0) AS measured_mastery,COALESCE(s.retention_estimate,1) AS retention,COALESCE(s.confidence,0) AS confidence,s.review_due_at,COALESCE(es.relevance,0) AS exam_relevance,COALESCE(es.evidence_confidence,0) AS evidence_confidence,COALESCE((SELECT MAX(m.severity) FROM misconceptions m WHERE m.course_id=t.course_id AND m.topic_id=t.id AND m.status<>'RESOLVED'),0) AS misconception_severity,COUNT(DISTINCT ct.chunk_id) AS evidence_count,(SELECT COUNT(*) FROM assessment_attempts aa WHERE aa.course_id=t.course_id AND aa.topic_id=t.id) AS attempt_count FROM topics t LEFT JOIN student_topic_state s ON s.topic_id=t.id AND s.course_id=t.course_id LEFT JOIN exam_topic_signals es ON es.topic_id=t.id AND es.course_id=t.course_id LEFT JOIN chunk_topics ct ON ct.topic_id=t.id WHERE t.course_id=? GROUP BY t.id,t.canonical_name,s.mastery,s.measured_mastery,s.retention_estimate,s.confidence,s.review_due_at,es.relevance,es.evidence_confidence ORDER BY t.canonical_name", (rs,row) -> {
            double mastery = rs.getDouble("mastery");
            double measured = rs.getDouble("measured_mastery");
            double retention = rs.getDouble("retention");
            double confidence = rs.getDouble("confidence");
            double effective = measured * retention;
            double relevance = rs.getDouble("exam_relevance");
            Timestamp reviewDue = rs.getTimestamp("review_due_at");
            boolean due = reviewDue != null && !reviewDue.toInstant().isAfter(java.time.Instant.now());
            double risk = Math.min(1, .40 * relevance * (1 - effective) + .20 * (due ? 1 : 0) + .15 * rs.getDouble("misconception_severity") + .10 * (1 - confidence) + .10 * (1 - rs.getDouble("evidence_confidence")) + .05 * (1 - relevance));
            String reason = rs.getDouble("misconception_severity") >= .6 ? "active misconception needs targeted review" : due ? "review is due" : relevance >= .7 && effective < .6 ? "high exam relevance with a knowledge gap" : effective < .6 ? "effective mastery is below 60%" : "keep practicing";
            return new TopicRisk(rs.getObject("id",UUID.class),rs.getString("canonical_name"),mastery,effective,retention,confidence,relevance,rs.getDouble("evidence_confidence"),rs.getDouble("misconception_severity"),risk,reason,rs.getLong("evidence_count"),rs.getInt("attempt_count"),reviewDue);
        }, courseId).stream().sorted(Comparator.comparingDouble(TopicRisk::risk).reversed()).toList();
        LocalDate examDate = jdbc.query("SELECT exam_date FROM courses WHERE id=?", rs -> { if (!rs.next() || rs.getDate("exam_date") == null) return null; return rs.getDate("exam_date").toLocalDate(); }, courseId);
        if (topics.isEmpty()) return new Forecast("INSUFFICIENT_EVIDENCE",0,0,"Upload learning sources and complete an assessment",List.of(),null,examDate,daysToExam(examDate),new Breakdown(0,0,0,0,0,0),List.of(),MODEL_VERSION);
        int openMisconceptions=jdbc.queryForObject("SELECT COUNT(*) FROM misconceptions WHERE course_id=? AND status<>'RESOLVED'",Integer.class,courseId);
        ReadinessCalculator.Result calculated=ReadinessCalculator.calculate(topics.stream().map(topic->new ReadinessCalculator.Topic(topic.effectiveMastery(),topic.examRelevance(),topic.retention(),topic.attemptCount())).toList(),openMisconceptions);
        double readiness=calculated.readiness();
        double relevanceTotal = topics.stream().mapToDouble(topic -> Math.max(.05, topic.examRelevance())).sum();
        double confidence = topics.stream().mapToDouble(topic -> topic.confidence() * Math.max(.05, topic.examRelevance())).sum() / relevanceTotal;
        String status = readiness >= .75 && confidence >= .5 ? "ON_TRACK" : readiness >= .5 ? "AT_RISK" : "HIGH_RISK";
        TopicRisk focus = topics.get(0);
        Timestamp nextReview = topics.stream().map(TopicRisk::reviewDue).filter(java.util.Objects::nonNull).min(Timestamp::compareTo).orElse(null);
        Breakdown breakdown=new Breakdown(calculated.conceptMastery(),calculated.highPriorityTopics(),calculated.practiceCoverage(),calculated.retention(),calculated.openMisconceptions(),readiness);
        List<Improvement> improvements=topics.stream().limit(3).map(topic->new Improvement(topic.topicId(),action(topic),topic.name(),topic.misconceptionSeverity()>=.5||topic.examRelevance()>=.75&&topic.effectiveMastery()<.6?"HIGH":"MEDIUM",topic.reason())).toList();
        return new Forecast(status,readiness,confidence,focus.name(),topics.stream().limit(5).toList(),nextReview,examDate,daysToExam(examDate),breakdown,improvements,MODEL_VERSION);
    }

    private String action(TopicRisk topic){if(topic.misconceptionSeverity()>=.5)return "Resolve misconception in "+topic.name();if(topic.retention()<.65)return "Review "+topic.name();return "Practice "+topic.name();}

    private Long daysToExam(LocalDate examDate) { return examDate == null ? null : ChronoUnit.DAYS.between(LocalDate.now(), examDate); }

    public record Forecast(String status,double readiness,double confidence,String predictedFocus,List<TopicRisk> risks,Timestamp nextReviewAt,LocalDate examDate,Long daysToExam,Breakdown breakdown,List<Improvement> fastestImprovements,String modelVersion) {
        public String compact() { return "status=" + status + ", readiness=" + Math.round(readiness * 100) + "%, confidence=" + Math.round(confidence * 100) + "%, predicted focus=" + predictedFocus; }
    }
    public record TopicRisk(UUID topicId,String name,double mastery,double effectiveMastery,double retention,double confidence,double examRelevance,double evidenceConfidence,double misconceptionSeverity,double risk,String reason,long evidenceCount,int attemptCount,Timestamp reviewDue) {}
    public record Breakdown(double conceptMastery,double highPriorityTopics,double practiceCoverage,double retention,int openMisconceptions,double readiness){}
    public record Improvement(UUID topicId,String action,String topic,String estimatedImpact,String reason){}
}
