-- Stabilisation fixes found by the Phase 3 audit, plus the online-research schema.

-- ---------------------------------------------------------------------------
-- 1. semantic_answer_cache: V20 dropped a constraint name that never existed.
--
-- V18 declared the 5-column UNIQUE inline, so PostgreSQL generated the name by
-- truncating it — and the exact truncation differs across PostgreSQL versions,
-- so no literal name is safe to drop by. The stale constraint is found the way
-- the database itself sees it: the unique constraint on this table that does
-- not include student_state_fingerprint. V20's 6-column safe key is kept.
DO $$
DECLARE stale TEXT;
BEGIN
    SELECT conname INTO stale FROM pg_constraint
    WHERE conrelid = 'semantic_answer_cache'::regclass AND contype = 'u'
      AND (SELECT count(*) FROM unnest(conkey)) = 5;
    IF stale IS NOT NULL THEN
        EXECUTE 'ALTER TABLE semantic_answer_cache DROP CONSTRAINT ' || quote_ident(stale);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. topic_relation_rejections: rejection rows multiplied on every re-ingestion.
--
-- The table had no identity constraint and the per-document extraction path never
-- pruned it, so re-processing one document appended a fresh copy of every rejection
-- it had produced the time before. Existing duplicate rows are collapsed first
-- (oldest kept), then a deterministic identity index makes the writer's
-- ON CONFLICT DO NOTHING actually bind. The md5 hash keeps the index row inside
-- the btree size limit that four wide text columns could exceed.
DELETE FROM topic_relation_rejections older
USING topic_relation_rejections newer
WHERE older.course_id = newer.course_id
  AND older.source_name = newer.source_name
  AND older.target_name = newer.target_name
  AND older.relation_type = newer.relation_type
  AND older.rejection_reason = newer.rejection_reason
  AND older.created_at > newer.created_at;
CREATE UNIQUE INDEX IF NOT EXISTS uq_topic_relation_rejections_identity
    ON topic_relation_rejections(course_id, md5(source_name || '|' || target_name || '|' || relation_type || '|' || rejection_reason));

-- ---------------------------------------------------------------------------
-- 3. documents.enrichment_status: core ingestion vs AI enrichment, told apart.
--
-- Topic extraction, objectives, summaries and capsules are enrichment: a provider
-- outage mid-ingestion no longer marks the document FAILED, because its chunks,
-- embeddings and section tree — the part retrieval needs — are complete. The
-- document still reports COMPLETED (every reader gates on that value), and this
-- column records that some enrichment stage did not finish. 'PARTIAL' rows carry
-- the failed stages in documents.processing_error.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS enrichment_status VARCHAR(20) NOT NULL DEFAULT 'COMPLETE';
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_enrichment_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_enrichment_status_check CHECK (enrichment_status IN ('COMPLETE', 'PARTIAL'));

-- ---------------------------------------------------------------------------
-- 4. Online research: course-level mode, run tracking, and source provenance.
--
-- Mode gates whether a workspace may research at all. SOURCE_ONLY keeps uploaded
-- material the only authority and rejects research requests; SOURCE_PLUS_RESEARCH
-- allows external sources beside the uploaded ones; RESEARCH_ONLY builds the
-- course from research. The mode is stored on the course row (workspaces are
-- course rows) because the knowledge base it governs is per course.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS research_mode VARCHAR(20) NOT NULL DEFAULT 'SOURCE_ONLY';
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_research_mode_check;
ALTER TABLE courses ADD CONSTRAINT courses_research_mode_check CHECK (research_mode IN ('SOURCE_ONLY', 'SOURCE_PLUS_RESEARCH', 'RESEARCH_ONLY'));

-- One research run: what was asked, what the planner proposed, what came back.
-- Counters are the bounded plan's accounting, so an operator can see at a glance
-- that the limits held: sources ingested never exceeds the run's cap.
CREATE TABLE IF NOT EXISTS research_runs (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    goal TEXT NOT NULL,
    mode VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    planned_queries INTEGER NOT NULL DEFAULT 0,
    queries_run INTEGER NOT NULL DEFAULT 0,
    candidates_found INTEGER NOT NULL DEFAULT 0,
    sources_ingested INTEGER NOT NULL DEFAULT 0,
    sources_skipped INTEGER NOT NULL DEFAULT 0,
    sources_failed INTEGER NOT NULL DEFAULT 0,
    bytes_fetched BIGINT NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT research_runs_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
    CONSTRAINT research_runs_mode_check CHECK (mode IN ('SOURCE_ONLY', 'SOURCE_PLUS_RESEARCH', 'RESEARCH_ONLY'))
);
CREATE INDEX IF NOT EXISTS idx_research_runs_course ON research_runs(course_id, created_at DESC);

-- Provenance for every retrieved web source. This is the record that keeps fetched
-- web content from becoming indistinguishable from uploaded material: the URL it
-- actually came from, the canonical URL it declared, who retrieved it and when,
-- and the content hash that both deduplicates and lets a later re-fetch detect
-- change. document_id links to the ingested document row carrying the text, so
-- chunks, embeddings and topics flow through the ordinary pipeline while their
-- origin stays queryable here.
CREATE TABLE IF NOT EXISTS research_sources (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    run_id UUID REFERENCES research_runs(id) ON DELETE SET NULL,
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    url TEXT NOT NULL,
    canonical_url TEXT,
    domain TEXT NOT NULL,
    title TEXT,
    provider VARCHAR(80) NOT NULL,
    query TEXT,
    quality_score DOUBLE PRECISION,
    quality_signals JSONB,
    content_hash VARCHAR(64) NOT NULL,
    byte_size INTEGER,
    content_type VARCHAR(200),
    retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    CONSTRAINT research_sources_mode CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1))
);
-- One row per canonical URL per course: re-running research must not pile up
-- duplicate copies of the same page, and the content hash keeps a changed page
-- from being silently shadowed by its old copy (the newer fetch updates the row).
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_sources_canonical ON research_sources(course_id, md5(COALESCE(canonical_url, url)));
CREATE INDEX IF NOT EXISTS idx_research_sources_course ON research_sources(course_id, retrieved_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_sources_document ON research_sources(document_id);

-- Pre-existing rows: none of the new columns has a backfill that would not be a
-- guess. Courses without an explicit mode default to SOURCE_ONLY, which is the
-- behaviour every existing workspace already had; documents completed before this
-- migration were fully enriched or would already read FAILED; semantic cache rows
-- written before the constraint fix are unaffected by dropping it; and duplicate
-- rejection rows collapse into their oldest copy, which is the one first observed.
