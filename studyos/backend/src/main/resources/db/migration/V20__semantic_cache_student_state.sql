ALTER TABLE semantic_answer_cache
    ADD COLUMN IF NOT EXISTS student_state_fingerprint VARCHAR(64) NOT NULL DEFAULT '';

ALTER TABLE semantic_answer_cache
    DROP CONSTRAINT IF EXISTS semantic_answer_cache_course_id_intent_normalized_query_e_key;

ALTER TABLE semantic_answer_cache
    ADD CONSTRAINT semantic_answer_cache_safe_key
    UNIQUE(course_id,intent,normalized_query,evidence_fingerprint,source_version,student_state_fingerprint);

DROP INDEX IF EXISTS idx_semantic_answer_cache_lookup;
CREATE INDEX idx_semantic_answer_cache_lookup
    ON semantic_answer_cache(course_id,intent,evidence_fingerprint,source_version,student_state_fingerprint);
