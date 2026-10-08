# benchmark-v2 — reproducible prediction-calibration + provider benchmark

Replaces the lost 2026-08-21 benchmark corpus. The old benchmark workspace no longer exists in the
database; its reports under `reports/` are preserved untouched.

## Corpus

`fixtures/` contains 20 documents, all with explicit provenance in `manifest.json`:

| Kind | Count | Label |
|---|---|---|
| Historical exams (PAST_EXAM) | 2 | **REAL** — I2DS24 midterm (2024-04-05), Networking midterm (2025-06-02) |
| Weekly graded exercises (HOMEWORK) | 6 | **REAL** — CNDS 2026 weeks 1–6, dated submission deadlines |
| Lecture notes (LECTURE) | 6 | **REAL** — DS course notes, March–April 2026 |
| Exam-shaped fixtures (PAST_EXAM) | 6 | **SYNTHETIC** — real questions from the corpus assembled into dated exam documents (2026-05…07), each marked SYNTHETIC inside the file |

**Honesty rule:** the synthetic exams exist so a multi-fold walk-forward is possible at all.
Metrics from this corpus validate the prediction pipeline (folds, isolation, baselines,
calibration machinery). They are **not** real-world predictive accuracy and must never be
reported as such.

The importer is subject-neutral: it ingests whatever documents a corpus contains through the
ordinary pipeline. This corpus happens to be networking.

## Running

```bash
# prediction calibration (import + walk-forward backtest + persisted report)
node run-prediction-benchmark.mjs --base http://localhost:8081

# with a provider smoke (first N prompts through the chat API)
node run-prediction-benchmark.mjs --prompts 6
```

The runner:

1. verifies every fixture and computes the corpus SHA-256;
2. imports the corpus via `POST /api/prediction-benchmark/import` (idempotent per hash);
3. runs `GET /api/workspaces/{id}/exam-predictions/backtest?fixtureHash=...`;
4. optionally sends prompts through the chat API and records transport success/latency;
5. writes `reports/benchmark-v2-prediction-<timestamp>.json` — timestamped, never overwrites.

## What a report contains

- corpus hash + per-fixture hashes (reproducibility)
- backtest: per-fold and aggregate P@3/P@5, R@3/R@5, MRR, NDCG@5, NDCG@10, Spearman, Brier
- baseline comparison (FREQUENCY / RECENCY / IMPORTANCE vs EXAM_TOPIC_V1)
- calibration buckets with sample counts, drift, style signals, error categories
- fitting-policy verdict (when weights may change)
- provider smoke: transport success, latency, statuses
