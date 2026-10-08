ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ai_usage_course_operation ON ai_usage(course_id, operation, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_document ON ai_usage(document_id, created_at DESC);
