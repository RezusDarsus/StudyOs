-- Provenance: which answer said which thing, and which chunk it came from.
--
-- StudyOS already decided this per turn and then threw it away. `CitationAudit`, `GroundingAudit` and
-- `ProvenanceAudit` read every answer against the evidence block it was written from, and their findings went
-- into a note appended to the reply and a telemetry record that lives for the length of one HTTP response.
-- Nothing durable recorded that answer X asserted claim Y on the strength of chunk Z, so nothing could ask the
-- questions that only the record answers: which passages this course's answers actually rest on, which claims
-- rest on nothing, and whether a claim survives the chunk it came from being re-ingested.
--
-- Three tables, in the shape of the question: an answer has claims, a claim has evidence, and every row of it is
-- written by StudyOS from the block it supplied to the model. A chunk id here is one StudyOS put in the prompt;
-- nothing a model returned reaches these tables, because a model naming a chunk id is not evidence that it read
-- that chunk.
CREATE TABLE IF NOT EXISTS answer_provenance (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  intent VARCHAR(40),
  passages_supplied INTEGER,
  chunks_supplied INTEGER,
  claims_classified INTEGER,
  claims_source INTEGER,
  claims_derived INTEGER,
  claims_external INTEGER,
  claims_unjudged INTEGER,
  claims_about_learner INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per sentence of the answer that asserts something about the material, with where it came from:
--   SOURCE   — it cites a passage this turn supplied, and the citation resolves to that passage's pages.
--   DERIVED  — it cites nothing that resolves, but it is written in the vocabulary of a supplied passage.
--   EXTERNAL — neither. The model wrote it out of its own knowledge, which is the class worth counting.
-- `cited` is kept separately from the class on purpose: `cited = true` with class EXTERNAL is a reference that
-- resolved to nothing supplied, which is a fabricated citation and is now a query rather than a log line.
CREATE TABLE IF NOT EXISTS answer_claims (
  id UUID PRIMARY KEY,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  claim TEXT NOT NULL,
  provenance_class VARCHAR(20) NOT NULL,
  cited BOOLEAN NOT NULL,
  support DOUBLE PRECISION,
  CONSTRAINT answer_claims_class CHECK (provenance_class IN ('SOURCE','DERIVED','EXTERNAL')),
  CONSTRAINT answer_claims_ordinal UNIQUE (message_id, ordinal)
);

-- The chunks behind one claim. `chunk_id` is nullable and set null rather than cascaded, because re-processing a
-- document deletes and rewrites its chunks: cascading would erase the record of every answer ever grounded in it,
-- and the document name and page range are what a reader needs to check the claim anyway. A null `chunk_id` with
-- a page range beside it says exactly what happened — the passage was real and no longer exists under that id.
CREATE TABLE IF NOT EXISTS claim_evidence (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES answer_claims(id) ON DELETE CASCADE,
  chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  document_name TEXT,
  section_path TEXT,
  page_start INTEGER,
  page_end INTEGER,
  link_type VARCHAR(20) NOT NULL,
  CONSTRAINT claim_evidence_link CHECK (link_type IN ('CITED','OVERLAP'))
);

-- Reading is always "this answer's claims in the order it made them", "this claim's evidence", or — for the
-- course-wide view — "which chunks are carrying this workspace's answers".
CREATE INDEX IF NOT EXISTS idx_answer_claims_message ON answer_claims(message_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_answer_claims_course_class ON answer_claims(course_id, provenance_class);
CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim ON claim_evidence(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_evidence_chunk ON claim_evidence(chunk_id);
CREATE INDEX IF NOT EXISTS idx_answer_provenance_course ON answer_provenance(course_id, created_at DESC);

-- Answers written before this migration have no rows here at all, and none are backfilled: the evidence block a
-- past turn was given was never stored, so any classification of those claims would be a guess presented as a
-- measurement. From here on every assistant turn writes an `answer_provenance` row, and the nullable counts on it
-- carry the distinction that matters — NULL means "not measured", 0 means "measured, and it was none". A turn
-- whose profile retrieves nothing, and a generated-exercise turn that resolves its own closed source scope
-- elsewhere, both record NULL counts with no claim rows: their answers were not written from this block, so
-- checking them against it would produce a number about the wrong evidence. An ordinary turn that retrieved and
-- matched nothing records 0 supplied passages and real counts, because there the absence is the measurement.
