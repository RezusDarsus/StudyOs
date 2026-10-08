ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS answer_type VARCHAR(30) NOT NULL DEFAULT 'TEXT';
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS hints JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS source_basis JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS transformation_type VARCHAR(50);
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS similarity_score DOUBLE PRECISION;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS novelty_score DOUBLE PRECISION;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) NOT NULL DEFAULT 'NOT_REQUIRED';

ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS correctness VARCHAR(30);
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS error_type VARCHAR(100);
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS mastery_before DOUBLE PRECISION;
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS mastery_after DOUBLE PRECISION;
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS mastery_impact DOUBLE PRECISION;
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS structured_feedback JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS source_references JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS expected_outcome TEXT;
ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS difficulty DOUBLE PRECISION;
ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS recommended_activity VARCHAR(40);

CREATE TABLE learning_sessions (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    task_id UUID REFERENCES study_tasks(id) ON DELETE SET NULL,
    topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_minutes INTEGER,
    notes TEXT,
    mastery_before DOUBLE PRECISION,
    mastery_after DOUBLE PRECISION,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_learning_sessions_workspace ON learning_sessions(course_id, started_at DESC);
CREATE INDEX idx_learning_sessions_task ON learning_sessions(task_id);
