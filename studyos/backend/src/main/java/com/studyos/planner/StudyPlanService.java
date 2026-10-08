package com.studyos.planner;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.mastery.RetentionModel;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class StudyPlanService {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final PlannerProperties properties;

    public StudyPlanService(JdbcTemplate jdbc, ObjectMapper mapper, PlannerProperties properties) {
        this.jdbc = jdbc; this.mapper = mapper; this.properties = properties;
    }

    public Plan generate(UUID courseId, LocalDate date, int minutes) {
        int available = Math.max(properties.getMinimumTaskMinutes(), Math.min(480, minutes));
        UUID requestedId = UUID.randomUUID();
        jdbc.update("INSERT INTO study_plans(id,course_id,plan_date,available_minutes,readiness) VALUES(?,?,?,?,?) ON CONFLICT(course_id,plan_date) DO UPDATE SET available_minutes=EXCLUDED.available_minutes,readiness=0", requestedId, courseId, date, available, 0.0);
        UUID planId = jdbc.queryForObject("SELECT id FROM study_plans WHERE course_id=? AND plan_date=?", UUID.class, courseId, date);
        jdbc.update("DELETE FROM study_tasks WHERE plan_id=?", planId);
        PlanningContext context = planningContext(courseId, date);
        jdbc.update("UPDATE study_plans SET readiness=? WHERE id=?", readiness(context.candidates()), planId);
        buildPending(planId, context, available, 0);
        return current(courseId, date);
    }

    public Plan current(UUID courseId, LocalDate date) {
        List<PlanRow> plans = jdbc.query("SELECT id,plan_date,available_minutes,readiness FROM study_plans WHERE course_id=? AND plan_date=?", (rs,row) -> new PlanRow(rs.getObject("id",UUID.class),rs.getObject("plan_date",LocalDate.class),rs.getInt("available_minutes"),rs.getDouble("readiness")), courseId, date);
        if (plans.isEmpty()) return new Plan(null, date, 0, 0, List.of());
        PlanRow plan = plans.get(0);
        List<Task> tasks = jdbc.query("SELECT id,topic_id,title,reason,duration_minutes,priority,status,action,reason_codes::text,actual_minutes,completed,score,student_feedback,source_references::text,expected_outcome,difficulty,recommended_activity FROM study_tasks WHERE plan_id=? ORDER BY ordinal", (rs,row) -> task(rs), plan.id());
        return new Plan(plan.id(), plan.date(), plan.availableMinutes(), plan.readiness(), tasks);
    }

    public TaskDetails details(UUID taskId, UUID expectedCourseId) {
        TaskDetails details=jdbc.query("SELECT t.id,p.course_id,t.topic_id,tp.canonical_name,t.title,t.reason,t.duration_minutes,t.priority,t.status,t.action,t.reason_codes::text,t.source_references::text,t.expected_outcome,t.difficulty,t.recommended_activity FROM study_tasks t JOIN study_plans p ON p.id=t.plan_id LEFT JOIN topics tp ON tp.id=t.topic_id WHERE t.id=?",rs->{if(!rs.next())return null;return new TaskDetails(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getObject(3,UUID.class),rs.getString(4),rs.getString(5),rs.getString(6),rs.getInt(7),rs.getDouble(8),rs.getString(9),rs.getString(10),parseCodes(rs.getString(11)),parseSourceReferences(rs.getString(12)),rs.getString(13),rs.getObject(14,Double.class),rs.getString(15));},taskId);
        if(details==null||(expectedCourseId!=null&&!expectedCourseId.equals(details.workspaceId())))throw new IllegalArgumentException("Study task was not found");
        return details;
    }

    public Completion complete(UUID taskId, Integer actualMinutes, boolean completed, Double score, Double difficultyReported, String feedback) {
        TaskRow task = jdbc.query("SELECT t.id,t.plan_id,t.topic_id,p.course_id,p.plan_date,p.available_minutes FROM study_tasks t JOIN study_plans p ON p.id=t.plan_id WHERE t.id=?", rs -> {
            if (!rs.next()) return null;
            return new TaskRow(rs.getObject("id",UUID.class), rs.getObject("plan_id",UUID.class), rs.getObject("topic_id",UUID.class), rs.getObject("course_id",UUID.class), rs.getObject("plan_date",LocalDate.class), rs.getInt("available_minutes"));
        }, taskId);
        if (task == null) throw new IllegalArgumentException("Study task was not found");
        String status = completed ? "COMPLETED" : "SKIPPED";
        jdbc.update("UPDATE study_tasks SET status=?,actual_minutes=?,completed=?,score=?,student_feedback=?,completed_at=CASE WHEN ? THEN NOW() ELSE NULL END WHERE id=?", status, actualMinutes, completed, score, feedback, completed, taskId);
        // A client-posted score is a self-report, not evidence: mastery moves only through the graded
        // path (submitAnswer / mock exam), which records the attempt, weight and support context. The
        // self-reported figure is kept on the task for the record, but it can never touch
        // student_topic_state — otherwise "I'm done, that went well" would grade itself.
        jdbc.update("INSERT INTO learning_events(id,course_id,topic_id,event_type,payload) VALUES(?,?,?,?,?::jsonb)", UUID.randomUUID(), task.courseId(), task.topicId(), "STUDY_TASK_" + status, taskPayload(taskId, actualMinutes, score, feedback));
        replanPending(task.courseId(), task.planId(), task.planDate(), task.availableMinutes());
        return new Completion(taskId, status, current(task.courseId(), task.planDate()));
    }

    private void replanPending(UUID courseId, UUID planId, LocalDate date, int available) {
        int consumed = jdbc.queryForObject("SELECT COALESCE(SUM(COALESCE(actual_minutes,duration_minutes)),0) FROM study_tasks WHERE plan_id=? AND status IN ('COMPLETED','SKIPPED')", Integer.class, planId);
        jdbc.update("DELETE FROM study_tasks WHERE plan_id=? AND status='PENDING'", planId);
        PlanningContext context = planningContext(courseId, date);
        jdbc.update("UPDATE study_plans SET readiness=? WHERE id=?", readiness(context.candidates()), planId);
        int nextOrdinal = jdbc.queryForObject("SELECT COALESCE(MAX(ordinal)+1,0) FROM study_tasks WHERE plan_id=?", Integer.class, planId);
        buildPending(planId, context, Math.max(0, available - consumed), nextOrdinal);
    }

    private void buildPending(UUID planId, PlanningContext context, int available, int ordinal) {
        List<PrerequisiteSequencer.Node<UUID>> ordered = context.candidates().stream()
                .map(candidate -> new PrerequisiteSequencer.Node<>(candidate.candidate().id(), candidate.candidate().effective())).toList();
        PrerequisiteSequencer.Settings settings = new PrerequisiteSequencer.Settings(properties.getPrerequisiteWeakThreshold(),
                properties.getMaxPrerequisiteDepth(), properties.getMaxInjectedPrerequisites(), properties.getMaxTasks(), properties.getMinimumTaskMinutes());
        List<PrerequisiteSequencer.Selection<UUID>> selected = PrerequisiteSequencer.sequence(ordered, context.prerequisites(), available, settings,
                node -> TimeAllocator.minutesFor(context.byTopic().get(node.id()).priority().action()));
        int nextOrdinal = ordinal;
        for (PrerequisiteSequencer.Selection<UUID> selection : selected) {
            ScoredCandidate candidate = context.byTopic().get(selection.node().id());
            List<String> codes = new ArrayList<>(candidate.priority().reasonCodes());
            if (selection.injectedPrerequisite()) codes.add("UNLOCKS_HIGHER_PRIORITY_TOPIC");
            insertTask(planId, candidate, selection.durationMinutes(), nextOrdinal++, codes);
        }
    }

    private void insertTask(UUID planId, ScoredCandidate candidate, int duration, int ordinal, List<String> codes) {
        String action=candidate.priority().action();
        jdbc.update("INSERT INTO study_tasks(id,plan_id,topic_id,title,reason,duration_minutes,priority,status,ordinal,action,reason_codes,source_references,expected_outcome,difficulty,recommended_activity) VALUES(?,?,?,?,?,?,?,'PENDING',?,?,CAST(? AS jsonb),CAST(? AS jsonb),?,?,?)", UUID.randomUUID(), planId, candidate.candidate().id(), label(action) + " " + candidate.candidate().name(), reason(candidate), duration, candidate.priority().value(), ordinal, action, jsonArray(codes), json(sourceReferences(candidate.candidate().id())), expectedOutcome(action,candidate.candidate().name()), taskDifficulty(candidate), recommendedActivity(action));
    }

    private PlanningContext planningContext(UUID courseId, LocalDate date) {
        LocalDate examDate = jdbc.query("SELECT exam_date FROM courses WHERE id=?", rs -> { if (!rs.next() || rs.getDate(1) == null) return null; return rs.getDate(1).toLocalDate(); }, courseId);
        Instant now = Instant.now();
        List<Candidate> raw = jdbc.query("SELECT t.id,t.canonical_name,COALESCE(s.measured_mastery,s.mastery,0),COALESCE(s.last_studied_at,s.last_assessed_at,s.updated_at),COALESCE(s.confidence,0),COALESCE(es.relevance,0),COALESCE(es.evidence_confidence,0),COALESCE(m.max_severity,0),s.review_due_at,COUNT(DISTINCT ct.chunk_id),COALESCE(f.recent_failure,0),COALESCE(cl.lesson_count,0),COALESCE(s.stability_days,0) FROM topics t LEFT JOIN student_topic_state s ON s.topic_id=t.id AND s.course_id=t.course_id LEFT JOIN exam_topic_signals es ON es.topic_id=t.id AND es.course_id=t.course_id LEFT JOIN (SELECT topic_id,MAX(severity) AS max_severity FROM misconceptions WHERE course_id=? AND status<>'RESOLVED' GROUP BY topic_id) m ON m.topic_id=t.id LEFT JOIN (SELECT topic_id,LEAST(1.0,COUNT(*)/3.0) AS recent_failure FROM learning_events WHERE course_id=? AND event_type='QUIZ_ATTEMPT' AND occurred_at>=NOW()-INTERVAL '14 days' AND COALESCE((payload->>'score')::double precision,1)<.5 GROUP BY topic_id) f ON f.topic_id=t.id LEFT JOIN (SELECT l.topic_id,COUNT(*) AS lesson_count FROM curriculum_lessons l JOIN curriculum_modules mo ON mo.id=l.module_id JOIN curricula cu ON cu.id=mo.curriculum_id WHERE cu.course_id=? AND cu.status='ACTIVE' AND l.topic_id IS NOT NULL GROUP BY l.topic_id) cl ON cl.topic_id=t.id LEFT JOIN chunk_topics ct ON ct.topic_id=t.id WHERE t.course_id=? GROUP BY t.id,t.canonical_name,s.measured_mastery,s.mastery,s.last_studied_at,s.last_assessed_at,s.updated_at,s.confidence,es.relevance,es.evidence_confidence,m.max_severity,s.review_due_at,f.recent_failure,cl.lesson_count,s.stability_days ORDER BY t.canonical_name", (rs,row) -> { Timestamp anchor = rs.getTimestamp(4); return new Candidate(rs.getObject(1,UUID.class),rs.getString(2),rs.getDouble(3),RetentionModel.retention(anchor == null ? null : anchor.toInstant(), now, rs.getDouble(13)),rs.getDouble(5),rs.getDouble(6),rs.getDouble(7),rs.getDouble(8),rs.getTimestamp(9),rs.getLong(10),rs.getDouble(11),rs.getLong(12)); }, courseId, courseId, courseId, courseId).stream().filter(Candidate::grounded).toList();
        Map<UUID, Candidate> candidateById = raw.stream().collect(java.util.stream.Collectors.toMap(Candidate::id, candidate -> candidate, (left,right) -> left, LinkedHashMap::new));
        Map<UUID, List<UUID>> prerequisites = prerequisiteMap(courseId);
        Map<UUID, ScoredCandidate> byTopic = new LinkedHashMap<>();
        for (Candidate candidate : raw) {
            double gap = prerequisiteGap(candidate, candidateById, prerequisites.getOrDefault(candidate.id(), List.of()));
            byTopic.put(candidate.id(), new ScoredCandidate(candidate, priority(candidate, gap, date, examDate), prerequisites.getOrDefault(candidate.id(), List.of())));
        }
        List<ScoredCandidate> ordered = byTopic.values().stream().sorted(Comparator.comparingDouble((ScoredCandidate candidate) -> candidate.priority().value()).reversed().thenComparing(candidate -> candidate.candidate().name())).toList();
        return new PlanningContext(ordered, byTopic, prerequisites);
    }

    /** What each topic rests on, from {@code topic_prerequisites} so extension edges order the plan too. */
    private Map<UUID, List<UUID>> prerequisiteMap(UUID courseId) {
        Map<UUID, List<UUID>> result = new HashMap<>();
        jdbc.query("SELECT prerequisite_topic_id,dependent_topic_id FROM topic_prerequisites WHERE course_id=?", rs -> {
            UUID source = rs.getObject(1, UUID.class); UUID target = rs.getObject(2, UUID.class);
            result.computeIfAbsent(target, ignored -> new ArrayList<>()).add(source);
        }, courseId);
        return result;
    }

    private double prerequisiteGap(Candidate candidate, Map<UUID, Candidate> candidates, List<UUID> prerequisites) {
        if (prerequisites.isEmpty()) return 0;
        return prerequisites.stream().map(candidates::get).filter(Objects::nonNull).mapToDouble(prerequisite -> 1 - prerequisite.effective()).max().orElse(0);
    }

    private double readiness(List<ScoredCandidate> candidates) {
        double total = candidates.stream().mapToDouble(candidate -> Math.max(.05, candidate.candidate().relevance())).sum();
        return total == 0 ? 0 : candidates.stream().mapToDouble(candidate -> candidate.candidate().effective() * Math.max(.05, candidate.candidate().relevance())).sum() / total;
    }

    private Priority priority(Candidate candidate, double prerequisiteGap, LocalDate date, LocalDate examDate) {
        boolean due = candidate.reviewDue() != null && !candidate.reviewDue().toInstant().isAfter(Instant.now());
        long days = examDate == null ? Long.MAX_VALUE : ChronoUnit.DAYS.between(date, examDate);
        PriorityCalculator.Result result = PriorityCalculator.calculate(new PriorityCalculator.Input(candidate.relevance(), candidate.effective(), candidate.retention(), candidate.evidenceConfidence(), candidate.misconception(), candidate.recentFailure(), prerequisiteGap, due, days),
                new PriorityCalculator.Weights(properties.getExamGapWeight(), properties.getReviewUrgencyWeight(), properties.getMisconceptionWeight(), properties.getRecentFailureWeight(), properties.getPrerequisiteGapWeight(), properties.getDeadlineWeight()));
        return new Priority(result.value(), result.action(), result.reasonCodes(), result.examGap(), result.reviewUrgency(), result.misconception(), result.recentFailure(), result.prerequisite(), result.deadline());
    }

    private String label(String action) { return switch (action) { case "REVIEW_MISTAKE" -> "Review mistake:"; case "EXAM_STYLE_TEST" -> "Exam-style test:"; default -> action.substring(0,1) + action.substring(1).toLowerCase(Locale.ROOT) + ":"; }; }
    private String reason(ScoredCandidate candidate) { Priority priority = candidate.priority(); return String.format(Locale.ROOT, "Priority %.0f%% · exam relevance %.0f%% · effective mastery %.0f%% · prerequisite gap %.0f%%", priority.value() * 100, candidate.candidate().relevance() * 100, candidate.candidate().effective() * 100, priority.prerequisite() * 100); }
    private List<SourceReference> sourceReferences(UUID topicId){return jdbc.query("SELECT d.name,c.page_start,c.page_end FROM chunk_topics ct JOIN chunks c ON c.id=ct.chunk_id JOIN documents d ON d.id=c.document_id WHERE ct.topic_id=? ORDER BY ct.relevance DESC,c.ordinal LIMIT 3",(rs,row)->new SourceReference(rs.getString(1),rs.getInt(2),rs.getInt(3)),topicId);}
    private String expectedOutcome(String action,String topic){return switch(action){case "REVIEW","FLASH_REVIEW"->"Recall the core ideas of "+topic+" without looking at the source.";case "EXAM_STYLE_TEST"->"Solve one exam-style "+topic+" problem and justify each step.";case "REVIEW_MISTAKE"->"Correct the recent "+topic+" misconception in a new problem.";default->"Complete one new "+topic+" exercise and explain why the solution works.";};}
    private double taskDifficulty(ScoredCandidate candidate){return Math.max(.25,Math.min(.9,.45+(candidate.candidate().effective()-.5)*.5));}
    private String recommendedActivity(String action){return switch(action){case "REVIEW","FLASH_REVIEW"->"REVIEW";case "EXAM_STYLE_TEST"->"EXERCISE";case "REVIEW_MISTAKE"->"QUIZ";default->"EXERCISE";};}
    private String jsonArray(List<String> values) { return "[" + String.join(",", values.stream().distinct().map(value -> "\"" + value + "\"").toList()) + "]"; }
    private String json(Object value){try{return mapper.writeValueAsString(value);}catch(Exception ignored){return "[]";}}
    private List<String> parseCodes(String value) { try { return mapper.readValue(value == null ? "[]" : value, new TypeReference<List<String>>() {}); } catch (Exception ignored) { return List.of(); } }
    private List<SourceReference> parseSourceReferences(String value){try{return mapper.readValue(value==null?"[]":value,new TypeReference<List<SourceReference>>(){});}catch(Exception ignored){return List.of();}}
    private Task task(java.sql.ResultSet rs)throws java.sql.SQLException{return new Task(rs.getObject("id",UUID.class),rs.getObject("topic_id",UUID.class),rs.getString("title"),rs.getString("reason"),rs.getInt("duration_minutes"),rs.getDouble("priority"),rs.getString("status"),rs.getString("action"),parseCodes(rs.getString("reason_codes")),rs.getObject("actual_minutes",Integer.class),rs.getObject("completed",Boolean.class),rs.getObject("score",Double.class),rs.getString("student_feedback"),parseSourceReferences(rs.getString("source_references")),rs.getString("expected_outcome"),rs.getObject("difficulty",Double.class),rs.getString("recommended_activity"));}
    private String taskPayload(UUID taskId, Integer actualMinutes, Double score, String feedback) { try { return mapper.writeValueAsString(Map.of("taskId", taskId, "actualMinutes", actualMinutes == null ? 0 : actualMinutes, "score", score == null ? 0 : score, "feedback", feedback == null ? "" : feedback)); } catch (Exception ignored) { return "{}"; } }

    /**
     * A topic is plannable when it is anchored in something real: uploaded material that can be
     * cited, or a lesson in the active curriculum. The second case is what makes self-learning
     * workspaces plannable, since they have a curriculum but no documents to cite.
     */
    private record Candidate(UUID id,String name,double measured,double retention,double confidence,double relevance,double evidenceConfidence,double misconception,Timestamp reviewDue,long sourceCount,double recentFailure,long curriculumLessons) {
        double effective() { return Math.max(0, Math.min(1, measured * retention)); }
        boolean grounded() { return sourceCount > 0 || curriculumLessons > 0; }
    }
    private record Priority(double value,String action,List<String> reasonCodes,double examGap,double reviewUrgency,double misconception,double recentFailure,double prerequisite,double deadline) {}
    private record ScoredCandidate(Candidate candidate,Priority priority,List<UUID> prerequisites) {}
    private record PlanningContext(List<ScoredCandidate> candidates,Map<UUID,ScoredCandidate> byTopic,Map<UUID,List<UUID>> prerequisites) {}
    private record PlanRow(UUID id,LocalDate date,int availableMinutes,double readiness) {}
    private record TaskRow(UUID id,UUID planId,UUID topicId,UUID courseId,LocalDate planDate,int availableMinutes) {}
    public record Plan(UUID id,LocalDate date,int availableMinutes,double readiness,List<Task> tasks) {}
    public record Task(UUID taskId,UUID topicId,String title,String reason,int durationMinutes,double priority,String status,String action,List<String> reasonCodes,Integer actualMinutes,Boolean completed,Double score,String studentFeedback,List<SourceReference> sourceReferences,String expectedOutcome,Double difficulty,String recommendedActivity) {}
    public record SourceReference(String document,int pageStart,int pageEnd) {}
    public record TaskDetails(UUID taskId,UUID workspaceId,UUID topicId,String topic,String title,String whyNow,int estimatedMinutes,double priority,String status,String action,List<String> reasonCodes,List<SourceReference> sourceReferences,String expectedOutcome,Double difficulty,String recommendedActivity) {}
    public record Completion(UUID taskId,String status,Plan plan) {}
}
