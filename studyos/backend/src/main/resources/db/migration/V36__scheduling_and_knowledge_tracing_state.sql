-- Per-topic scheduling state (FSRS difficulty/stability) and the knowledge-tracing estimate.
-- A single review-interval table cannot say how hard a topic has been for one learner or how long their
-- recall of it lasts, so every topic at the same mastery was scheduled identically. These columns hold what
-- the schedule is actually derived from.
ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS difficulty_estimate DOUBLE PRECISION;
ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS stability_days DOUBLE PRECISION;
ALTER TABLE student_topic_state ADD COLUMN IF NOT EXISTS learned_probability DOUBLE PRECISION;

-- Recorded per attempt so the model's own inputs and outputs are auditable, and so the default weights can
-- one day be refitted against this learner's history instead of a global average.
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS retrievability_at_attempt DOUBLE PRECISION;
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS stability_after DOUBLE PRECISION;
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS learned_probability_after DOUBLE PRECISION;
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS review_grade SMALLINT;

-- Left NULL for topics with no graded attempt on purpose: an absent estimate must stay absent rather than be
-- backfilled into a figure that would then be reported as measured.
