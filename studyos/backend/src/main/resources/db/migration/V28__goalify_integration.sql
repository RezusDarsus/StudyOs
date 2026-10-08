CREATE TABLE study_task_links (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    study_task_id UUID NOT NULL REFERENCES study_tasks(id) ON DELETE CASCADE,
    goalify_goal_id UUID,
    goalify_task_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(study_task_id),
    UNIQUE(goalify_task_id)
);
CREATE INDEX idx_study_task_links_workspace ON study_task_links(course_id, updated_at DESC);
