package com.studyos.integration;

import com.studyos.planner.StudyPlanService;
import com.studyos.workspaces.*;
import java.time.LocalDate;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class GoalifyIntegrationService {
    private final JdbcTemplate jdbc;private final LearningWorkspaceService workspaces;private final StudyPlanService plans;
    public GoalifyIntegrationService(JdbcTemplate jdbc,LearningWorkspaceService workspaces,StudyPlanService plans){this.jdbc=jdbc;this.workspaces=workspaces;this.plans=plans;}

    public Activation activate(ActivationCommand command){
        LearningGoalDetector.Result detection=LearningGoalDetector.detect(command.title(),command.description());
        if(!command.enabled())return new Activation("DECLINED",null,detection,"Goalify should continue the normal goal flow without StudyOS.");
        var existing=workspaces.findByGoalifyGoal(command.goalifyGoalId());if(existing.isPresent())return new Activation("ALREADY_ACTIVE",existing.get(),detection,"Existing StudyOS workspace returned.");
        WorkspaceType type=command.workspaceType()==null?inferType(command.title(),command.objective()):command.workspaceType();
        var workspace=workspaces.create(new LearningWorkspaceService.CreateWorkspace(command.userId(),command.goalifyGoalId(),command.title(),command.description(),type,command.objective(),command.targetDate(),command.examDate(),null));
        return new Activation("ACTIVATED",workspace,detection,"StudyOS is enabled; Goalify remains the execution owner.");
    }

    public RecommendationEnvelope recommendations(UUID workspaceId,int availableMinutes,LocalDate date){StudyPlanService.Plan plan=plans.current(workspaceId,date);if(plan.id()==null)plan=plans.generate(workspaceId,date,availableMinutes);List<GoalifyTask> tasks=plan.tasks().stream().filter(task->"PENDING".equals(task.status())).map(task->new GoalifyTask(task.taskId(),task.action(),task.title(),task.durationMinutes(),priority(task.priority()),task.reason(),task.sourceReferences(),task.expectedOutcome(),task.difficulty(),task.recommendedActivity(),"/ui/index.html?workspace="+workspaceId+"&task="+task.taskId())).toList();return new RecommendationEnvelope(workspaceId,date,plan.readiness(),tasks,"Goalify owns scheduling, completion, notifications, XP, streaks, and social presentation.");}
    public TaskLink link(UUID workspaceId,UUID studyTaskId,UUID goalifyGoalId,UUID goalifyTaskId){plans.details(studyTaskId,workspaceId);UUID id=UUID.randomUUID();jdbc.update("INSERT INTO study_task_links(id,course_id,study_task_id,goalify_goal_id,goalify_task_id) VALUES(?,?,?,?,?) ON CONFLICT(study_task_id) DO UPDATE SET goalify_goal_id=EXCLUDED.goalify_goal_id,goalify_task_id=EXCLUDED.goalify_task_id,updated_at=NOW()",id,workspaceId,studyTaskId,goalifyGoalId,goalifyTaskId);return new TaskLink(studyTaskId,goalifyTaskId,goalifyGoalId);}
    public StudyPlanService.Completion completion(UUID workspaceId,UUID studyTaskId,Integer actualMinutes,boolean completed,String feedback){plans.details(studyTaskId,workspaceId);return plans.complete(studyTaskId,actualMinutes,completed,null,null,feedback);}
    public SocialProgress socialProgress(UUID workspaceId){return jdbc.query("SELECT COUNT(*) FILTER (WHERE t.status='COMPLETED'),COUNT(*),COALESCE(SUM(COALESCE(t.actual_minutes,0)) FILTER (WHERE t.status='COMPLETED'),0),MAX(t.completed_at) FROM study_tasks t JOIN study_plans p ON p.id=t.plan_id WHERE p.course_id=?",rs->{rs.next();return new SocialProgress(rs.getInt(1),rs.getInt(2),rs.getInt(3),rs.getTimestamp(4));},workspaceId);}
    private WorkspaceType inferType(String title,LearningObjective objective){String value=title==null?"":title.toLowerCase(Locale.ROOT);if(objective==LearningObjective.IMPROVE_LANGUAGE)return WorkspaceType.LANGUAGE;if(objective==LearningObjective.PREPARE_CERTIFICATION||value.contains("certification"))return WorkspaceType.CERTIFICATION;if(objective==LearningObjective.PASS_EXAM)return WorkspaceType.EXAM;if(objective==LearningObjective.BUILD_SKILL)return WorkspaceType.SKILL;return WorkspaceType.COURSE;}
    private String priority(double value){return value>=.7?"HIGH":value>=.4?"MEDIUM":"LOW";}
    public record ActivationCommand(UUID userId,UUID goalifyGoalId,String title,String description,boolean enabled,WorkspaceType workspaceType,LearningObjective objective,LocalDate targetDate,LocalDate examDate){}
    public record Activation(String status,LearningWorkspaceService.LearningWorkspace workspace,LearningGoalDetector.Result detection,String message){}
    public record GoalifyTask(UUID studyTaskId,String type,String title,int estimatedMinutes,String priority,String reason,List<StudyPlanService.SourceReference> sourceReferences,String expectedOutcome,Double difficulty,String recommendedActivity,String deepLink){}
    public record RecommendationEnvelope(UUID workspaceId,LocalDate date,double readiness,List<GoalifyTask> tasks,String ownership){}
    public record TaskLink(UUID studyTaskId,UUID goalifyTaskId,UUID goalifyGoalId){}
    /** Deliberately contains no topic, mastery, misconception, readiness, answer, or source data. */
    public record SocialProgress(int completedTasks,int totalTasks,int completedMinutes,java.sql.Timestamp lastCompletedAt){}
}
