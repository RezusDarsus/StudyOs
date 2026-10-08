package com.studyos.mastery;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class MasteryService {
    private final JdbcTemplate jdbc;
    public MasteryService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public void recordAssessment(UUID courseId, UUID topicId, double score, double difficulty) { recordAssessment(courseId, topicId, score, difficulty, null, null, null); }
    public void recordAssessment(UUID courseId, UUID topicId, double score, double difficulty, UUID itemId, String answer, String feedback) {
        recordAssessmentResult(courseId, topicId, score, difficulty, itemId, answer, feedback, null, null, "{}");
    }
    public EvidenceImpact recordAssessmentResult(UUID courseId, UUID topicId, double score, double difficulty, UUID itemId, String answer, String feedback, String correctness, String errorType, String structuredFeedback) {
        return recordAssessmentResult(courseId, topicId, score, difficulty, itemId, answer, feedback, correctness, errorType, structuredFeedback, AttemptContext.plain());
    }
    /**
     * Records one graded attempt, weighting it by difficulty, activity kind and support used.
     *
     * <p>Three models read the same attempt and answer different questions with it. {@link BetaEvidenceModel}
     * gives the calibrated mastery and how much evidence stands behind it. {@link KnowledgeTracing} gives the
     * probability the learner could answer right now, discounting a lucky guess and forgiving a slip.
     * {@link SpacedRepetition} gives the difficulty and stability the next review date is derived from. All
     * three are pure functions of the row that was already being read, so this stays one query and one upsert.
     *
     * <p>The whole read-decide-write runs in one transaction with the prior row locked, because the update is
     * absolute: two concurrent attempts on one topic computed against the same prior would silently drop one
     * attempt's evidence, and a topic's mastery is the last thing that should be settled by a race.
     */
    @org.springframework.transaction.annotation.Transactional
    public EvidenceImpact recordAssessmentResult(UUID courseId, UUID topicId, double score, double difficulty, UUID itemId, String answer, String feedback, String correctness, String errorType, String structuredFeedback, AttemptContext context) {
        AttemptContext attempt = context == null ? AttemptContext.plain() : context;
        // Database-level synchronization for the whole read-decide-write: a SELECT ... FOR UPDATE
        // cannot lock a row that does not exist yet, so two concurrent *first* attempts on the same
        // topic could both read the empty prior and silently drop one attempt's evidence. A
        // transaction-scoped advisory lock closes that gap at the database, with no process-local
        // map to fall out of sync in a multi-instance deployment.
        jdbc.query("SELECT pg_advisory_xact_lock(hashtext(?))", (java.sql.ResultSet rs) -> { rs.next(); return null; }, courseId + ":topic:" + topicId);
        Prior prior = prior(courseId, topicId);
        Instant now = Instant.now();
        double before = prior.evidence().alpha() / (prior.evidence().alpha() + prior.evidence().beta());
        BetaEvidenceModel.Result update = BetaEvidenceModel.update(prior.evidence(), score, difficulty, attempt.evidenceWeight());

        int grade = SpacedRepetition.grade(update.boundedScore(), attempt.supportLevelUsed());
        double elapsedDays = prior.elapsedDays(now);
        double retrievability = prior.schedule() == null ? 1 : prior.schedule().retrievability(elapsedDays);
        SpacedRepetition.State schedule = SpacedRepetition.next(prior.schedule(), grade, elapsedDays);
        KnowledgeTracing.Estimate knowledge = KnowledgeTracing.update(prior.known(), update.boundedScore(), difficulty, attempt.supportLevelUsed());

        Timestamp stamp = Timestamp.from(now);
        Timestamp reviewDue = Timestamp.from(now.plus(schedule.reviewInDays(), ChronoUnit.DAYS));
        jdbc.update("INSERT INTO student_topic_state(course_id,topic_id,mastery,confidence,review_due_at,updated_at,alpha,beta,evidence_count,last_assessed_at,measured_mastery,retention_estimate,retention_calculated_at,difficulty_estimate,stability_days,learned_probability) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(course_id,topic_id) DO UPDATE SET mastery=EXCLUDED.mastery,confidence=EXCLUDED.confidence,review_due_at=EXCLUDED.review_due_at,updated_at=EXCLUDED.updated_at,alpha=EXCLUDED.alpha,beta=EXCLUDED.beta,evidence_count=EXCLUDED.evidence_count,last_assessed_at=EXCLUDED.last_assessed_at,measured_mastery=EXCLUDED.measured_mastery,retention_estimate=EXCLUDED.retention_estimate,retention_calculated_at=EXCLUDED.retention_calculated_at,difficulty_estimate=EXCLUDED.difficulty_estimate,stability_days=EXCLUDED.stability_days,learned_probability=EXCLUDED.learned_probability", courseId, topicId, update.mastery(), update.confidence(), reviewDue, stamp, update.alpha(), update.beta(), update.evidenceCount(), stamp, update.mastery(), 1.0, stamp, schedule.difficulty(), schedule.stability(), knowledge.known());
        UUID attemptId = UUID.randomUUID();
        jdbc.update("INSERT INTO assessment_attempts(id,item_id,course_id,topic_id,answer,score,feedback,difficulty,correctness,error_type,mastery_before,mastery_after,mastery_impact,structured_feedback,cognitive_level,activity_kind,support_level_used,evidence_weight,retrievability_at_attempt,stability_after,learned_probability_after,review_grade) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CAST(? AS jsonb),?,?,?,?,?,?,?,?)", attemptId, itemId, courseId, topicId, answer, update.boundedScore(), feedback, BetaEvidenceModel.clamp(difficulty), correctness, errorType, before, update.mastery(), update.mastery() - before, structuredFeedback == null ? "{}" : structuredFeedback, attempt.cognitiveLevel(), attempt.activityKind(), attempt.supportLevelUsed(), update.weight(), retrievability, schedule.stability(), knowledge.known(), grade);
        return new EvidenceImpact(attemptId, before, update.mastery(), update.mastery() - before, update.confidence(), knowledge.known(), schedule.stability(), schedule.reviewInDays());
    }

    /**
     * Everything the three models need about the topic before this attempt. A topic with no row has no
     * schedule rather than a default one, so its first attempt sets an initial difficulty and stability from
     * the grade it earned instead of updating values nobody measured.
     */
    private Prior prior(UUID courseId, UUID topicId) {
        return jdbc.query("SELECT alpha,beta,evidence_count,difficulty_estimate,stability_days,learned_probability,last_assessed_at FROM student_topic_state WHERE course_id=? AND topic_id=? FOR UPDATE", rs -> {
            if (!rs.next()) return new Prior(new BetaEvidenceModel.State(2, 2, 0), null, KnowledgeTracing.PRIOR_KNOWN, null);
            var evidence = new BetaEvidenceModel.State(rs.getDouble("alpha"), rs.getDouble("beta"), rs.getInt("evidence_count"));
            Double difficulty = nullable(rs, "difficulty_estimate");
            Double stability = nullable(rs, "stability_days");
            Double known = nullable(rs, "learned_probability");
            Timestamp assessed = rs.getTimestamp("last_assessed_at");
            SpacedRepetition.State schedule = difficulty == null || stability == null || stability <= 0 ? null : new SpacedRepetition.State(difficulty, stability);
            return new Prior(evidence, schedule, known == null ? KnowledgeTracing.PRIOR_KNOWN : known, assessed == null ? null : assessed.toInstant());
        }, courseId, topicId);
    }

    private record Prior(BetaEvidenceModel.State evidence, SpacedRepetition.State schedule, double known, Instant lastAssessedAt) {
        double elapsedDays(Instant now) { return lastAssessedAt == null ? 0 : Math.max(0, ChronoUnit.MINUTES.between(lastAssessedAt, now) / 1440.0); }
    }

    public void recordStudied(UUID courseId, UUID topicId) { Timestamp now = Timestamp.from(Instant.now()); jdbc.update("UPDATE student_topic_state SET last_studied_at=?,retention_estimate=1,retention_calculated_at=?,updated_at=? WHERE course_id=? AND topic_id=?", now, now, now, courseId, topicId); }
    public record TopicState(UUID topicId, double mastery, double confidence, double measuredMastery, double retentionEstimate, double effectiveMastery, Timestamp reviewDueAt, int evidenceCount, Timestamp lastAssessedAt, Timestamp lastStudiedAt, Double learnedProbability, Double stabilityDays, Double difficultyEstimate) {}
    /** @param learnedProbability the knowledge-tracing estimate after this attempt, alongside the counted mastery */
    public record EvidenceImpact(UUID attemptId, double masteryBefore, double masteryAfter, double masteryImpact, double confidence, double learnedProbability, double stabilityDays, int reviewInDays) {}
    /** How an attempt was produced, so the evidence it generates can be weighted honestly. */
    public record AttemptContext(Integer cognitiveLevel, String activityKind, int supportLevelUsed, double evidenceWeight) {
        public static AttemptContext plain() { return new AttemptContext(null, null, 0, 1); }
    }
    public java.util.List<TopicState> list(UUID courseId) {
        Timestamp now = Timestamp.from(Instant.now());
        return jdbc.query("SELECT topic_id,mastery,confidence,COALESCE(measured_mastery,mastery),COALESCE(retention_estimate,1),review_due_at,evidence_count,last_assessed_at,last_studied_at,COALESCE(last_studied_at,last_assessed_at,updated_at),stability_days,learned_probability,difficulty_estimate FROM student_topic_state WHERE course_id=? ORDER BY mastery ASC", (rs,row) -> {
            Timestamp anchor = rs.getTimestamp(10);
            double measured = rs.getDouble(4);
            double retention = RetentionModel.retention(anchor == null ? null : anchor.toInstant(), now.toInstant(), rs.getDouble("stability_days"));
            return new TopicState(rs.getObject("topic_id", UUID.class),rs.getDouble("mastery"),rs.getDouble("confidence"),measured,retention,measured*retention,rs.getTimestamp("review_due_at"),rs.getInt("evidence_count"),rs.getTimestamp("last_assessed_at"),rs.getTimestamp("last_studied_at"),nullable(rs,"learned_probability"),nullable(rs,"stability_days"),nullable(rs,"difficulty_estimate"));
        }, courseId);
    }

    /** Absent stays absent: a topic never graded reports no estimate rather than a plausible-looking zero. */
    private static Double nullable(java.sql.ResultSet rs, String column) throws java.sql.SQLException {
        double value = rs.getDouble(column);
        return rs.wasNull() ? null : value;
    }
}
