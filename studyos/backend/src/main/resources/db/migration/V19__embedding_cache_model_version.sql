ALTER TABLE embedding_cache ADD COLUMN IF NOT EXISTS model_version VARCHAR(100) NOT NULL DEFAULT '1';
ALTER TABLE embedding_cache ADD COLUMN IF NOT EXISTS hit_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE embedding_cache ADD COLUMN IF NOT EXISTS last_hit_at TIMESTAMPTZ;
ALTER TABLE embedding_cache DROP CONSTRAINT IF EXISTS embedding_cache_pkey;
ALTER TABLE embedding_cache ADD PRIMARY KEY(content_hash,embedding_model,model_version);
