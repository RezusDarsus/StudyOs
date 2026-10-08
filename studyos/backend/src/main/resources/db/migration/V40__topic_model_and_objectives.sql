-- The topic model: what a topic is worth learning, how much trouble it gives, what it means to have learned it.
--
-- `topics` has held a name, a description and nothing else since V1, so every subsystem that needed to know how
-- central or how hard a topic was invented its own answer. The planner ranked by exam relevance, the ladder
-- inferred difficulty from the last few attempts, and generation guessed. These columns give all of them one
-- measured figure to read, computed by `TopicModel` from evidence already in this database.
--
-- Nothing here is asked of a model. Importance is counted from how much of the corpus is about the topic, how
-- many of its documents mention it, how often it is a section's own title, and its exam relevance where past
-- exams exist. Difficulty is the course's demand, not one learner's record: the difficulty of the questions the
-- course's own documents set on the topic, how deep into the prerequisite chain it sits, and the shortfall in
-- graded attempts on it. A topic with none of the three has no difficulty, and that is the point of the columns
-- being nullable.
ALTER TABLE topics ADD COLUMN IF NOT EXISTS importance DOUBLE PRECISION;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS difficulty DOUBLE PRECISION;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS difficulty_attempts INTEGER;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS model_basis JSONB;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS model_updated_at TIMESTAMPTZ;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS embedding vector(2048);
ALTER TABLE topics ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

-- NULL is "not measured" for both figures and a number is a measurement, so the range is only checked when there
-- is one. `difficulty_attempts` is how many graded attempts stood behind one of difficulty's three components: a
-- topic can have attempts recorded and still carry no difficulty, because two attempts are not enough to call a
-- topic hard and nothing else about it had been measured either.
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_importance_range;
ALTER TABLE topics ADD CONSTRAINT topics_importance_range CHECK (importance IS NULL OR (importance >= 0 AND importance <= 1));
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_difficulty_range;
ALTER TABLE topics ADD CONSTRAINT topics_difficulty_range CHECK (difficulty IS NULL OR (difficulty >= 0 AND difficulty <= 1));

-- Ranking a workspace's topics by what to spend time on is the query the planner, the tutor and the topic list
-- all make. Importance descending with NULLs last: a topic whose importance has not been computed sorts after
-- every topic whose has, rather than ahead of them the way a NULL would by default in DESC order.
CREATE INDEX IF NOT EXISTS idx_topics_course_importance ON topics(course_id, importance DESC NULLS LAST);

-- No vector index. pgvector's HNSW still caps at 2,000 dimensions and the model emits 2,048, so this column is
-- searched exactly, exactly as `chunks.embedding` has been since V7. A workspace has tens of topics, not
-- thousands of chunks, so an exact scan over them is the cheaper half of any query that touches both.

-- What the learner should be able to do with a topic, stated once per source that says so.
--
-- The objectives already in this schema are attached to the wrong things to be usable: `syllabus_units`
-- holds a JSONB array per week with no topic behind any entry, and `curriculum_lessons.objective` holds one
-- sentence per generated lesson. Neither can answer "what does knowing this topic mean", which is the question
-- assessment has to generate against and mastery has to be measured against.
--
-- `source_kind` says where the statement came from, and it is the difference between an objective the instructor
-- wrote and one StudyOS derived: SYLLABUS is the syllabus's own words, MATERIAL is an objective sentence found in
-- the course material, CURRICULUM is a generated lesson's objective. A reader can weigh them differently; a
-- grader can be told to prefer the instructor's.
CREATE TABLE IF NOT EXISTS topic_objectives (
    id UUID PRIMARY KEY,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    statement TEXT NOT NULL,
    normalized_statement TEXT NOT NULL,
    cognitive_level SMALLINT,
    source_kind VARCHAR(30) NOT NULL,
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    source_chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL,
    section_path TEXT,
    page_start INTEGER,
    page_end INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT topic_objectives_source CHECK (source_kind IN ('SYLLABUS', 'MATERIAL', 'CURRICULUM')),
    CONSTRAINT topic_objectives_level CHECK (cognitive_level IS NULL OR (cognitive_level BETWEEN 1 AND 6)),
    CONSTRAINT topic_objectives_identity UNIQUE (course_id, topic_id, normalized_statement)
);
CREATE INDEX IF NOT EXISTS idx_topic_objectives_topic ON topic_objectives(topic_id, cognitive_level);
CREATE INDEX IF NOT EXISTS idx_topic_objectives_course ON topic_objectives(course_id, source_kind);

-- Pre-existing rows: every topic keeps its name, description and every row that references it. All five new
-- columns start NULL, which reads as "this workspace's topic model has not been computed yet" — distinct from a
-- topic measured as unimportant, which reads as 0. Nothing is backfilled here because backfilling would mean
-- computing the figures in SQL that `TopicModel` computes in Java, and two implementations of one measurement
-- disagree eventually. `POST /api/courses/{courseId}/topics/model/rebuild` computes them for an existing
-- workspace, and document processing computes them from then on.
