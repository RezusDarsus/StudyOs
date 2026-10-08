package com.studyos.workspaces;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/workspaces")
public class LearningWorkspaceController {
    private final LearningWorkspaceService workspaces;

    public LearningWorkspaceController(LearningWorkspaceService workspaces) {
        this.workspaces = workspaces;
    }

    @PostMapping
    public ResponseEntity<LearningWorkspaceService.LearningWorkspace> create(@Valid @RequestBody CreateRequest request) {
        return ResponseEntity.ok(workspaces.create(new LearningWorkspaceService.CreateWorkspace(
            request.userId(), request.goalifyGoalId(), request.title(), request.description(),
            request.workspaceType(), request.objective(), request.targetDate(), request.examDate(),
            request.researchMode())));
    }

    @GetMapping
    public List<LearningWorkspaceService.LearningWorkspace> list(
        @RequestParam(required = false) UUID userId,
        @RequestParam(required = false) WorkspaceStatus status) {
        return workspaces.list(userId, status);
    }

    @GetMapping("/{workspaceId}")
    public ResponseEntity<LearningWorkspaceService.LearningWorkspace> get(@PathVariable UUID workspaceId) {
        return workspaces.find(workspaceId).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PatchMapping("/{workspaceId}")
    public ResponseEntity<LearningWorkspaceService.LearningWorkspace> update(
        @PathVariable UUID workspaceId, @Valid @RequestBody UpdateRequest request) {
        return workspaces.update(workspaceId, new LearningWorkspaceService.UpdateWorkspace(
            request.title(), request.description(), request.workspaceType(), request.objective(),
            request.targetDate(), request.examDate(), request.status(), request.researchMode()))
            .map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{workspaceId}")
    public ResponseEntity<Void> delete(@PathVariable UUID workspaceId) {
        return workspaces.delete(workspaceId) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    public record CreateRequest(UUID userId, UUID goalifyGoalId,
        @NotBlank @Size(max = 255) String title, @Size(max = 2000) String description,
        WorkspaceType workspaceType, LearningObjective objective, LocalDate targetDate, LocalDate examDate,
        com.studyos.research.ResearchMode researchMode) {}
    public record UpdateRequest(@Size(min = 1, max = 255) String title,
        @Size(max = 2000) String description, WorkspaceType workspaceType,
        LearningObjective objective, LocalDate targetDate, LocalDate examDate, WorkspaceStatus status,
        com.studyos.research.ResearchMode researchMode) {}
}
