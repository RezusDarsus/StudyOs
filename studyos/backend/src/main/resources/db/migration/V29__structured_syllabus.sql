CREATE TABLE syllabus_units (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    week_number INTEGER,
    title TEXT,
    topics JSONB NOT NULL DEFAULT '[]'::jsonb,
    learning_objectives JSONB NOT NULL DEFAULT '[]'::jsonb,
    required_readings JSONB NOT NULL DEFAULT '[]'::jsonb,
    page_start INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_syllabus_units_workspace ON syllabus_units(course_id, week_number);

CREATE TABLE syllabus_assessments (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    assessment_type VARCHAR(40),
    assessment_date DATE,
    weight_percent DOUBLE PRECISION,
    page_start INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_syllabus_assessments_workspace ON syllabus_assessments(course_id, assessment_date);
