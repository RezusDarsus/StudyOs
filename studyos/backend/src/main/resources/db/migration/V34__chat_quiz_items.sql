-- A quiz asked for in chat used to be answered in the same breath: the model wrote the questions and their
-- answers into one reply, so there was nothing left to attempt. Chat quizzes now go through the same
-- generator the quiz endpoints use, which keeps each answer in assessment_items and hands back only the
-- questions. This table remembers which items a chat issued, so a later turn ("here are my answers") can
-- find them, and so an unattempted quiz is still gradeable after the reply has scrolled away.
CREATE TABLE IF NOT EXISTS chat_quiz_items (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES assessment_items(id) ON DELETE CASCADE,
    ordinal SMALLINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_quiz_items_unique ON chat_quiz_items(chat_id, item_id);
CREATE INDEX IF NOT EXISTS idx_chat_quiz_items_recent ON chat_quiz_items(chat_id, created_at DESC, ordinal);
