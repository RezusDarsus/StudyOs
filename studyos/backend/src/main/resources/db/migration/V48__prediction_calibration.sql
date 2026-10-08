-- Prediction calibration infrastructure: model versions, persisted backtest runs (append-only),
-- per-fold results, and readiness-validation pairs. A backtest is observational: nothing here is
-- written by the learning loop, and learner state is never touched by a backtest run.

CREATE TABLE IF NOT EXISTS prediction_model_versions (
    id UUID PRIMARY KEY,
    model_version VARCHAR(40) NOT NULL,
    course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    weights JSONB NOT NULL DEFAULT '{}'::jsonb,
    basis TEXT,
    evaluation_metrics JSONB,
    corpus_summary JSONB,
    superseded_by VARCHAR(40),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_prediction_model_version UNIQUE (model_version, course_id)
);

CREATE TABLE IF NOT EXISTS prediction_backtest_runs (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    model_version VARCHAR(40) NOT NULL,
    exam_count INTEGER NOT NULL,
    fold_count INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
    precision_at_3 DOUBLE PRECISION,
    precision_at_5 DOUBLE PRECISION,
    recall_at_3 DOUBLE PRECISION,
    recall_at_5 DOUBLE PRECISION,
    mrr DOUBLE PRECISION,
    ndcg_at_5 DOUBLE PRECISION,
    ndcg_at_10 DOUBLE PRECISION,
    spearman DOUBLE PRECISION,
    brier DOUBLE PRECISION,
    structure_brier DOUBLE PRECISION,
    calibration_error DOUBLE PRECISION,
    calibration_json JSONB,
    baseline_comparison JSONB,
    drift JSONB,
    error_analysis JSONB,
    config_snapshot JSONB,
    fixture_hash VARCHAR(64),
    duration_ms BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prediction_backtest_runs_course
    ON prediction_backtest_runs(course_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prediction_backtest_folds (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES prediction_backtest_runs(id) ON DELETE CASCADE,
    exam_index INTEGER NOT NULL,
    exam_id UUID,
    exam_name TEXT,
    training_exams INTEGER NOT NULL,
    predicted JSONB,
    actual JSONB,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    structure_metrics JSONB,
    confidence VARCHAR(10),
    errors JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prediction_backtest_folds_run
    ON prediction_backtest_folds(run_id, exam_index);

CREATE TABLE IF NOT EXISTS readiness_validation_pairs (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    forecast_readiness DOUBLE PRECISION NOT NULL,
    model_version VARCHAR(40) NOT NULL DEFAULT 'READINESS_V1',
    forecast_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    exam_date DATE,
    source VARCHAR(30) NOT NULL DEFAULT 'MOCK_EXAM',
    actual_score DOUBLE PRECISION,
    actual_recorded_at TIMESTAMPTZ,
    notes TEXT,
    CONSTRAINT readiness_validation_pairs_score_range CHECK (
        actual_score IS NULL OR (actual_score >= 0 AND actual_score <= 1))
);
CREATE INDEX IF NOT EXISTS idx_readiness_validation_pairs_course
    ON readiness_validation_pairs(course_id, forecast_at DESC);

-- Benchmark workspaces are marked by an explicit manifest row, never by name convention: a
-- benchmark course cannot be mistaken for an ordinary learner workspace and its corpus can be
-- reproduced from the stored fixture hash.
CREATE TABLE IF NOT EXISTS prediction_benchmark_manifests (
    course_id UUID PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
    label VARCHAR(120) NOT NULL,
    corpus_kind VARCHAR(20) NOT NULL DEFAULT 'MIXED',
    fixture_hash VARCHAR(64) NOT NULL,
    exam_count INTEGER NOT NULL DEFAULT 0,
    fixture_count INTEGER NOT NULL DEFAULT 0,
    manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
