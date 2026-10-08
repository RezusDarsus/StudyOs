ALTER TABLE memory_episodes ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'CLOSED';
ALTER TABLE memory_episodes ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE memory_episodes ADD COLUMN IF NOT EXISTS topic_hint VARCHAR(300);
ALTER TABLE memory_episodes ADD COLUMN IF NOT EXISTS importance DOUBLE PRECISION NOT NULL DEFAULT 0;
UPDATE memory_episodes SET status='CLOSED', closed_at=COALESCE(closed_at, created_at) WHERE status IS NULL OR status<>'OPEN';
CREATE INDEX IF NOT EXISTS idx_memory_episodes_open ON memory_episodes(course_id, chat_id, status, created_at DESC);
