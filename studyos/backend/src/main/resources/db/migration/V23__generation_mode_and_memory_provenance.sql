-- Persist the generation mode with each answer so expansions reuse the original mode instead of
-- re-classifying the question without its conversation, which previously widened a closed scope.
ALTER TABLE semantic_answer_packets ADD COLUMN IF NOT EXISTS intent VARCHAR(40);

-- Classify stored memory by provenance. Model-invented exercises stay readable in the transcript but
-- must never be recalled later as course evidence, which is what created a self-reinforcing loop.
ALTER TABLE memory_episodes ADD COLUMN IF NOT EXISTS provenance VARCHAR(40) NOT NULL DEFAULT 'CHAT_TURN';
CREATE INDEX IF NOT EXISTS idx_memory_episodes_provenance ON memory_episodes(course_id, provenance, status);

-- Retag episodes already written by the exercise generator, identified by markers this application emits.
UPDATE memory_episodes
SET provenance = 'AI_GENERATED_EXERCISE'
WHERE provenance = 'CHAT_TURN'
  AND (summary LIKE '%evidence-grounded exercise predictions%'
       OR summary LIKE '%Exam plausibility:%'
       OR summary LIKE '%Reasoning novelty:%'
       OR summary LIKE '%generated from the closed%');

-- Chat summaries are rebuilt from evidence-safe episodes on the next turn in each chat.
DELETE FROM chat_summaries
WHERE chat_id IN (SELECT DISTINCT chat_id FROM memory_episodes WHERE provenance = 'AI_GENERATED_EXERCISE' AND chat_id IS NOT NULL);
