package com.studyos.assessment;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * The only way a misconception enters, strengthens or leaves durable learner state.
 *
 * <p>What a grading model proposes is a candidate, never a fact. {@link MisconceptionEvidence} decides whether the
 * attempt it came from actually evidences it and which recorded misconception it is the same one as; this class does
 * the reading and writing that decision needs, and records the decision itself in {@code misconception_evidence}
 * whether or not anything durable came of it. A rejected candidate leaves a row and nothing else, so "the grader
 * proposed forty and nine were grounded in what the learner wrote" is a query rather than an unanswerable question.
 *
 * <p>The split is the house one: the judgement is pure and tested, the SQL is here.
 */
@Service
public class MisconceptionService {
    /**
     * At or above this an attempt counts as progress against the topic's open misconceptions. Deliberately below
     * {@link AssessmentOutcomeRules#CORRECT_SCORE}: improvement is credited before correctness is, because a learner
     * climbing out of a misconception passes through partly-right answers on the way.
     */
    private static final double IMPROVING_SCORE = .75;
    /** Consecutive good attempts that close a misconception. */
    private static final int STREAK_TO_RESOLVE = 3;
    /**
     * How many recorded misconceptions one candidate is clustered against. A bound on the work each submission does;
     * ordered by severity, so anything past it is the weakest state the workspace holds.
     */
    private static final int CLUSTER_AGAINST = 200;
    private static final int MAX_EVIDENCE_ROWS = 200;

    private final JdbcTemplate jdbc;
    public MisconceptionService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /**
     * Judges one proposed misconception against the attempt it came from and writes only what the evidence supports.
     *
     * @param candidate the grader's own free text, unexamined. Recorded either way; admitted only if evidenced.
     * @param attempt   what was asked, what was expected and what the learner wrote — the same material the grading
     *                  model was shown, so nothing it returned is being used as evidence for itself.
     * @param origin    the attempt, item and error code this came from, for the audit trail. May be null.
     * @return what was decided, or null when the grader proposed nothing at all.
     */
    public MisconceptionEvidence.Finding observe(UUID courseId, UUID topicId, String candidate,
                                                MisconceptionEvidence.Attempt attempt, Origin origin) {
        Double score = attempt == null ? null : attempt.score();
        if (candidate == null || candidate.isBlank()) {
            // Nothing proposed: there is no candidate to judge, so there is no verdict to record either.
            successfulAttempt(courseId, topicId, score, null);
            return null;
        }
        MisconceptionEvidence.Finding finding = MisconceptionEvidence.of(candidate, attempt, known(courseId, topicId));
        UUID misconceptionId = apply(courseId, topicId, finding, score);
        recordEvidence(courseId, topicId, misconceptionId, finding, score, origin);
        successfulAttempt(courseId, topicId, score, misconceptionId);
        return finding;
    }

    /** The misconceptions this topic already holds, strongest first so the one already acted on wins a tie. */
    private List<MisconceptionEvidence.Known> known(UUID courseId, UUID topicId) {
        return jdbc.query("SELECT id,label FROM misconceptions WHERE course_id=? AND topic_id IS NOT DISTINCT FROM ? ORDER BY severity DESC,last_seen_at DESC LIMIT " + CLUSTER_AGAINST,
                (rs, row) -> new MisconceptionEvidence.Known(rs.getObject("id", UUID.class), rs.getString("label")), courseId, topicId);
    }

    /** Writes the durable state the finding calls for, and returns the misconception it concerns, if any. */
    private UUID apply(UUID courseId, UUID topicId, MisconceptionEvidence.Finding finding, Double score) {
        Timestamp now = Timestamp.from(Instant.now());
        double missed = Math.max(0, 1 - (score == null ? 1 : score));
        return switch (finding.action()) {
            case CREATED -> {
                UUID id = UUID.randomUUID();
                jdbc.update("INSERT INTO misconceptions(id,course_id,topic_id,label,normalized_label,occurrences,status,severity,successful_streak,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,1,'DETECTED',?,0,?,?)",
                        id, courseId, topicId, finding.label(), finding.label().toLowerCase(Locale.ROOT), Math.max(.2, missed), now, now);
                yield id;
            }
            // The stored label is the wording that was validated when the misconception was established, and it
            // stays. Overwriting it with each new phrasing made the label the quiz generator teaches against drift
            // with whatever the last grader happened to type; every phrasing is kept in the evidence trail instead.
            case REINFORCED -> {
                jdbc.update("UPDATE misconceptions SET occurrences=occurrences+1,status=CASE WHEN status='RESOLVED' OR occurrences>0 THEN 'REINFORCED' ELSE 'DETECTED' END,severity=LEAST(1,GREATEST(severity,.25)+?),successful_streak=0,last_seen_at=?,resolved_at=NULL WHERE id=?",
                        missed * .2, now, finding.misconceptionId());
                yield finding.misconceptionId();
            }
            case REJECTED -> null;
        };
    }

    /** One row per candidate, admitted or not. This is the record that makes an unfounded candidate visible. */
    private void recordEvidence(UUID courseId, UUID topicId, UUID misconceptionId,
                                MisconceptionEvidence.Finding finding, Double score, Origin origin) {
        jdbc.update("INSERT INTO misconception_evidence(id,course_id,topic_id,misconception_id,attempt_id,item_id,candidate_label,verdict,action,grounded_share,cluster_similarity,learner_excerpt,score,error_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                UUID.randomUUID(), courseId, topicId, misconceptionId,
                origin == null ? null : origin.attemptId(), origin == null ? null : origin.itemId(),
                finding.label(), finding.verdict().name(), finding.action().name(),
                measured(finding.groundedShare()), measured(finding.clusterSimilarity()),
                finding.learnerExcerpt(), score, origin == null ? null : origin.errorType());
    }

    /**
     * Credits a good attempt against the topic's open misconceptions — except the one this very attempt evidenced.
     * A misconception created or reinforced by an answer cannot also be counted as improved by it, which is what
     * used to happen to anything found in an answer scoring between {@link #IMPROVING_SCORE} and correct.
     */
    private void successfulAttempt(UUID courseId, UUID topicId, Double score, UUID evidenced) {
        if (topicId == null || score == null || score < IMPROVING_SCORE) return;
        jdbc.update("UPDATE misconceptions SET successful_streak=successful_streak+1,severity=GREATEST(.05,severity*.8),status=CASE WHEN successful_streak+1>=" + STREAK_TO_RESOLVE + " THEN 'RESOLVED' ELSE 'IMPROVING' END,resolved_at=CASE WHEN successful_streak+1>=" + STREAK_TO_RESOLVE + " THEN NOW() ELSE NULL END WHERE course_id=? AND topic_id=? AND status<>'RESOLVED' AND id IS DISTINCT FROM ?", courseId, topicId, evidenced);
    }

    public List<View> active(UUID courseId) {
        return jdbc.query("SELECT id,topic_id,label,status,occurrences,severity,successful_streak,last_seen_at,resolved_at FROM misconceptions WHERE course_id=? AND status<>'RESOLVED' ORDER BY severity DESC,last_seen_at DESC", (rs, row) -> new View(rs.getObject("id", UUID.class), rs.getObject("topic_id", UUID.class), rs.getString("label"), rs.getString("status"), rs.getInt("occurrences"), rs.getDouble("severity"), rs.getInt("successful_streak"), rs.getTimestamp("last_seen_at"), rs.getTimestamp("resolved_at")), courseId);
    }

    /**
     * How much of what the graders proposed this workspace actually accepted, and the recent candidates behind it.
     * Every verdict is reported including the ones with no rows, so a zero is a measured zero and not a gap.
     */
    public Audit audit(UUID courseId, int limit) {
        Map<String, Integer> byVerdict = new LinkedHashMap<>();
        Map<String, Integer> byAction = new LinkedHashMap<>();
        jdbc.query("SELECT verdict,action,COUNT(*) AS candidates FROM misconception_evidence WHERE course_id=? GROUP BY verdict,action", rs -> {
            int candidates = rs.getInt("candidates");
            byVerdict.merge(rs.getString("verdict"), candidates, Integer::sum);
            byAction.merge(rs.getString("action"), candidates, Integer::sum);
        }, courseId);
        List<VerdictCount> counts = new ArrayList<>();
        for (MisconceptionEvidence.Verdict verdict : MisconceptionEvidence.Verdict.values()) counts.add(new VerdictCount(verdict.name(), byVerdict.getOrDefault(verdict.name(), 0)));
        int candidates = byAction.values().stream().mapToInt(Integer::intValue).sum();
        return new Audit(candidates, byAction.getOrDefault("CREATED", 0), byAction.getOrDefault("REINFORCED", 0),
                byAction.getOrDefault("REJECTED", 0), counts, recent(courseId, limit));
    }

    private List<Evidence> recent(UUID courseId, int limit) {
        return jdbc.query("SELECT id,topic_id,misconception_id,attempt_id,item_id,candidate_label,verdict,action,grounded_share,cluster_similarity,learner_excerpt,score,error_type,created_at FROM misconception_evidence WHERE course_id=? ORDER BY created_at DESC LIMIT ?",
                (rs, row) -> new Evidence(rs.getObject("id", UUID.class), rs.getObject("topic_id", UUID.class),
                        rs.getObject("misconception_id", UUID.class), rs.getObject("attempt_id", UUID.class),
                        rs.getObject("item_id", UUID.class), rs.getString("candidate_label"), rs.getString("verdict"),
                        rs.getString("action"), rs.getObject("grounded_share", Double.class),
                        rs.getObject("cluster_similarity", Double.class), rs.getString("learner_excerpt"),
                        rs.getObject("score", Double.class), rs.getString("error_type"), rs.getTimestamp("created_at")),
                courseId, Math.max(1, Math.min(limit, MAX_EVIDENCE_ROWS)));
    }

    public void resolve(UUID courseId,UUID misconceptionId){int updated=jdbc.update("UPDATE misconceptions SET status='RESOLVED',resolved_at=NOW(),successful_streak=GREATEST(successful_streak,"+STREAK_TO_RESOLVE+") WHERE id=? AND course_id=?",misconceptionId,courseId);if(updated==0)throw new IllegalArgumentException("Misconception was not found");}

    /** The sentinel becomes SQL NULL: a column must not report a figure that was never measured. */
    private Double measured(double value) { return value < 0 ? null : value; }

    /** Where a candidate came from, for the trail. Ids only — the evidence itself is in the attempt. */
    public record Origin(UUID attemptId, UUID itemId, String errorType) {}
    public record View(UUID id, UUID topicId, String label, String status, int occurrences, double severity, int successfulStreak, Timestamp lastSeenAt, Timestamp resolvedAt) {}
    /**
     * @param groundedShare     how much of the candidate's own vocabulary was found in the attempt, or null when
     *                          there was nothing to measure it over
     * @param clusterSimilarity how close the nearest recorded misconception was, or null when there was none
     */
    public record Evidence(UUID id, UUID topicId, UUID misconceptionId, UUID attemptId, UUID itemId, String candidateLabel,
                           String verdict, String action, Double groundedShare, Double clusterSimilarity,
                           String learnerExcerpt, Double score, String errorType, Timestamp createdAt) {}
    public record Audit(int candidates, int created, int reinforced, int rejected, List<VerdictCount> byVerdict, List<Evidence> recent) {}
    public record VerdictCount(String verdict, int candidates) {}
}
