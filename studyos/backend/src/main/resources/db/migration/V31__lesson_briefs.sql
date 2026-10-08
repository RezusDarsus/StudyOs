-- Lesson briefs: the teaching content for one curriculum lesson, written the first time a student
-- studies it and reused afterwards. Held apart from curriculum_lessons so rewriting a brief never
-- touches the graph, and so a partial brief can be replaced without losing the lesson's position.

CREATE TABLE IF NOT EXISTS curriculum_lesson_briefs (
    lesson_id UUID PRIMARY KEY REFERENCES curriculum_lessons(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    grounded BOOLEAN NOT NULL DEFAULT FALSE,
    complete BOOLEAN NOT NULL DEFAULT FALSE,
    payload JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lesson_briefs_workspace ON curriculum_lesson_briefs(course_id);
