ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_stage VARCHAR(50);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_error TEXT;

CREATE TABLE IF NOT EXISTS summary_nodes (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES summary_nodes(id) ON DELETE CASCADE,
    level VARCHAR(30) NOT NULL,
    title TEXT,
    summary TEXT NOT NULL,
    source_count INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_summary_nodes_course ON summary_nodes(course_id, level);

CREATE TABLE IF NOT EXISTS memory_episodes (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    start_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    end_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    summary TEXT NOT NULL,
    topics JSONB NOT NULL DEFAULT '[]'::jsonb,
    decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
    unresolved_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    extracted_events JSONB NOT NULL DEFAULT '[]'::jsonb,
    token_count_original INTEGER,
    token_count_summary INTEGER,
    embedding vector(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_episodes_course ON memory_episodes(course_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_episodes_embedding ON memory_episodes USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS chat_summaries (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    covered_through TIMESTAMPTZ,
    token_count_original INTEGER,
    token_count_summary INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(chat_id)
);
