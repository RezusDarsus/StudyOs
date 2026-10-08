ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN;
CREATE TABLE IF NOT EXISTS semantic_answer_cache (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    intent VARCHAR(50) NOT NULL,
    normalized_query TEXT NOT NULL,
    query_embedding vector(2048),
    evidence_fingerprint VARCHAR(64) NOT NULL,
    source_version VARCHAR(64) NOT NULL,
    packet JSONB NOT NULL,
    hit_count BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_hit_at TIMESTAMPTZ,
    UNIQUE(course_id,intent,normalized_query,evidence_fingerprint,source_version)
);
CREATE INDEX IF NOT EXISTS idx_semantic_answer_cache_lookup ON semantic_answer_cache(course_id,intent,evidence_fingerprint,source_version);
CREATE INDEX IF NOT EXISTS idx_semantic_answer_cache_embedding
    ON semantic_answer_cache USING hnsw ((query_embedding::halfvec(2048)) halfvec_cosine_ops);
