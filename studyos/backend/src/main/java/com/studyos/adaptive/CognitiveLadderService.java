package com.studyos.adaptive;

import com.studyos.mastery.RetentionModel;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Keeps the cognitive ladder for every topic in a workspace: which level the next activity should
 * sit at, when to drop into a diagnostic, and which prerequisite to repair before coming back.
 */
@Service
public class CognitiveLadderService {
    /** A prerequisite counts as missing below this effective mastery. Mirrors the planner default. */
    private static final double WEAK_PREREQUISITE = .6;

    private final JdbcTemplate jdbc;
    private final com.fasterxml.jackson.databind.ObjectMapper mapper;
    public CognitiveLadderService(JdbcTemplate jdbc, com.fasterxml.jackson.databind.ObjectMapper mapper) { this.jdbc = jdbc; this.mapper = mapper; }

    /**
     * What the next activity for this topic should look like. Creates ladder state on first use, so
     * the topic is checked against the workspace first: writing state for a topic belonging to a
     * different workspace would leak that topic's name into this one's ladder view.
     */
    public Plan plan(UUID courseId, UUID topicId) {
        if (topicId == null) return new Plan(null, null, CognitiveLevel.L3_APPLY, CognitiveLevel.L3_APPLY.difficulty(), false, null, null,
                "No topic selected, so the activity stays at a general applied level.", 0, 0, 0);
        String topic = topic(courseId, topicId);
        if (topic == null) throw new IllegalArgumentException("Topic was not found in this workspace");
        Progress progress = progress(courseId, topicId);
        DifficultyLadder.State state = state(courseId, topicId);
        if (state == null) {
            CognitiveLevel start = DifficultyLadder.startingLevel(progress.effectiveMastery(), progress.evidenceCount());
            state = DifficultyLadder.State.fresh(start);
            jdbc.update("INSERT INTO topic_ladder_state(course_id,topic_id,level,last_action,last_reason) VALUES(?,?,?,?,?) ON CONFLICT(course_id,topic_id) DO NOTHING",
                    courseId, topicId, start.rank(), "HOLD", "Entering at " + start.label() + " based on the evidence recorded so far.");
        }
        Remediation remediation = remediation(courseId, topicId);
        CognitiveLevel level = state.level();
        String reason = state.diagnosticPending()
                ? "Diagnostic at " + level.label() + " to locate what is actually missing before returning to "
                    + (state.returnLevel() == null ? level.up().label() : state.returnLevel().label()) + "."
                : lastReason(courseId, topicId, level);
        return new Plan(topicId, topic, level, level.difficultyFor(progress.effectiveMastery()), state.diagnosticPending(),
                remediation == null ? null : remediation.topicId(), remediation == null ? null : remediation.topic(), reason,
                state.attempts(), state.consecutiveSuccess(), state.consecutiveFailure());
    }

    /**
     * Advances the ladder with the outcome of one graded attempt.
     *
     * <p>The whole read-decide-write is one transaction with the state row locked, so two concurrent
     * completions of one step cannot both count the same attempt. The decision is also guarded against the
     * remediation loop: a diagnostic failure proposes the weakest prerequisite, but if the previous recorded
     * action for this topic was already remediation of the same prerequisite and nothing has changed, issuing
     * it again would cycle DIAGNOSE → REMEDIATE forever against prerequisite mastery this path never regrades.
     * The repeat proposal is held at the current level instead, naming the prerequisite it is waiting on.
     */
    @org.springframework.transaction.annotation.Transactional
    public Advance record(UUID courseId, UUID topicId, double score, int supportLevelUsed) {
        if (topicId == null) return null;
        Plan before = plan(courseId, topicId);
        DifficultyLadder.State state = state(courseId, topicId);
        if (state == null) state = DifficultyLadder.State.fresh(before.level());
        Progress progress = progress(courseId, topicId);
        Remediation remediation = remediation(courseId, topicId);
        DifficultyLadder.Context context = new DifficultyLadder.Context(progress.effectiveMastery(), ceiling(courseId, topicId), remediation != null);
        DifficultyLadder.Decision decision = DifficultyLadder.decide(state, new DifficultyLadder.Attempt(score, supportLevelUsed), context);
        UUID remediationTopicId = decision.action() == LadderAction.REMEDIATE_PREREQUISITE && remediation != null ? remediation.topicId() : null;
        if (decision.action() == LadderAction.REMEDIATE_PREREQUISITE && repeatsRemediation(courseId, topicId, remediationTopicId)) {
            decision = new DifficultyLadder.Decision(LadderAction.HOLD, state.level(), state.returnLevel(), state.consecutiveSuccess(),
                    state.consecutiveFailure(), state.diagnosticPending(), decision.difficulty(),
                    "Prerequisite repair for " + (remediation == null ? "the weakest prerequisite" : remediation.topic())
                            + " is already in progress — holding here until it is graded and its mastery moves.");
            remediationTopicId = null;
        }
        jdbc.update("INSERT INTO topic_ladder_state(course_id,topic_id,level,return_level,consecutive_success,consecutive_failure,attempts,diagnostic_pending,remediation_topic_id,last_action,last_reason,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NOW()) ON CONFLICT(course_id,topic_id) DO UPDATE SET level=EXCLUDED.level,return_level=EXCLUDED.return_level,consecutive_success=EXCLUDED.consecutive_success,consecutive_failure=EXCLUDED.consecutive_failure,attempts=EXCLUDED.attempts,diagnostic_pending=EXCLUDED.diagnostic_pending,remediation_topic_id=EXCLUDED.remediation_topic_id,last_action=EXCLUDED.last_action,last_reason=EXCLUDED.last_reason,updated_at=NOW()",
                courseId, topicId, decision.level().rank(), decision.returnLevel() == null ? null : decision.returnLevel().rank(),
                decision.consecutiveSuccess(), decision.consecutiveFailure(), state.attempts() + 1, decision.diagnosticPending(),
                remediationTopicId, decision.action().name(), decision.reason());
        jdbc.update("INSERT INTO learning_events(id,course_id,topic_id,event_type,payload) VALUES(?,?,?,?,CAST(? AS jsonb))", UUID.randomUUID(), courseId, topicId,
                "DIFFICULTY_LADDER_" + decision.action().name(), payload(decision, state.level(), supportLevelUsed, score));
        return new Advance(decision.action(), state.level(), decision.level(), decision.difficulty(), decision.diagnosticPending(),
                remediationTopicId, remediationTopicId == null ? null : remediation.topic(), decision.reason());
    }

    /**
     * Whether proposing this remediation again would only repeat the previous one: the same
     * prerequisite was already selected by the most recent recorded action and remains unregressed.
     */
    private boolean repeatsRemediation(UUID courseId, UUID topicId, UUID candidate) {
        if (candidate == null) return false;
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS(SELECT 1 FROM topic_ladder_state WHERE course_id=? AND topic_id=? AND last_action='REMEDIATE_PREREQUISITE' AND remediation_topic_id=?)",
                Boolean.class, courseId, topicId, candidate));
    }

    public List<Snapshot> list(UUID courseId) {
        return jdbc.query("SELECT l.topic_id,t.canonical_name,l.level,l.return_level,l.consecutive_success,l.consecutive_failure,l.attempts,l.diagnostic_pending,r.canonical_name,l.last_action,l.last_reason,l.updated_at FROM topic_ladder_state l JOIN topics t ON t.id=l.topic_id LEFT JOIN topics r ON r.id=l.remediation_topic_id WHERE l.course_id=? ORDER BY l.level DESC,t.canonical_name",
                (rs, row) -> new Snapshot(rs.getObject(1, UUID.class), rs.getString(2), CognitiveLevel.ofRank(rs.getInt(3)),
                        rs.getObject(4, Integer.class) == null ? null : CognitiveLevel.ofRank(rs.getInt(4)), rs.getInt(5), rs.getInt(6), rs.getInt(7),
                        rs.getBoolean(8), rs.getString(9), rs.getString(10), rs.getString(11), rs.getTimestamp(12)), courseId);
    }

    private String topic(UUID courseId, UUID topicId) {
        return jdbc.query("SELECT canonical_name FROM topics WHERE id=? AND course_id=?",
                rs -> rs.next() ? rs.getString(1) : null, topicId, courseId);
    }

    private DifficultyLadder.State state(UUID courseId, UUID topicId) {
        return jdbc.query("SELECT level,return_level,consecutive_success,consecutive_failure,attempts,diagnostic_pending FROM topic_ladder_state WHERE course_id=? AND topic_id=? FOR UPDATE",
                rs -> rs.next() ? new DifficultyLadder.State(CognitiveLevel.ofRank(rs.getInt(1)),
                        rs.getObject(2, Integer.class) == null ? null : CognitiveLevel.ofRank(rs.getInt(2)),
                        rs.getInt(3), rs.getInt(4), rs.getInt(5), rs.getBoolean(6)) : null, courseId, topicId);
    }

    private Progress progress(UUID courseId, UUID topicId) {
        Progress progress = jdbc.query("SELECT COALESCE(measured_mastery,mastery,0),COALESCE(evidence_count,0),COALESCE(last_studied_at,last_assessed_at,updated_at),COALESCE(stability_days,0) FROM student_topic_state WHERE course_id=? AND topic_id=?",
                rs -> {
                    if (!rs.next()) return null;
                    Timestamp anchor = rs.getTimestamp(3);
                    double retention = RetentionModel.retention(anchor == null ? null : anchor.toInstant(), Instant.now(), rs.getDouble(4));
                    return new Progress(rs.getDouble(1) * retention, rs.getInt(2));
                }, courseId, topicId);
        return progress == null ? new Progress(0, 0) : progress;
    }

    /**
     * The weakest recorded prerequisite of this topic, when it is weak enough to be worth repairing.
     *
     * <p>Read through {@code topic_prerequisites}, so a topic whose base the material describes as something it
     * builds on is remediated the same as one behind a stated requirement. The view holds the direction rule.
     */
    private Remediation remediation(UUID courseId, UUID topicId) {
        return jdbc.query("SELECT t.id,t.canonical_name,COALESCE(s.measured_mastery,s.mastery,0) FROM topic_prerequisites e JOIN topics t ON t.id=e.prerequisite_topic_id LEFT JOIN student_topic_state s ON s.topic_id=t.id AND s.course_id=e.course_id WHERE e.course_id=? AND e.dependent_topic_id=? ORDER BY COALESCE(s.measured_mastery,s.mastery,0),t.canonical_name LIMIT 1",
                rs -> rs.next() && rs.getDouble(3) < WEAK_PREREQUISITE ? new Remediation(rs.getObject(1, UUID.class), rs.getString(2), rs.getDouble(3)) : null,
                courseId, topicId);
    }

    /** A topic is never pushed past the level its curriculum asks for. */
    private CognitiveLevel ceiling(UUID courseId, UUID topicId) {
        Integer target = jdbc.query("SELECT MAX(target_level) FROM curriculum_lessons WHERE course_id=? AND topic_id=?",
                rs -> rs.next() ? rs.getObject(1, Integer.class) : null, courseId, topicId);
        return target == null ? CognitiveLevel.highest() : CognitiveLevel.ofRank(target);
    }

    private String lastReason(UUID courseId, UUID topicId, CognitiveLevel level) {
        String stored = jdbc.query("SELECT last_reason FROM topic_ladder_state WHERE course_id=? AND topic_id=?", rs -> rs.next() ? rs.getString(1) : null, courseId, topicId);
        return stored == null || stored.isBlank() ? "Working at " + level.label() + ": " + level.demand() : stored;
    }

    private String payload(DifficultyLadder.Decision decision, CognitiveLevel from, int supportLevelUsed, double score) {
        try {
            return mapper.writeValueAsString(java.util.Map.of("action", decision.action().name(), "fromLevel", from.rank(), "toLevel", decision.level().rank(),
                    "score", Math.max(0, Math.min(1, score)), "supportLevelUsed", Math.max(0, supportLevelUsed), "reason", decision.reason()));
        } catch (Exception ignored) { return "{}"; }
    }

    private record Progress(double effectiveMastery, int evidenceCount) {}
    private record Remediation(UUID topicId, String topic, double mastery) {}

    public record Plan(UUID topicId, String topic, CognitiveLevel level, double difficulty, boolean diagnostic, UUID remediationTopicId,
                       String remediationTopic, String reason, int attempts, int consecutiveSuccess, int consecutiveFailure) {}
    public record Advance(LadderAction action, CognitiveLevel previousLevel, CognitiveLevel level, double difficulty, boolean diagnostic,
                          UUID remediationTopicId, String remediationTopic, String reason) {}
    public record Snapshot(UUID topicId, String topic, CognitiveLevel level, CognitiveLevel returnLevel, int consecutiveSuccess,
                           int consecutiveFailure, int attempts, boolean diagnosticPending, String remediationTopic, String lastAction,
                           String lastReason, Timestamp updatedAt) {}
}
