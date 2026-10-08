package com.studyos.workspaces;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class LearningWorkspaceServiceTest {
    @Test
    void createsGeneralWorkspaceWithoutRequiringAnExam() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        LearningWorkspaceService service = new LearningWorkspaceService(jdbc);

        var workspace = service.create(new LearningWorkspaceService.CreateWorkspace(
            null, null, "German B2", "Improve conversational German",
            WorkspaceType.LANGUAGE, LearningObjective.IMPROVE_LANGUAGE, null, null, null));

        assertEquals("German B2", workspace.title());
        assertEquals(WorkspaceType.LANGUAGE, workspace.workspaceType());
        assertEquals(WorkspaceStatus.ACTIVE, workspace.status());
        assertNull(workspace.examDate());
        verify(jdbc).update(anyString(), any(Object[].class));
    }
}
