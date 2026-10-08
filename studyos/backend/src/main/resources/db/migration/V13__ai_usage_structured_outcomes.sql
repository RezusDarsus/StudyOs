ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS structured_parse_success BOOLEAN;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS structured_repair_used BOOLEAN;
CREATE INDEX IF NOT EXISTS idx_ai_usage_structured_outcomes ON ai_usage(operation, structured_parse_success, created_at DESC);
