-- Curriculum integrity + revision metadata: the last validation report, when it ran, and the
-- revision counter/reason so a re-plan is never a silent mutation of the learner's plan.

ALTER TABLE curricula ADD COLUMN IF NOT EXISTS integrity_report JSONB;
ALTER TABLE curricula ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;
ALTER TABLE curricula ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE curricula ADD COLUMN IF NOT EXISTS revision_reason TEXT;
