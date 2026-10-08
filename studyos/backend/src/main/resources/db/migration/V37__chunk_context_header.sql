-- Contextual retrieval: a chunk is indexed with the document and section it belongs to, not only its own text.
--
-- A chunk taken from the middle of a section rarely repeats the name of what it explains, so its full-text
-- vector and its embedding both miss a query that names the topic. The header column holds that context, and
-- the search vector is rebuilt over the header plus the content so lexical retrieval sees it too. It is kept
-- out of `content` on purpose: `content` is what gets quoted and cited, and a header is not source text.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS context_header TEXT;

-- A generated column's expression cannot be altered in place, so the column is replaced. Dropping it drops the
-- index with it; re-adding recomputes every existing row, and rows ingested before this migration simply have
-- a NULL header and keep exactly the vector they had.
ALTER TABLE chunks DROP COLUMN IF EXISTS search_vector;
ALTER TABLE chunks ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(context_header, '') || ' ' || coalesce(content, ''))
) STORED;
CREATE INDEX IF NOT EXISTS idx_chunks_search ON chunks USING GIN(search_vector);
