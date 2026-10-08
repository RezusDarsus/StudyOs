-- Query vectors created before V21 used NVIDIA input_type=passage. They are
-- disposable derived data and must not be compared with corrected query vectors.
DELETE FROM semantic_answer_cache;
