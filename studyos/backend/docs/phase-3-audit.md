# Phase 3 StudyOS audit

Audited against the Phase 3 product brief on 2026-08-21. The baseline test suite passed 121 tests before Phase 3 foundation changes.

## Working

- Asynchronous PDF ingestion with stored originals, SHA-256 hashes, page provenance, extraction validation, structure-aware chunks, embeddings, and visible processing states.
- PostgreSQL and pgvector persistence with lexical/vector reciprocal-rank fusion and a retrieval benchmark endpoint.
- Source-grounded chat with citations, bounded context, semantic answer packets/cache, generation scopes, and cross-chat memory episodes/summaries.
- Topic extraction, alias/canonical-name storage, populated typed relations, knowledge-map API, and persisted topic capsules.
- Deterministic mastery and retention models with confidence, learning events/evidence, active misconception views, and prerequisite-aware planning.
- Assessment extraction, exam-topic signals, evidence-aware prediction safeguards, readiness/risk forecasting, and deterministic study plans.
- Provider selection behind `AiGateway`, generation policies, token/cost telemetry, embedding cache, and model-routing fixtures.
- Permanent unit fixtures for retrieval fusion, grading-related validation, mastery, topic relations, memory, planner priority, prerequisites, and time allocation.

## Partial

- `courses` is the physical aggregate table and `course_id` remains the internal foreign-key name. Phase 3 now exposes a `LearningWorkspace` facade and workspace routes without a risky table rewrite.
- Source classification exists as `DocumentType` and drives assessment extraction, but selection is supplied by the caller; automatic source-type inference is not implemented.
- PDF, TXT, Markdown, and pasted text are accepted. Markdown is preserved as source text, but there is no dedicated heading parser beyond the shared chunker.
- Topic canonicalization has normalized names and aliases, but embedding-similarity merge plus LLM confirmation is incomplete.
- Misconceptions, assessments, attempts, and mastery evidence exist, but the full hint-ladder/exercise-attempt experience is not exposed in the current UI.
- Exam analysis and prediction guardrails exist; historical holdout evaluation is not yet a repeatable automated benchmark.
- Topic capsules and summary hierarchy exist; a complete user-facing “What StudyOS knows” correction screen does not.
- Study tasks contain action, duration, priority, reason, and reason codes, but source references, expected outcomes, and direct task-to-session deep links are incomplete.

## Unused or not productized

- Retrieval debugging, benchmark, model-routing, cache, and rebuild endpoints are operational tooling and are not exposed in the main UI.
- Several backend capabilities (topic capsules, assessments, misconceptions) have APIs but no dedicated frontend view.

## Broken or misleading at audit time

- Workspace creation was course-only and required the legacy `/api/courses` representation.
- The UI described every project as a course even when the intended subject could be a skill, language, certification, or self-study curriculum.
- Upload validation rejected every first-priority source format except PDF.
- The frontend hard-coded an exam-oriented default and had no objective/type/deadline setup controls.
- The README claimed only PDF support even though Phase 3 prioritizes text and Markdown too.

## Duplicate or compatibility debt

- `/api/courses/{courseId}/study-plan` and `/api/courses/{courseId}/study-plans/generate` overlap conceptually.
- `LearningEvent`, mastery evidence, and attempt evidence overlap in naming and need a single public `LearningEvidence` contract while retaining specialized internal records.
- Legacy course routes remain intentionally as compatibility aliases. New integrations should use `/api/workspaces`.

## Foundation decision

Keep `courses` and `course_id` as physical names for now. Renaming every foreign key would add migration risk without product value. Treat `LearningWorkspace` as the public aggregate, add the missing metadata to the existing row, and expose all capabilities through workspace-scoped routes. Remove legacy naming only in a separately versioned migration after Goalify and existing clients have moved.
