-- Topic reconciliation: canonical redirection for merged topics + an audit trail.
--
-- Merging a duplicate topic must never destroy history: the merged-away row keeps its identity
-- (name, unique normalized spelling) and points at the canonical topic it was folded into. Every
-- foreign key reference is MOVED to the canonical topic inside the merge transaction, so readers
-- keep working unchanged; the redirect row remains as an audit marker and as a resolution target
-- for old stored names.

ALTER TABLE topics ADD COLUMN IF NOT EXISTS canonical_topic_id UUID REFERENCES topics(id) ON DELETE SET NULL;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS merge_note TEXT;

CREATE INDEX IF NOT EXISTS idx_topics_canonical ON topics(course_id, canonical_topic_id) WHERE canonical_topic_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS topic_reconciliations (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    kept_topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    merged_topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    decision VARCHAR(20) NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    reason TEXT,
    stages JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_topic_reconciliations_course ON topic_reconciliations(course_id, created_at DESC);
