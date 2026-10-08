CREATE TABLE workspace_preferences (
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    preference_key VARCHAR(100) NOT NULL,
    preference_value TEXT NOT NULL,
    source VARCHAR(30) NOT NULL DEFAULT 'USER',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(course_id, preference_key)
);
CREATE INDEX idx_workspace_preferences_updated ON workspace_preferences(course_id, updated_at DESC);

UPDATE misconceptions SET status='DETECTED' WHERE status='ACTIVE';
UPDATE misconceptions SET status='REINFORCED' WHERE status='RECURRED';
UPDATE misconceptions SET status='IMPROVING' WHERE status='WEAKENING';
