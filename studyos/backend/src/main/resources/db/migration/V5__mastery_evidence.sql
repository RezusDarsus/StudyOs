ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS alpha DOUBLE PRECISION NOT NULL DEFAULT 2;
ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS beta DOUBLE PRECISION NOT NULL DEFAULT 2;
ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS last_assessed_at TIMESTAMPTZ;
ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS last_studied_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS assessment_items (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
    source_chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL,
    type VARCHAR(40) NOT NULL,
    prompt TEXT NOT NULL,
    answer TEXT,
    difficulty DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assessment_items_course ON assessment_items(course_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assessment_attempts (
    id UUID PRIMARY KEY,
    item_id UUID REFERENCES assessment_items(id) ON DELETE SET NULL,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
    answer TEXT,
    score DOUBLE PRECISION NOT NULL CHECK (score >= 0 AND score <= 1),
    feedback TEXT,
    difficulty DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assessment_attempts_topic ON assessment_attempts(course_id, topic_id, created_at DESC);
