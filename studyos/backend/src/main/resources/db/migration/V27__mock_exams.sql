CREATE TABLE assessments (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    kind VARCHAR(30) NOT NULL,
    title VARCHAR(500) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'READY',
    estimated_minutes INTEGER,
    topic_mix JSONB NOT NULL DEFAULT '[]'::jsonb,
    instructions TEXT,
    score DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE INDEX idx_assessments_workspace ON assessments(course_id, created_at DESC);

ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS assessment_id UUID REFERENCES assessments(id) ON DELETE CASCADE;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS ordinal INTEGER;
CREATE INDEX IF NOT EXISTS idx_assessment_items_assessment ON assessment_items(assessment_id, ordinal);
