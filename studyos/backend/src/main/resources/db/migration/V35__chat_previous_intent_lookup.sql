-- A follow-up turn ("another one, but not this topic") is served as whatever the previous turn was served
-- as, which means every chat turn now reads the last recorded intent for that chat. Without this index that
-- is a scan of the chat's whole packet history on the hot path.
CREATE INDEX IF NOT EXISTS idx_semantic_answer_packets_recent
    ON semantic_answer_packets(chat_id, created_at DESC);
