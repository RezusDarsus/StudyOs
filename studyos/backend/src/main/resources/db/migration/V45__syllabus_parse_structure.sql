-- Structured syllabus parsing: ordinals, unit dates, per-unit assignments, parse confidence and
-- source grounding for every extracted item. week_number stays for week-based units; ordinal is
-- the generic position for Module/Lecture/Table/Date-range units.

ALTER TABLE syllabus_units ADD COLUMN IF NOT EXISTS ordinal INTEGER;
ALTER TABLE syllabus_units ADD COLUMN IF NOT EXISTS unit_date DATE;
ALTER TABLE syllabus_units ADD COLUMN IF NOT EXISTS assignments JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE syllabus_units ADD COLUMN IF NOT EXISTS parse_confidence VARCHAR(10);
ALTER TABLE syllabus_units ADD COLUMN IF NOT EXISTS source_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE syllabus_assessments ADD COLUMN IF NOT EXISTS parse_confidence VARCHAR(10);
ALTER TABLE syllabus_assessments ADD COLUMN IF NOT EXISTS source_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
