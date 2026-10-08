DROP INDEX IF EXISTS idx_chunks_embedding;
DROP INDEX IF EXISTS idx_memory_episodes_embedding;
ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(2048);
ALTER TABLE memory_episodes ALTER COLUMN embedding TYPE vector(2048);
-- pgvector HNSW currently caps vector indexes at 2,000 dimensions. Keep the
-- full 2,048-dimensional model output and use exact cosine search for now.
-- A future migration can switch these columns to halfvec(2048) and add HNSW.
