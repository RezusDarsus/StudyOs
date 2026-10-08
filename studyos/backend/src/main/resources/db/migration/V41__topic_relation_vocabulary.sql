-- The vocabulary a workspace's concept graph is allowed to use, widened from two kinds of edge to five.
--
-- V9 pinned `relation_type` to PREREQUISITE_OF and RELATED_TO. Everything a course said that was not a hard
-- dependency was therefore stored as RELATED_TO, which means no more than "these two were written near each
-- other", and three of the things course material says most often had nowhere to go: that one topic is a piece of
-- another, that one topic is where another is taken further, and that two topics are set against each other.
--
-- Every type is read as the English clause "source <relation_type> target", which is how the two existing types
-- already read and the only convention under which a reader does not have to memorise a direction per type:
--
--   PREREQUISITE_OF  source has to be understood before target.
--   RELATED_TO       the two were written together and nothing stronger was found. Symmetric.
--   PART_OF          source is a component of target — a stage of a process, an element of a rule, a case of a law.
--   BUILDS_ON        source is target taken further. Learning order runs target first, the opposite way round from
--                    PREREQUISITE_OF, which is the price of the clause convention and the reason the view below
--                    exists rather than four hand-written copies of the direction rule.
--   COMPARES_WITH    the two are worth studying against each other, whether they are alike or opposed. Symmetric,
--                    and stored once per pair rather than once per direction.
--
-- PART_OF is deliberately not a learning order. A part is not a prerequisite of its whole: courses introduce the
-- whole first about as often as they build it up from pieces, and counting containment as depth would make every
-- leaf of a well-structured document the hardest topic in the course.
ALTER TABLE topic_edges DROP CONSTRAINT IF EXISTS topic_edges_relation_type_check;
ALTER TABLE topic_edges ADD CONSTRAINT topic_edges_relation_type_check CHECK (relation_type IN ('PREREQUISITE_OF', 'RELATED_TO', 'PART_OF', 'BUILDS_ON', 'COMPARES_WITH'));

-- One definition of "what has to be understood before this", for the four subsystems that ask.
--
-- The planner's prerequisite gap, the cognitive ladder's remediation target, a topic capsule's prerequisite list
-- and the topic model's prerequisite depth all asked `relation_type='PREREQUISITE_OF'` in four separate places.
-- Left that way, BUILDS_ON would be invisible to all four and widening the vocabulary would have quietly dropped
-- edges out of the learning order that used to be in it — the wording "X builds on Y" produced a PREREQUISITE_OF
-- row before this migration. The view swaps BUILDS_ON's endpoints so a caller reads one direction, and the
-- direction rule is stated once, in SQL, where all four of them can only agree with it.
CREATE OR REPLACE VIEW topic_prerequisites AS
SELECT e.id,
       e.course_id,
       CASE WHEN e.relation_type = 'BUILDS_ON' THEN e.target_topic_id ELSE e.source_topic_id END AS prerequisite_topic_id,
       CASE WHEN e.relation_type = 'BUILDS_ON' THEN e.source_topic_id ELSE e.target_topic_id END AS dependent_topic_id,
       e.relation_type,
       e.confidence,
       e.source_chunk_id,
       e.extraction_method,
       e.created_at
FROM topic_edges e
WHERE e.relation_type IN ('PREREQUISITE_OF', 'BUILDS_ON');

-- "What does this topic rest on" is now asked by the ladder on every exercise and by the planner on every topic,
-- and until now it scanned: `uq_topic_edges_identity` leads with `source_topic_id`, so only the other direction
-- was indexed. Five relation types make the table several times larger for the same course.
CREATE INDEX IF NOT EXISTS idx_topic_edges_course_target ON topic_edges(course_id, target_topic_id, relation_type);

-- Pre-existing rows: nothing is rewritten and nothing is deleted. Every stored edge is already one of the two
-- older types, both of which remain valid, so the widened constraint accepts the table as it stands. The new
-- types appear only as documents are processed from here on, or at once for a whole workspace via
-- `POST /api/courses/{courseId}/topics/relations/rebuild`, which re-derives every locally extracted edge.
