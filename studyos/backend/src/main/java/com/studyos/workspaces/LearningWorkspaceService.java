package com.studyos.workspaces;

import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import com.studyos.research.ResearchMode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class LearningWorkspaceService {
    private final JdbcTemplate jdbc;

    public LearningWorkspaceService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public LearningWorkspace create(CreateWorkspace command) {
        UUID id = UUID.randomUUID();
        WorkspaceType type = command.workspaceType() == null ? WorkspaceType.OTHER : command.workspaceType();
        WorkspaceStatus status = WorkspaceStatus.ACTIVE;
        Instant now = Instant.now();
        jdbc.update("""
            INSERT INTO courses(
                id, user_id, goalify_goal_id, name, description, workspace_type,
                objective, target_date, exam_date, status, research_mode, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, id, command.userId(), command.goalifyGoalId(), command.title(), command.description(),
            type.name(), command.objective() == null ? null : command.objective().name(),
            sqlDate(command.targetDate()), sqlDate(command.examDate()), status.name(),
            (command.researchMode() == null ? ResearchMode.SOURCE_ONLY : command.researchMode()).name(),
            Timestamp.from(now), Timestamp.from(now));
        return new LearningWorkspace(id, command.userId(), command.goalifyGoalId(), command.title(),
            command.description(), type, command.objective(), command.targetDate(), command.examDate(),
            status, command.researchMode() == null ? ResearchMode.SOURCE_ONLY : command.researchMode(), now, now);
    }

    public Optional<LearningWorkspace> find(UUID id) {
        return jdbc.query("""
            SELECT id,user_id,goalify_goal_id,name,description,workspace_type,objective,
                   target_date,exam_date,status,research_mode,created_at,updated_at
            FROM courses WHERE id=?
            """, rs -> rs.next() ? Optional.of(map(rs)) : Optional.empty(), id);
    }

    public Optional<LearningWorkspace> findByGoalifyGoal(UUID goalId){if(goalId==null)return Optional.empty();return jdbc.query("SELECT id,user_id,goalify_goal_id,name,description,workspace_type,objective,target_date,exam_date,status,research_mode,created_at,updated_at FROM courses WHERE goalify_goal_id=?",rs->rs.next()?Optional.of(map(rs)):Optional.empty(),goalId);}

    public List<LearningWorkspace> list(UUID userId, WorkspaceStatus status) {
        StringBuilder sql = new StringBuilder("""
            SELECT id,user_id,goalify_goal_id,name,description,workspace_type,objective,
                   target_date,exam_date,status,research_mode,created_at,updated_at FROM courses WHERE 1=1
            """);
        java.util.ArrayList<Object> arguments = new java.util.ArrayList<>();
        if (userId != null) { sql.append(" AND user_id=?"); arguments.add(userId); }
        if (status != null) { sql.append(" AND status=?"); arguments.add(status.name()); }
        sql.append(" ORDER BY updated_at DESC, created_at DESC");
        return jdbc.query(sql.toString(), (rs, row) -> map(rs), arguments.toArray());
    }

    public Optional<LearningWorkspace> update(UUID id, UpdateWorkspace command) {
        Optional<LearningWorkspace> current = find(id);
        if (current.isEmpty()) return Optional.empty();
        LearningWorkspace old = current.get();
        String title = command.title() == null ? old.title() : command.title();
        String description = command.description() == null ? old.description() : command.description();
        WorkspaceType type = command.workspaceType() == null ? old.workspaceType() : command.workspaceType();
        LearningObjective objective = command.objective() == null ? old.objective() : command.objective();
        LocalDate targetDate = command.targetDate() == null ? old.targetDate() : command.targetDate();
        LocalDate examDate = command.examDate() == null ? old.examDate() : command.examDate();
        WorkspaceStatus status = command.status() == null ? old.status() : command.status();
        ResearchMode researchMode = command.researchMode() == null ? old.researchMode() : command.researchMode();
        jdbc.update("""
            UPDATE courses SET name=?,description=?,workspace_type=?,objective=?,target_date=?,
                exam_date=?,status=?,research_mode=?,updated_at=NOW() WHERE id=?
            """, title, description, type.name(), objective == null ? null : objective.name(),
            sqlDate(targetDate), sqlDate(examDate), status.name(), researchMode.name(), id);
        return find(id);
    }

    /**
     * Deletes the workspace and everything scoped to it. Course-scoped child tables carry
     * ON DELETE CASCADE (verified across V1→V50), so the single row delete is the whole operation —
     * no per-table manual sweep, and no partial state can survive. {@code ai_usage} deliberately
     * SET NULLs: provider cost history outlives the workspace it was spent on.
     */
    public boolean delete(UUID id) {
        return jdbc.update("DELETE FROM courses WHERE id=?", id) == 1;
    }

    private LearningWorkspace map(java.sql.ResultSet rs) throws java.sql.SQLException {
        Date targetDate = rs.getDate("target_date");
        Date examDate = rs.getDate("exam_date");
        Timestamp createdAt = rs.getTimestamp("created_at");
        Timestamp updatedAt = rs.getTimestamp("updated_at");
        String objective = rs.getString("objective");
        String researchMode = rs.getString("research_mode");
        return new LearningWorkspace(
            rs.getObject("id", UUID.class), rs.getObject("user_id", UUID.class),
            rs.getObject("goalify_goal_id", UUID.class), rs.getString("name"),
            rs.getString("description"), WorkspaceType.valueOf(rs.getString("workspace_type")),
            objective == null ? null : LearningObjective.valueOf(objective),
            targetDate == null ? null : targetDate.toLocalDate(),
            examDate == null ? null : examDate.toLocalDate(),
            WorkspaceStatus.valueOf(rs.getString("status")),
            researchMode == null ? ResearchMode.SOURCE_ONLY : ResearchMode.valueOf(researchMode),
            createdAt.toInstant(), updatedAt.toInstant());
    }

    private static Date sqlDate(LocalDate value) { return value == null ? null : Date.valueOf(value); }

    public record CreateWorkspace(UUID userId, UUID goalifyGoalId, String title, String description,
        WorkspaceType workspaceType, LearningObjective objective, LocalDate targetDate, LocalDate examDate,
        ResearchMode researchMode) {}
    public record UpdateWorkspace(String title, String description, WorkspaceType workspaceType,
        LearningObjective objective, LocalDate targetDate, LocalDate examDate, WorkspaceStatus status,
        ResearchMode researchMode) {}
    public record LearningWorkspace(UUID id, UUID userId, UUID goalifyGoalId, String title,
        String description, WorkspaceType workspaceType, LearningObjective objective,
        LocalDate targetDate, LocalDate examDate, WorkspaceStatus status, ResearchMode researchMode,
        Instant createdAt, Instant updatedAt) {}
}
