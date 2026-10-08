-- Topic-extraction quality audit. One row per distinct rejected/accepted candidate per source path,
-- so "why was this candidate rejected?" has a durable answer without persisting every fragment
-- forever. Extraction-time rejects and cleanup-time decisions both land here, idempotently.

CREATE TABLE IF NOT EXISTS topic_extraction_audit (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    normalized_candidate VARCHAR(500) NOT NULL,
    sample TEXT,
    source VARCHAR(30) NOT NULL DEFAULT 'EXTRACTION',
    decision VARCHAR(10) NOT NULL,
    reason VARCHAR(30) NOT NULL,
    quality_score DOUBLE PRECISION NOT NULL DEFAULT 0,
    occurrences INTEGER NOT NULL DEFAULT 1,
    extraction_version VARCHAR(40) NOT NULL DEFAULT 'TOPIC_EXTRACTION_V1',
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_topic_extraction_audit UNIQUE (course_id, normalized_candidate, source)
);
CREATE INDEX IF NOT EXISTS idx_topic_extraction_audit_course
    ON topic_extraction_audit(course_id, decision, reason);
