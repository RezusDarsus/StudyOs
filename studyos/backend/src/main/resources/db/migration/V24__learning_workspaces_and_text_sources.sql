ALTER TABLE courses ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS goalify_goal_id UUID;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS workspace_type VARCHAR(30) NOT NULL DEFAULT 'COURSE';
ALTER TABLE courses ADD COLUMN IF NOT EXISTS objective VARCHAR(40);
ALTER TABLE courses ADD COLUMN IF NOT EXISTS target_date DATE;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE courses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_courses_user_updated ON courses(user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_goalify_goal
    ON courses(goalify_goal_id)
    WHERE goalify_goal_id IS NOT NULL;

ALTER TABLE courses ADD CONSTRAINT courses_workspace_type_check
    CHECK (workspace_type IN ('COURSE', 'EXAM', 'CERTIFICATION', 'SKILL', 'LANGUAGE', 'SELF_STUDY', 'OTHER'));
ALTER TABLE courses ADD CONSTRAINT courses_status_check
    CHECK (status IN ('ACTIVE', 'ARCHIVED', 'COMPLETED'));

ALTER TABLE documents ADD COLUMN IF NOT EXISTS media_type VARCHAR(100);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
