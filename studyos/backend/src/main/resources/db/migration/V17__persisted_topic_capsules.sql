CREATE TABLE IF NOT EXISTS topic_capsule_cache (
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    source_version VARCHAR(64) NOT NULL,
    static_payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(course_id, topic_id)
);
