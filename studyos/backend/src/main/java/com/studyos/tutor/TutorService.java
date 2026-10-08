package com.studyos.tutor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.adaptive.CognitiveLadderService;
import com.studyos.adaptive.CognitiveLevel;
import com.studyos.curriculum.CurriculumService;
import com.studyos.learner.LearnerProfileService;
import com.studyos.mastery.RetentionModel;
import com.studyos.prediction.PredictionService;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Tutor mode: the single screen that answers "what should I do right now, for how long, and what
 * will it get me". It reads the curriculum frontier, the cognitive ladder, live mastery and the
 * readiness forecast, and turns them into one ordered session the student can simply start.
 *
 * <p>Every step is derived from recorded evidence about this workspace, so the same code produces a
 * session for a chemistry course, a law course or a self-directed Spring Boot goal.
 */
@Service
public class TutorService {
    /** Session length used when the caller does not say how long they have. */
    private static final int DEFAULT_MINUTES = 60;
    private static final int MAX_FOCUS_TOPICS = 6;

    private final JdbcTemplate jdbc;
    private final CurriculumService curricula;
    private final CognitiveLadderService ladder;
    private final PredictionService predictions;
    private final LearnerProfileService profiles;
    private final ObjectMapper mapper;

    public TutorService(JdbcTemplate jdbc, CurriculumService curricula, CognitiveLadderService ladder,
                        PredictionService predictions, LearnerProfileService profiles, ObjectMapper mapper) {
        this.jdbc = jdbc; this.curricula = curricula; this.ladder = ladder; this.predictions = predictions;
        this.profiles = profiles; this.mapper = mapper;
    }

    /** Today's proposed session, without saving anything. Safe to call as often as the UI likes. */
    public Today today(UUID workspaceId, Integer minutes) {
        Workspace workspace = workspace(workspaceId);
        int available = minutes == null || minutes <= 0 ? DEFAULT_MINUTES : minutes;
        PredictionService.Forecast forecast = predictions.forecast(workspaceId);
        List<TutorSessionPlanner.Focus> focus = focus(workspaceId);
        TutorSessionPlanner.Session planned = TutorSessionPlanner.plan(new TutorSessionPlanner.Request(
                focus, available, forecast.readiness(), relevanceWeight(workspaceId), TutorSessionPlanner.Settings.DEFAULTS));
        UUID activeId = jdbc.query("SELECT id FROM tutor_sessions WHERE course_id=? AND status IN ('PLANNED','ACTIVE') ORDER BY created_at DESC LIMIT 1",
                rs -> rs.next() ? rs.getObject(1, UUID.class) : null, workspaceId);
        return new Today(workspaceId, workspace.title(), LocalDate.now(), workspace.deadline(), daysUntil(workspace.deadline()),
                available, planned.totalMinutes(), round(planned.readinessBefore()), round(planned.readinessProjected()),
                steps(planned.steps()), focus.isEmpty() ? emptyReason(workspaceId) : null, activeId);
    }

    /** Saves today's plan as a session the student can work through step by step. */
    public Session start(UUID workspaceId, Integer minutes) {
        Today today = today(workspaceId, minutes);
        if (today.steps().isEmpty()) throw new com.studyos.WorkspaceNotReadyException(today.blockedReason() == null
                ? "StudyOS has nothing to schedule for this workspace yet" : today.blockedReason());
        UUID sessionId = UUID.randomUUID();
        jdbc.update("INSERT INTO tutor_sessions(id,course_id,plan_date,status,total_minutes,readiness_before,readiness_projected,summary) VALUES(?,?,?,?,?,?,?,CAST(? AS jsonb))",
                sessionId, workspaceId, LocalDate.now(), "PLANNED", today.totalMinutes(), today.readinessBefore(), today.readinessProjected(),
                json(Map.of("requestedMinutes", today.availableMinutes(), "steps", today.steps().size())));
        for (Step step : today.steps())
            jdbc.update("INSERT INTO tutor_session_steps(id,session_id,course_id,ordinal,kind,topic_id,lesson_id,title,why,minutes,target_level,difficulty,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    UUID.randomUUID(), sessionId, workspaceId, step.ordinal(), step.kind().name(), step.topicId(), step.lessonId(),
                    trim(step.title(), 500), step.why(), step.minutes(), step.targetLevel(), step.difficulty(), "PENDING");
        event(workspaceId, null, "TUTOR_SESSION_PLANNED", Map.of("sessionId", sessionId, "steps", today.steps().size(), "minutes", today.totalMinutes()));
        return session(workspaceId, sessionId);
    }

    public Session session(UUID workspaceId, UUID sessionId) {
        Session session = jdbc.query("SELECT id,plan_date,status,total_minutes,readiness_before,readiness_projected,readiness_after,learning_session_id,created_at,started_at,completed_at FROM tutor_sessions WHERE id=? AND course_id=?",
                rs -> rs.next() ? new Session(rs.getObject(1, UUID.class), workspaceId, rs.getObject(2, LocalDate.class), rs.getString(3), rs.getInt(4),
                        rs.getObject(5, Double.class), rs.getObject(6, Double.class), rs.getObject(7, Double.class), rs.getObject(8, UUID.class),
                        rs.getTimestamp(9), rs.getTimestamp(10), rs.getTimestamp(11), List.of(), null) : null, sessionId, workspaceId);
        if (session == null) throw new IllegalArgumentException("Tutor session was not found");
        List<SessionStep> steps = jdbc.query("SELECT s.id,s.ordinal,s.kind,s.topic_id,t.canonical_name,s.lesson_id,s.title,s.why,s.minutes,s.target_level,s.difficulty,s.status,s.item_id,s.score,s.started_at,s.completed_at FROM tutor_session_steps s LEFT JOIN topics t ON t.id=s.topic_id WHERE s.session_id=? ORDER BY s.ordinal",
                (rs, row) -> {
                    TutorStepKind kind = TutorStepKind.of(rs.getString(3));
                    return new SessionStep(rs.getObject(1, UUID.class), rs.getInt(2), kind, kind.label(), rs.getObject(4, UUID.class), rs.getString(5),
                            rs.getObject(6, UUID.class), rs.getString(7), rs.getString(8), rs.getInt(9), rs.getInt(10),
                            CognitiveLevel.ofRank(rs.getInt(10)).label(), rs.getDouble(11), rs.getString(12),
                            kind.activityKind() == null ? null : kind.activityKind().name(), kind.supportAllowed(),
                            rs.getObject(13, UUID.class), rs.getObject(14, Double.class), rs.getTimestamp(15), rs.getTimestamp(16));
                }, sessionId);
        SessionStep current = steps.stream().filter(step -> "PENDING".equals(step.status()) || "ACTIVE".equals(step.status())).findFirst().orElse(null);
        return new Session(session.id(), workspaceId, session.planDate(), session.status(), session.totalMinutes(), session.readinessBefore(),
                session.readinessProjected(), session.readinessAfter(), session.learningSessionId(), session.createdAt(), session.startedAt(),
                session.completedAt(), steps, current);
    }

    public List<Session> list(UUID workspaceId) {
        List<UUID> ids = jdbc.queryForList("SELECT id FROM tutor_sessions WHERE course_id=? ORDER BY plan_date DESC,created_at DESC LIMIT 30", UUID.class, workspaceId);
        return ids.stream().map(id -> session(workspaceId, id)).toList();
    }

    /** Marks a step finished and hands back the session with the next step already selected. */
    public Session advance(UUID workspaceId, UUID sessionId, int ordinal, Double score, Integer actualMinutes, boolean skipped) {
        Session session = session(workspaceId, sessionId);
        SessionStep step = session.steps().stream().filter(candidate -> candidate.ordinal() == ordinal).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Step " + ordinal + " was not found in this session"));
        // Advancing a finished step changes nothing: the evidence it carried was recorded once, when it
        // finished, and a repeated call must not grade the same attempt into the ladder a second time.
        if ("COMPLETED".equals(step.status()) || "SKIPPED".equals(step.status())) return session;
        if ("PLANNED".equals(session.status()))
            jdbc.update("UPDATE tutor_sessions SET status='ACTIVE',started_at=COALESCE(started_at,NOW()) WHERE id=?", sessionId);
        jdbc.update("UPDATE tutor_session_steps SET status=?,score=?,minutes=COALESCE(?,minutes),started_at=COALESCE(started_at,NOW()),completed_at=NOW() WHERE id=?",
                skipped ? "SKIPPED" : "COMPLETED", score, actualMinutes, step.id());
        // Steps carrying an assessment item were already graded through the quiz, which recorded the
        // attempt, the mastery update and the ladder move at submit time. Recording again here would count
        // one answer as two attempts and promote after a single real success.
        if (!skipped && score != null && step.topicId() != null && step.kind().graded() && step.itemId() == null)
            ladder.record(workspaceId, step.topicId(), Math.max(0, Math.min(1, score)), 0);
        if (!skipped && score != null) adaptNextSteps(workspaceId, session, step, score);
        event(workspaceId, step.topicId(), skipped ? "TUTOR_STEP_SKIPPED" : "TUTOR_STEP_COMPLETED",
                Map.of("sessionId", sessionId, "ordinal", ordinal, "kind", step.kind().name(), "score", score == null ? -1 : score));
        Session updated = session(workspaceId, sessionId);
        return updated.current() == null ? complete(workspaceId, sessionId) : updated;
    }

    /** Closes the session and records where readiness actually landed, next to where it was projected. */
    public Session complete(UUID workspaceId, UUID sessionId) {
        Session session = session(workspaceId, sessionId);
        if ("COMPLETED".equals(session.status())) return session;
        double after = predictions.forecast(workspaceId).readiness();
        int worked = session.steps().stream().filter(step -> "COMPLETED".equals(step.status())).mapToInt(SessionStep::minutes).sum();
        jdbc.update("UPDATE tutor_sessions SET status='COMPLETED',completed_at=NOW(),readiness_after=?,summary=CAST(? AS jsonb) WHERE id=?",
                after, json(Map.of("completedSteps", session.steps().stream().filter(step -> "COMPLETED".equals(step.status())).count(),
                        "skippedSteps", session.steps().stream().filter(step -> "SKIPPED".equals(step.status())).count(),
                        "workedMinutes", worked, "readinessProjected", session.readinessProjected() == null ? 0 : session.readinessProjected(),
                        "readinessAfter", after)), sessionId);
        event(workspaceId, null, "TUTOR_SESSION_COMPLETED", Map.of("sessionId", sessionId, "workedMinutes", worked, "readinessAfter", after));
        profiles.refresh(workspaceId);
        return session(workspaceId, sessionId);
    }

    // ---- focus selection --------------------------------------------------------------------

    /**
     * What this workspace should work on, in order. The curriculum frontier leads when there is one,
     * because it is the only source that knows what is unlocked; otherwise the ranked topic risks do.
     * Due reviews are folded in either way so nothing already learned is quietly forgotten.
     */
    private List<TutorSessionPlanner.Focus> focus(UUID workspaceId) {
        Map<UUID, Signal> signals = signals(workspaceId);
        List<TutorSessionPlanner.Focus> focus = new ArrayList<>();
        Set<UUID> used = new LinkedHashSet<>();
        CurriculumService.Curriculum curriculum = curricula.active(workspaceId);
        if (curriculum != null) {
            CurriculumService.Frontier frontier = curricula.frontier(workspaceId);
            List<CurriculumService.Lesson> lessons = new ArrayList<>();
            if (frontier.next() != null) lessons.add(frontier.next());
            frontier.criticalGaps().forEach(lessons::add);
            frontier.ready().forEach(lessons::add);
            for (CurriculumService.Lesson lesson : lessons) {
                if (focus.size() >= MAX_FOCUS_TOPICS) break;
                UUID key = lesson.topicId() == null ? lesson.id() : lesson.topicId();
                if (!used.add(key)) continue;
                focus.add(focusOf(workspaceId, lesson.topicId(), lesson.id(), lesson.title(), lesson.effectiveMastery(),
                        lesson.targetLevel(), signals.get(lesson.topicId())));
            }
        }
        for (Signal signal : signals.values()) {
            if (focus.size() >= MAX_FOCUS_TOPICS) break;
            if (!signal.dueOrRisky() || !used.add(signal.topicId())) continue;
            focus.add(focusOf(workspaceId, signal.topicId(), null, signal.name(), signal.effectiveMastery(), 0, signal));
        }
        return focus;
    }

    private TutorSessionPlanner.Focus focusOf(UUID workspaceId, UUID topicId, UUID lessonId, String title, double effectiveMastery,
                                              int targetLevel, Signal signal) {
        CognitiveLadderService.Plan plan = topicId == null ? null : ladder.plan(workspaceId, topicId);
        int current = plan == null ? CognitiveLevel.ofDifficulty(effectiveMastery).rank() : plan.level().rank();
        int target = targetLevel > 0 ? targetLevel : Math.max(current, CognitiveLevel.L4_ANALYZE.rank());
        Double confidence = jdbc.query("SELECT confidence FROM student_topic_state WHERE course_id=? AND topic_id=?",
                rs -> rs.next() ? rs.getDouble(1) : null, workspaceId, topicId);
        return new TutorSessionPlanner.Focus(topicId, lessonId, title, effectiveMastery,
                signal == null ? .5 : signal.relevance(), current, target,
                plan != null && plan.diagnostic(), plan == null ? null : plan.remediationTopicId(),
                plan == null ? null : plan.remediationTopic(), signal != null && signal.reviewDue(), confidence);
    }

    /** Live per-topic state: mastery decayed by retention, exam relevance, open misconceptions, and whether review is due. */
    private Map<UUID, Signal> signals(UUID workspaceId) {
        Instant now = Instant.now();
        Map<UUID, Signal> signals = new LinkedHashMap<>();
        jdbc.query("SELECT t.id,t.canonical_name,COALESCE(s.measured_mastery,s.mastery,0),COALESCE(s.last_studied_at,s.last_assessed_at,s.updated_at),s.review_due_at,COALESCE(es.relevance,0),COALESCE(s.evidence_count,0),COALESCE(s.stability_days,0),COALESCE((SELECT MAX(m.severity) FROM misconceptions m WHERE m.course_id=t.course_id AND m.topic_id=t.id AND m.status<>'RESOLVED'),0) FROM topics t LEFT JOIN student_topic_state s ON s.topic_id=t.id AND s.course_id=t.course_id LEFT JOIN exam_topic_signals es ON es.topic_id=t.id AND es.course_id=t.course_id WHERE t.course_id=? ORDER BY COALESCE(es.relevance,0) DESC,t.canonical_name",
                rs -> {
                    Timestamp anchor = rs.getTimestamp(4);
                    Timestamp due = rs.getTimestamp(5);
                    double effective = rs.getDouble(3) * RetentionModel.retention(anchor == null ? null : anchor.toInstant(), now, rs.getDouble(8));
                    double relevance = Math.max(rs.getDouble(6), Math.min(.9, rs.getDouble(9)));
                    signals.put(rs.getObject(1, UUID.class), new Signal(rs.getObject(1, UUID.class), rs.getString(2), effective,
                            relevance, due != null && !due.toInstant().isAfter(now), rs.getInt(7), rs.getDouble(9)));
                }, workspaceId);
        return signals;
    }

    private double relevanceWeight(UUID workspaceId) {
        Double total = jdbc.query("SELECT SUM(GREATEST(.05,COALESCE(es.relevance,0))) FROM topics t LEFT JOIN exam_topic_signals es ON es.topic_id=t.id AND es.course_id=t.course_id WHERE t.course_id=?",
                rs -> rs.next() ? rs.getObject(1, Double.class) : null, workspaceId);
        return total == null || total <= 0 ? 1 : total;
    }

    private String emptyReason(UUID workspaceId) {
        Integer topics = jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE course_id=?", Integer.class, workspaceId);
        if (topics == null || topics == 0) return "Upload course material or set a learning goal so StudyOS knows what to teach";
        return "Everything StudyOS knows about is already understood — add material or raise the target level";
    }

    private List<Step> steps(List<TutorSessionPlanner.Step> planned) {
        return planned.stream().map(step -> new Step(step.ordinal(), step.kind(), step.kind().label(), step.topicId(), step.lessonId(),
                step.title(), step.why(), step.minutes(), step.targetLevel(), CognitiveLevel.ofRank(step.targetLevel()).label(),
                round(step.difficulty()), step.kind().activityKind() == null ? null : step.kind().activityKind().name(),
                step.kind().supportAllowed())).toList();
    }

    private Workspace workspace(UUID workspaceId) {
        Workspace workspace = jdbc.query("SELECT name,COALESCE(exam_date,target_date) FROM courses WHERE id=?",
                rs -> rs.next() ? new Workspace(rs.getString(1), rs.getObject(2, LocalDate.class)) : null, workspaceId);
        if (workspace == null) throw new IllegalArgumentException("Workspace was not found");
        return workspace;
    }

    private Long daysUntil(LocalDate deadline) { return deadline == null ? null : ChronoUnit.DAYS.between(LocalDate.now(), deadline); }
    /**
     * In-session adaptation: the plan is a starting point, not a contract. A bad failure downgrades
     * the next same-topic step instead of walking the learner into a harder one; a strong unaided
     * success makes a redundant guided step give way. Only affected future steps change, and the
     * reason is persisted on the step and in the event trail.
     */
    private void adaptNextSteps(UUID workspaceId, Session session, SessionStep finished, double score) {
        SessionStep next = session.steps().stream()
                .filter(candidate -> "PENDING".equals(candidate.status()) && candidate.ordinal() > finished.ordinal())
                .findFirst().orElse(null);
        if (next == null || finished.topicId() == null || !finished.topicId().equals(next.topicId())) return;
        if (score < 0.35 && (next.kind() == TutorStepKind.EXAM_STYLE || next.targetLevel() > finished.targetLevel())) {
            String adaptedWhy = "Adapted after the previous step scored " + Math.round(score * 100)
                    + "%: practice at the current level first, then come back to the harder form.";
            jdbc.update("UPDATE tutor_session_steps SET kind=?,target_level=?,difficulty=GREATEST(0.1,difficulty-0.2),why=? WHERE id=? AND status='PENDING'",
                    TutorStepKind.PRACTICE.name(), finished.targetLevel(), adaptedWhy, next.id());
            event(workspaceId, finished.topicId(), "TUTOR_SESSION_ADAPTED", Map.of("sessionId", session.id(), "reason", "FAILURE_REMEDIATION", "score", score));
        } else if (score >= 0.85 && finished.kind() == TutorStepKind.GUIDED_PRACTICE && next.kind() == TutorStepKind.GUIDED_PRACTICE) {
            String skipWhy = "Skipped by adaptation: the previous guided step was answered at " + Math.round(score * 100)
                    + "% without needing this one.";
            jdbc.update("UPDATE tutor_session_steps SET status='SKIPPED',why=? WHERE id=? AND status='PENDING'", skipWhy, next.id());
            event(workspaceId, finished.topicId(), "TUTOR_SESSION_ADAPTED", Map.of("sessionId", session.id(), "reason", "REDUNDANT_GUIDED_STEP", "score", score));
        }
    }

    private void event(UUID workspaceId, UUID topicId, String type, Map<String, Object> payload) {
        jdbc.update("INSERT INTO learning_events(id,course_id,topic_id,event_type,payload) VALUES(?,?,?,?,CAST(? AS jsonb))",
                UUID.randomUUID(), workspaceId, topicId, type, json(payload));
    }
    private String json(Object value) { try { return mapper.writeValueAsString(value); } catch (Exception ignored) { return "{}"; } }
    private String trim(String value, int max) { String clean = Objects.toString(value, ""); return clean.length() <= max ? clean : clean.substring(0, max); }
    private double round(double value) { return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000.0; }

    private record Workspace(String title, LocalDate deadline) {}
    private record Signal(UUID topicId, String name, double effectiveMastery, double relevance, boolean reviewDue,
                          int evidenceCount, double misconceptionSeverity) {
        /** Worth scheduling on its own: review due, weak with evidence, or carrying an open misconception. */
        boolean dueOrRisky() { return reviewDue || misconceptionSeverity > 0 || (evidenceCount > 0 && effectiveMastery < TutorSessionPlanner.MASTERY_BAR); }
    }

    public record Step(int ordinal, TutorStepKind kind, String kindLabel, UUID topicId, UUID lessonId, String title, String why,
                       int minutes, int targetLevel, String targetLevelLabel, double difficulty, String activityKind, boolean supportAllowed) {}
    public record Today(UUID workspaceId, String workspace, LocalDate date, LocalDate deadline, Long daysUntilDeadline,
                        int availableMinutes, int totalMinutes, double readinessBefore, double readinessProjected,
                        List<Step> steps, String blockedReason, UUID activeSessionId) {}
    public record SessionStep(UUID id, int ordinal, TutorStepKind kind, String kindLabel, UUID topicId, String topic, UUID lessonId,
                              String title, String why, int minutes, int targetLevel, String targetLevelLabel, double difficulty,
                              String status, String activityKind, boolean supportAllowed, UUID itemId, Double score,
                              Timestamp startedAt, Timestamp completedAt) {}
    public record Session(UUID id, UUID workspaceId, LocalDate planDate, String status, int totalMinutes, Double readinessBefore,
                          Double readinessProjected, Double readinessAfter, UUID learningSessionId, Timestamp createdAt,
                          Timestamp startedAt, Timestamp completedAt, List<SessionStep> steps, SessionStep current) {}
}
