-- Episode turns are stored per role. Recall previously read one prose blob in which the learner's words and
-- the tutor's own answer were concatenated behind inline "Student asked:" / "Tutor answered:" labels, so a
-- later chat could read a tutor claim back as something the student had said. Roles are now separated in
-- storage and rendered under their own headings, which makes the boundary structural rather than textual.
ALTER TABLE memory_episodes ADD COLUMN IF NOT EXISTS turns JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Recall no longer requires an episode to be closed: an episode closes only after ~1600 tokens or a topic
-- shift, so most stored memory was permanently unreachable. Recency therefore has to fall back to when the
-- episode was created, because a still-open episode has no closed_at.
CREATE INDEX IF NOT EXISTS idx_memory_episodes_recall
    ON memory_episodes(course_id, provenance, (COALESCE(closed_at, created_at)) DESC);

-- Chat summaries are rebuilt from the same episodes on the next turn in each chat, so the previously stored
-- blobs are dropped rather than migrated: they carry the fused-role text this migration exists to remove.
DELETE FROM chat_summaries;
