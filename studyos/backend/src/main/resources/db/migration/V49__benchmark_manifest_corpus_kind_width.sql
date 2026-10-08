-- benchmark-v2 corpora carry longer corpus kinds than the initial width allowed
-- (e.g. REAL_PLUS_SYNTHETIC_MIX); the manifest row must survive an otherwise successful import.

ALTER TABLE prediction_benchmark_manifests ALTER COLUMN corpus_kind TYPE VARCHAR(40);
