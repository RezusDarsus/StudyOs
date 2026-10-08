package com.studyos.curriculum;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Reads the live curriculum, mastery and deadline, and hands them to the pure pacing planner.
 * The plan is always computed from current state — a missed week, a fast learner or a failed
 * assessment simply changes the next plan — and completed history is never rewritten because
 * nothing completed is stored as part of the plan.
 */
@Service
public class CoursePacingService {
    private final JdbcTemplate jdbc;

    public CoursePacingService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public CoursePacingPlanner.Plan pace(UUID workspaceId, Integer minutesPerDay, Integer daysPerWeek) {
        Integer safeMinutes = minutesPerDay == null || minutesPerDay <= 0 ? 60 : minutesPerDay;
        Integer safeDays = daysPerWeek == null || daysPerWeek <= 0 ? 5 : daysPerWeek;
        List<CoursePacingPlanner.LessonWork> lessons = lessonWork(workspaceId);
        Integer daysUntil = daysUntilDeadline(workspaceId);
        return CoursePacingPlanner.plan(lessons, daysUntil, safeMinutes, safeDays);
    }

    private Integer daysUntilDeadline(UUID workspaceId) {
        Timestamp deadline = jdbc.query("SELECT COALESCE(exam_date,target_date) FROM courses WHERE id=?",
                rs -> rs.next() ? rs.getTimestamp(1) : null, workspaceId);
        if (deadline == null) return null;
        long days = (deadline.getTime() - System.currentTimeMillis()) / 86_400_000L;
        return days < 0 ? 0 : (int) days;
    }

    private List<CoursePacingPlanner.LessonWork> lessonWork(UUID workspaceId) {
        var active = jdbc.query("SELECT id FROM curricula WHERE course_id=? AND status='ACTIVE' ORDER BY generated_at DESC LIMIT 1",
                rs -> rs.next() ? rs.getObject(1, UUID.class) : null, workspaceId);
        if (active == null) return List.of();
        record Row(UUID lessonId, UUID topicId, String title, int minutes, UUID prerequisiteId, double mastery,
                   Double importance, Double difficulty, int targetLevel) {}
        List<Row> rows = jdbc.query("""
                SELECT l.id,l.topic_id,l.title,l.estimated_minutes,p.prerequisite_lesson_id,
                       COALESCE(s.measured_mastery,s.mastery,0) AS mastery,t.importance,t.difficulty,l.target_level
                FROM curriculum_lessons l
                JOIN curriculum_modules m ON m.id=l.module_id
                LEFT JOIN curriculum_lesson_prerequisites p ON p.lesson_id=l.id
                LEFT JOIN student_topic_state s ON s.topic_id=l.topic_id AND s.course_id=l.course_id
                LEFT JOIN topics t ON t.id=l.topic_id
                WHERE m.curriculum_id=? ORDER BY m.ordinal,l.ordinal
                """, (rs, rowNum) -> new Row(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3),
                rs.getInt(4), rs.getObject(5, UUID.class), rs.getDouble(6), rs.getObject(7, Double.class),
                rs.getObject(8, Double.class), rs.getInt(9)), active);
        Map<UUID, List<UUID>> prerequisites = new HashMap<>();
        Map<UUID, CoursePacingPlanner.LessonWork> byId = new java.util.LinkedHashMap<>();
        for (Row row : rows) {
            byId.computeIfAbsent(row.lessonId(), key -> new CoursePacingPlanner.LessonWork(row.lessonId(), row.topicId(), row.title(),
                    row.minutes(), row.mastery(), row.importance() == null ? 0 : row.importance(), row.difficulty() == null ? 0 : row.difficulty(),
                    row.targetLevel(), List.of()));
            if (row.prerequisiteId() != null) prerequisites.computeIfAbsent(row.lessonId(), key -> new ArrayList<>()).add(row.prerequisiteId());
        }
        List<CoursePacingPlanner.LessonWork> lessons = new ArrayList<>();
        Set<UUID> seen = new HashSet<>();
        for (Map.Entry<UUID, CoursePacingPlanner.LessonWork> entry : byId.entrySet()) {
            if (!seen.add(entry.getKey())) continue;
            CoursePacingPlanner.LessonWork work = entry.getValue();
            lessons.add(new CoursePacingPlanner.LessonWork(work.lessonId(), work.topicId(), work.title(), work.estimatedMinutes(),
                    work.mastery(), work.topicImportance(), work.topicDifficulty(), work.targetLevel(),
                    prerequisites.getOrDefault(work.lessonId(), List.of())));
        }
        return lessons;
    }
}
