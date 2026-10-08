-- Document structure: the outline a document actually has, instead of one pseudo-section per page.
--
-- `document_sections` has carried `parent_section_id`, `level`, and `ordinal` since V1, but ingestion filled it
-- with one flat row per page — "Page 7", level 1, no parent — and threw the document's real outline away. That
-- outline was walked while chunking and survived only collapsed into `chunks.context_header`, so nothing
-- downstream could ask what chapter a passage was in or what a section as a whole said. Ingestion now writes the
-- tree it walks, and these two columns are what a stored section still lacked: its rendered trail, and the size
-- of the text directly under it.
ALTER TABLE document_sections ADD COLUMN IF NOT EXISTS path TEXT;
ALTER TABLE document_sections ADD COLUMN IF NOT EXISTS token_count INTEGER;

-- A summary of a section could not say which section it summarised. `SummaryService` has always passed a section
-- id into its insert and the column to hold it never existed, so every one was silently dropped. Summaries are
-- composed from the section tree now, so the link has to be real.
ALTER TABLE summary_nodes ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES document_sections(id) ON DELETE SET NULL;

-- Reading a document's tree is always "its sections in document order"; walking it is always "the children of
-- this section". The chunk index is for going the other way — which section a retrieved passage belongs to.
CREATE INDEX IF NOT EXISTS idx_document_sections_document_ordinal ON document_sections(document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_document_sections_parent ON document_sections(parent_section_id);
CREATE INDEX IF NOT EXISTS idx_chunks_section ON chunks(section_id);
CREATE INDEX IF NOT EXISTS idx_summary_nodes_section ON summary_nodes(section_id);

-- Rows written before this migration keep everything they have: the page-per-section rows stay, with a NULL path
-- and a NULL token count, and their chunks stay bound to them. `path IS NULL` is what tells the two apart. A
-- document structured by this version stores a rendered trail on every one of its sections — the empty string on
-- the level-0 root, because a document is not one of its own sections — so a NULL path means "this document's
-- structure has not been derived yet" and never "this section has no heading". Re-processing a document rebuilds
-- it, and `POST /api/courses/{courseId}/documents/{documentId}/restructure` rebuilds one from the file already
-- stored for it, rebinding its chunks without re-embedding anything.
