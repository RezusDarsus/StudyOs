-- Exercise inventory: persistent, reuse-aware exercises with evidence-calibrated difficulty.
-- times_used/last_used_at drive the reuse pool (least-recently-used, avoid over-repetition);
-- observed_difficulty/calibration_attempts keep the authored difficulty and the measured one apart.

ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS times_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS observed_difficulty DOUBLE PRECISION;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS calibration_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_assessment_items_pool ON assessment_items(course_id, topic_id, cognitive_level, verification_status);
