-- Phase 3 learning engine: curriculum graph, cognitive ladder, gated hint ladder,
-- long-term learner profile, and deterministic tutor sessions.

CREATE TABLE IF NOT EXISTS curricula (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    mode VARCHAR(20) NOT NULL,
    goal TEXT,
    title VARCHAR(500) NOT NULL,
    summary TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    evidence_basis JSONB NOT NULL DEFAULT '[]'::jsonb,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_curricula_workspace ON curricula(course_id, status, generated_at DESC);

CREATE TABLE IF NOT EXISTS curriculum_modules (
    id UUID PRIMARY KEY,
    curriculum_id UUID NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    title VARCHAR(500) NOT NULL,
    summary TEXT,
    target_level SMALLINT NOT NULL DEFAULT 3,
    estimated_minutes INTEGER NOT NULL DEFAULT 60,
    UNIQUE(curriculum_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_curriculum_modules_workspace ON curriculum_modules(course_id, ordinal);

CREATE TABLE IF NOT EXISTS curriculum_lessons (
    id UUID PRIMARY KEY,
    module_id UUID NOT NULL REFERENCES curriculum_modules(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    ordinal INTEGER NOT NULL,
    title VARCHAR(500) NOT NULL,
    objective TEXT,
    key_ideas JSONB NOT NULL DEFAULT '[]'::jsonb,
    target_level SMALLINT NOT NULL DEFAULT 3,
    estimated_minutes INTEGER NOT NULL DEFAULT 25,
    content_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    UNIQUE(module_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_curriculum_lessons_workspace ON curriculum_lessons(course_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_curriculum_lessons_topic ON curriculum_lessons(topic_id);

CREATE TABLE IF NOT EXISTS curriculum_lesson_prerequisites (
    lesson_id UUID NOT NULL REFERENCES curriculum_lessons(id) ON DELETE CASCADE,
    prerequisite_lesson_id UUID NOT NULL REFERENCES curriculum_lessons(id) ON DELETE CASCADE,
    PRIMARY KEY(lesson_id, prerequisite_lesson_id)
);

CREATE TABLE IF NOT EXISTS topic_ladder_state (
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    level SMALLINT NOT NULL DEFAULT 1,
    return_level SMALLINT,
    consecutive_success INTEGER NOT NULL DEFAULT 0,
    consecutive_failure INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    diagnostic_pending BOOLEAN NOT NULL DEFAULT FALSE,
    remediation_topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
    last_action VARCHAR(40),
    last_reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(course_id, topic_id)
);

CREATE TABLE IF NOT EXISTS exercise_support_events (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES assessment_items(id) ON DELETE CASCADE,
    level SMALLINT NOT NULL,
    support_type VARCHAR(30) NOT NULL,
    revealed_solution BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exercise_support_item ON exercise_support_events(item_id, level DESC);

ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS cognitive_level SMALLINT;
ALTER TABLE assessment_items ADD COLUMN IF NOT EXISTS activity_kind VARCHAR(30);
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS cognitive_level SMALLINT;
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS activity_kind VARCHAR(30);
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS support_level_used SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE assessment_attempts ADD COLUMN IF NOT EXISTS evidence_weight DOUBLE PRECISION;

ALTER TABLE misconceptions ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
UPDATE misconceptions SET first_seen_at=COALESCE(first_seen_at,last_seen_at) WHERE first_seen_at IS NULL;

CREATE TABLE IF NOT EXISTS learner_profile_traits (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    trait_type VARCHAR(40) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
    detail TEXT,
    value DOUBLE PRECISION NOT NULL DEFAULT 0,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(course_id, trait_type, subject)
);
CREATE INDEX IF NOT EXISTS idx_learner_profile_traits_workspace ON learner_profile_traits(course_id, trait_type, value DESC);

CREATE TABLE IF NOT EXISTS tutor_sessions (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    plan_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
    total_minutes INTEGER NOT NULL DEFAULT 0,
    readiness_before DOUBLE PRECISION,
    readiness_projected DOUBLE PRECISION,
    readiness_after DOUBLE PRECISION,
    learning_session_id UUID REFERENCES learning_sessions(id) ON DELETE SET NULL,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tutor_sessions_workspace ON tutor_sessions(course_id, plan_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS tutor_session_steps (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES tutor_sessions(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind VARCHAR(30) NOT NULL,
    topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
    lesson_id UUID REFERENCES curriculum_lessons(id) ON DELETE SET NULL,
    title VARCHAR(500) NOT NULL,
    why TEXT,
    minutes INTEGER NOT NULL,
    target_level SMALLINT NOT NULL DEFAULT 3,
    difficulty DOUBLE PRECISION NOT NULL DEFAULT .5,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    item_id UUID REFERENCES assessment_items(id) ON DELETE SET NULL,
    score DOUBLE PRECISION,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    UNIQUE(session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_tutor_session_steps_session ON tutor_session_steps(session_id, ordinal);
