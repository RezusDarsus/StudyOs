# real-world-benchmark-100.mjs — harness notes

Live-API benchmark runner for the frozen 100-case Copilot quality baseline
(`benchmark-fixtures/frozen-100.json`, SHA-256 verified against
`benchmark-fixtures/frozen-100.sha256` before anything runs). Plain ESM, run
with node; scoring lives in `benchmark-scorer-100.mjs` and is untouched here.

```
BENCHMARK_API=http://127.0.0.1:4000/api node scripts/real-world-benchmark-100.mjs [flags]
```

## Flags

| Flag | Behaviour |
|---|---|
| *(none)* | Full 100-case run into a fresh `benchmark-results/100-case-baseline-<timestamp>/`. |
| `--cases 12,18,41` | Run only those fixture ids (sorted, deduped). The full fixture is still SHA-verified; artifacts are marked as a **partial run** (`partialRun`, `selectedCases` in summary.json; `N/100` denominators in report.md say "partial run of 100"). New timestamped dir, as usual. Ids outside 1–100 abort before any API call. |
| `--resume <dir>` | Resume an interrupted run from its artifact directory. Finalized cases are carried verbatim; transport-failed and never-run cases are rerun on a fresh disposable account. Combined artifacts are written back into the **same** directory (one canonical artifact set per run id). |
| `--resume <dir> --cases 12,18` | Rerun only the intersection of the dir's rerunnable cases and the selection; the combined artifact covers **exactly the selected ids** (finalized selected cases carried verbatim, the rest rerun). |
| `--help` | Usage text + `parseRunnerArgs` self-test (16 checks), exit 0, no API call, no fixture access. |

## Adaptive provider backoff (per HTTP call, still max 2 attempts)

| Trigger | Wait before the single retry |
|---|---|
| 5xx with `body.code === 'AI_RATE_LIMIT'` | **45 s** (`RATE_LIMIT_RETRY_DELAY_MS`) |
| Other 5xx (`AI_TIMEOUT`, `AI_PROVIDER`, `AI_UNAVAILABLE`) and network errors/timeouts | **20 s** (`RETRY_DELAY_MS`) |
| Response carries a numeric `Retry-After` header (seconds) | `max(Retry-After, base delay)`, capped at **120 s** (`RETRY_DELAY_CAP_MS`) |

Every `retryLog` entry (summary.json → `retries`) now records `delayMs`; entries
that honored a `Retry-After` header also record `retryAfterSeconds`. Summary
additions: `providerRetryCount` (total retries this invocation),
`totalRetryDelayMs`, `retryAfterRespectedCount`, `maxRetriesPerCase` (max
per-case `retries` across the combined result set, so resume counts survive).

## Resume validation rules (all abort with exit 2, nothing is combined silently)

1. `<dir>/raw-results.json` must exist (the incremental checkpoint the run loop
   rewrites after every case). Missing file → "not a benchmark results directory".
2. The file must parse as JSON; a parse failure aborts (never combine a corrupt
   checkpoint).
3. It must be a baseline checkpoint (`benchmark` marker + `results` array), and
   its recorded `fixtureSha256` must equal the frozen fixture's SHA-256 as
   computed now — a mismatch aborts loudly (never combine fixture versions).
4. Every recorded result must have a valid unique case id within 1–100; anything
   else is treated as corruption and aborts.

### What is carried vs rerun

- **Carried verbatim** (kept byte-for-byte in the combined output): cases with
  `transportSuccess === true`, any scored draft, a `NOT_READY` ending, or a
  finalized `SCHEMA_INVALID` failure whose error carries the API's
  `DRAFT_INVALID` code (see `isFinalizedResult()`).
- **Rerun** (fresh disposable account; the partial run's sessions/drafts were
  already discarded by the per-case cleanup): transport-class failures —
  `PROVIDER` / `TRANSPORT` criticals, non-200 start/answer errors — and cases
  the partial run never reached.

A resume plan is printed before anything runs: `N carried verbatim, M to rerun`
plus the rerun case ids. If there is nothing to rerun, no account is registered
and no API call is made; the combined artifacts are simply rewritten.

## Artifacts

`raw-results.json` (incremental checkpoint, updated in place on resume),
`summary.json`, `transcripts.json`, `drafts.json`, `report.md`, `failures.md`,
plus copies of `frozen-100.json` / `frozen-100.sha256`. All final artifacts are
regenerated from the combined result set, deterministically ordered by case id.
Exit code: 0 when every executed case passes the hard gate, 1 otherwise, 2 on
any harness/validation abort.
