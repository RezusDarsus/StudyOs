ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS embedding vector(2048);
CREATE INDEX IF NOT EXISTS idx_assessment_items_course_source
    ON assessment_items(course_id, source_type)
    WHERE source_type IN ('HOMEWORK', 'PAST_EXAM', 'QUIZ', 'ASSIGNMENT');
