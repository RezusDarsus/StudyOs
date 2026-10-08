-- Why a misconception was believed: one row per candidate a grader produced, admitted or not.
--
-- Until now the grading model returned a free-text `misconception` and `MisconceptionService.observe` wrote it into
-- `misconceptions` — durable learner state, read by the planner's priority, the quiz generator's follow-up prompt,
-- the lesson brief, the topic capsule and the learner-state view. Nothing checked that the string had anything to
-- do with the attempt. A grader that named a concept from a neighbouring subject created a misconception the
-- learner had never shown, and the course then taught against it. Nothing recorded that this had happened, because
-- the only trace was the row it created.
--
-- This table is the check made durable. Every candidate is recorded with the verdict StudyOS reached about it and
-- what it did as a result, so "the model proposed 40 misconceptions this week and 9 were grounded in what the
-- learner actually wrote" is a query rather than a guess.
--
--   verdict — how the candidate's own vocabulary relates to the attempt it was produced from:
--     LEARNER_STATED  its distinctive terms occur in the learner's answer. The misconception is visible in what
--                     they wrote, and this is the only verdict that may create a new one.
--     TASK_GROUNDED   the terms occur in the question or the expected answer but not in the learner's answer. That
--                     is what a gap looks like — they did not say the thing — so it may reinforce a misconception
--                     already established, and may not mint one.
--     UNGROUNDED      the terms occur nowhere in the attempt. The vocabulary is the model's own, not the course's
--                     and not the learner's. This is the failure the table exists to count.
--     UNVERIFIABLE    no attempt evidence was supplied, so there was nothing to check against. Not the same as
--                     ungrounded, and stored as its own verdict rather than folded into it.
--     NOT_AN_ERROR    the answer scored too well for a misconception to be evidenced by it.
--     MALFORMED       blank, a placeholder ("none", "n/a"), the wrong length, or with no distinctive vocabulary at
--                     all — "they got confused" is not something a course can teach against.
--
--   action — CREATED, REINFORCED, or REJECTED. REJECTED rows carry `misconception_id IS NULL`: the candidate was
--            recorded and nothing durable was written, which is the whole point.
--
-- `grounded_share` and `cluster_similarity` are nullable because both are measurements that are sometimes not
-- taken: a MALFORMED candidate has no terms to take a share over, and a candidate that matched no existing
-- misconception has no similarity to report. NULL means not measured; 0 means measured and none.
CREATE TABLE IF NOT EXISTS misconception_evidence (
  id UUID PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
  misconception_id UUID REFERENCES misconceptions(id) ON DELETE SET NULL,
  attempt_id UUID REFERENCES assessment_attempts(id) ON DELETE SET NULL,
  item_id UUID REFERENCES assessment_items(id) ON DELETE SET NULL,
  candidate_label TEXT NOT NULL,
  verdict VARCHAR(20) NOT NULL,
  action VARCHAR(20) NOT NULL,
  grounded_share DOUBLE PRECISION,
  cluster_similarity DOUBLE PRECISION,
  learner_excerpt TEXT,
  score DOUBLE PRECISION,
  error_type VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT misconception_evidence_verdict CHECK (verdict IN ('LEARNER_STATED','TASK_GROUNDED','UNGROUNDED','UNVERIFIABLE','NOT_AN_ERROR','MALFORMED')),
  CONSTRAINT misconception_evidence_action CHECK (action IN ('CREATED','REINFORCED','REJECTED'))
);

-- Reading is "this workspace's recent candidates", "what established this misconception", or "how much of what the
-- grader proposed was grounded", which is the verdict count.
CREATE INDEX IF NOT EXISTS idx_misconception_evidence_course ON misconception_evidence(course_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_misconception_evidence_misconception ON misconception_evidence(misconception_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_misconception_evidence_verdict ON misconception_evidence(course_id, verdict);
CREATE INDEX IF NOT EXISTS idx_misconception_evidence_attempt ON misconception_evidence(attempt_id);

-- Misconceptions recorded before this migration have no evidence rows and none are invented for them: the attempt
-- a past candidate came from was not kept beside it, so any verdict assigned now would be a guess with a column
-- name that says it was measured. They keep their occurrences and their severity, they can still be reinforced and
-- resolved, and a workspace can tell them apart from validated ones by their having no evidence at all — which is
-- the honest distinction, and the reason nothing here is backfilled and nothing is deleted.
