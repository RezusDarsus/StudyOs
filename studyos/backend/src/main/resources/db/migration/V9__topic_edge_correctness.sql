ALTER TABLE topic_edges ADD COLUMN IF NOT EXISTS extraction_method VARCHAR(80) NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE topic_edges ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE topic_edges
SET relation_type = CASE UPPER(relation_type)
    WHEN 'PREREQUISITE' THEN 'PREREQUISITE_OF'
    WHEN 'REQUIRES' THEN 'PREREQUISITE_OF'
    WHEN 'PREREQUISITE_OF' THEN 'PREREQUISITE_OF'
    WHEN 'RELATED' THEN 'RELATED_TO'
    WHEN 'RELATED_TO' THEN 'RELATED_TO'
    ELSE relation_type
END;

INSERT INTO topic_edges(id,course_id,source_topic_id,target_topic_id,relation_type,confidence,source_chunk_id,extraction_method,created_at)
SELECT id,course_id,source_topic_id,target_topic_id,
    CASE UPPER(relation_type)
        WHEN 'PREREQUISITE' THEN 'PREREQUISITE_OF'
        WHEN 'REQUIRES' THEN 'PREREQUISITE_OF'
        WHEN 'PREREQUISITE_OF' THEN 'PREREQUISITE_OF'
        WHEN 'RELATED' THEN 'RELATED_TO'
        WHEN 'RELATED_TO' THEN 'RELATED_TO'
        ELSE relation_type
    END,
    confidence,source_chunk_id,'LEGACY_TOPIC_RELATIONS',NOW()
FROM topic_relations
ON CONFLICT DO NOTHING;

DELETE FROM topic_edges older
USING topic_edges newer
WHERE older.course_id=newer.course_id
  AND older.source_topic_id=newer.source_topic_id
  AND older.target_topic_id=newer.target_topic_id
  AND older.relation_type=newer.relation_type
  AND older.ctid < newer.ctid;

ALTER TABLE topic_edges DROP CONSTRAINT IF EXISTS topic_edges_relation_type_check;
ALTER TABLE topic_edges ADD CONSTRAINT topic_edges_relation_type_check CHECK (relation_type IN ('PREREQUISITE_OF','RELATED_TO'));
ALTER TABLE topic_edges DROP CONSTRAINT IF EXISTS topic_edges_no_self_edge;
ALTER TABLE topic_edges ADD CONSTRAINT topic_edges_no_self_edge CHECK (source_topic_id <> target_topic_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_topic_edges_identity ON topic_edges(course_id,source_topic_id,target_topic_id,relation_type);
CREATE INDEX IF NOT EXISTS idx_topic_edges_course_type ON topic_edges(course_id,relation_type);

CREATE TABLE IF NOT EXISTS topic_relation_rejections (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    source_topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
    target_topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
    source_name VARCHAR(500) NOT NULL,
    target_name VARCHAR(500) NOT NULL,
    relation_type VARCHAR(50) NOT NULL,
    confidence DOUBLE PRECISION,
    source_chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL,
    extraction_method VARCHAR(80) NOT NULL,
    rejection_reason VARCHAR(80) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_topic_relation_rejections_course ON topic_relation_rejections(course_id,created_at DESC);

DROP TABLE IF EXISTS topic_relations;
