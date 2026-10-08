CREATE TABLE IF NOT EXISTS topic_aliases (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    alias VARCHAR(500) NOT NULL,
    normalized_alias VARCHAR(500) NOT NULL,
    UNIQUE(course_id, normalized_alias)
);
CREATE INDEX IF NOT EXISTS idx_topic_aliases_lookup ON topic_aliases(course_id, normalized_alias);

CREATE TABLE IF NOT EXISTS topic_relations (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    source_topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    target_topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    relation_type VARCHAR(50) NOT NULL,
    confidence DOUBLE PRECISION,
    source_chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL,
    UNIQUE(course_id, source_topic_id, target_topic_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_topic_relations_course ON topic_relations(course_id);
