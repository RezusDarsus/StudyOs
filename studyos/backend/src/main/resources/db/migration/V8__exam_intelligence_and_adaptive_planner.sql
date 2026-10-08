ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS document_id UUID REFERENCES documents(id) ON DELETE CASCADE;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS question_number INTEGER;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS points DOUBLE PRECISION;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS page_start INTEGER;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS page_end INTEGER;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS source_type VARCHAR(30);
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS year INTEGER;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS explanation TEXT;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS extraction_confidence DOUBLE PRECISION DEFAULT 0.6;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_assessment_items_document ON assessment_items(document_id, question_number);

CREATE TABLE IF NOT EXISTS assessment_item_topics (
    item_id UUID NOT NULL REFERENCES assessment_items(id) ON DELETE CASCADE,
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    relevance DOUBLE PRECISION NOT NULL DEFAULT 1,
    PRIMARY KEY(item_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_assessment_item_topics_topic ON assessment_item_topics(topic_id);

CREATE TABLE IF NOT EXISTS exam_topic_signals (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    past_exam_frequency DOUBLE PRECISION NOT NULL DEFAULT 0,
    past_exam_points DOUBLE PRECISION NOT NULL DEFAULT 0,
    homework_frequency DOUBLE PRECISION NOT NULL DEFAULT 0,
    lecture_coverage DOUBLE PRECISION NOT NULL DEFAULT 0,
    syllabus_importance DOUBLE PRECISION NOT NULL DEFAULT 0,
    professor_emphasis DOUBLE PRECISION NOT NULL DEFAULT 0,
    quiz_frequency DOUBLE PRECISION NOT NULL DEFAULT 0,
    recent_lecture_emphasis DOUBLE PRECISION NOT NULL DEFAULT 0,
    topic_centrality DOUBLE PRECISION NOT NULL DEFAULT 0,
    relevance DOUBLE PRECISION NOT NULL DEFAULT 0,
    evidence_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(course_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_exam_topic_signals_course ON exam_topic_signals(course_id, relevance DESC);

ALTER TABLE misconceptions ADD COLUMN IF NOT EXISTS normalized_label VARCHAR(500);
ALTER TABLE misconceptions ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE misconceptions ADD COLUMN IF NOT EXISTS severity DOUBLE PRECISION NOT NULL DEFAULT 0.5;
ALTER TABLE misconceptions ADD COLUMN IF NOT EXISTS successful_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE misconceptions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_misconceptions_active ON misconceptions(course_id, topic_id, status, severity DESC);

ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS measured_mastery DOUBLE PRECISION;
ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS retention_estimate DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS retention_calculated_at TIMESTAMPTZ;
UPDATE student_topic_state SET measured_mastery=mastery WHERE measured_mastery IS NULL;

ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS action VARCHAR(40) NOT NULL DEFAULT 'PRACTICE';
ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS actual_minutes INTEGER;
ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS completed BOOLEAN;
ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS student_feedback TEXT;
ALTER TABLE study_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
