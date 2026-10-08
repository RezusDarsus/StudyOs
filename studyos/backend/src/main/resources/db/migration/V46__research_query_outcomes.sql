-- Research query feedback: per-query outcomes for every run, so future planning can tell which
-- queries produced ingested knowledge and which only burned the budget.

CREATE TABLE IF NOT EXISTS research_query_outcomes (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    candidates INTEGER NOT NULL DEFAULT 0,
    ingested INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    cached INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    yield DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_query_outcomes_run ON research_query_outcomes(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_research_query_outcomes_query ON research_query_outcomes(query);
