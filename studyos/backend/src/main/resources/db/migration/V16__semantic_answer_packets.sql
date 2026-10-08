CREATE TABLE IF NOT EXISTS semantic_answer_packets (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    assistant_message_id UUID NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    packet JSONB NOT NULL,
    evidence_fingerprint VARCHAR(64),
    source_version VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS answer_expansions (
    id UUID PRIMARY KEY,
    packet_id UUID NOT NULL REFERENCES semantic_answer_packets(id) ON DELETE CASCADE,
    expansion_type VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(packet_id, expansion_type)
);
