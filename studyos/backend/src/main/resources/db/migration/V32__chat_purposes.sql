-- A workspace holds several chats at once — a main tutor, homework help, one week's deep dive, exam
-- preparation — and they share the same student and course memory. The purpose records what a chat is
-- for, so an unspecific turn ("another one", "I'm stuck") can be read the way that chat intends it.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS purpose VARCHAR(40) NOT NULL DEFAULT 'GENERAL';

CREATE INDEX IF NOT EXISTS idx_chats_course_recent ON chats(course_id, updated_at DESC);
