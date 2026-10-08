# StudyOS

StudyOS is an AI learning system that knows the course, knows the student, and controls the difficulty over time. It is not trying to answer general questions better than a chat assistant — it is trying to work out what you should learn next. It stores workspaces, chats, messages, source provenance, extracted sections, evidence chunks, embeddings, topics, curricula, mastery evidence, learning events, and study plans in PostgreSQL.

It runs in two modes:

- **Self-directed learning.** State a goal and StudyOS builds the path: goal → curriculum → modules → lessons → exercises → assessments → mastery. What comes next changes on its own — up through the levels when the work is easy, and back through a different explanation, a simpler example and a guided attempt when it is not.
- **A course you are taking.** Upload the syllabus, lectures, homework, exercises and past exams. StudyOS builds a model of that course, organised the way it is taught, and teaches from your own material with citations.

Every chat in a workspace — main tutor, homework help, one week's deep dive, exam preparation — shares the same student and course memory, so a mistake made in one is known to the others.

## Run locally

Prerequisites:

- Java 21
- Docker Desktop
- The bundled Maven and Node runtimes in `tools`
- NVIDIA API credentials configured as Windows user environment variables

From `C:\Users\rezus\Desktop\problem`:

```powershell
.\configure-nvidia.ps1
.\run-backend.ps1
```

Open [http://localhost:8081/](http://localhost:8081/). The backend serves the frontend and exposes the API under `/api`, on the same origin — the frontend calls whatever host served it, so changing the port needs no client change.

The port is `8081` because Goalify's web container already publishes `8080` on this machine. Override it with the `STUDYOS_PORT` user environment variable if 8081 is taken too. StudyOS's PostgreSQL uses `5432`; Goalify's is on `5433`, so the two do not collide.

API documentation is available at [Swagger UI](http://localhost:8081/swagger-ui.html) and [OpenAPI JSON](http://localhost:8081/v3/api-docs).

## Active AI models

- Chat: `nvidia/nemotron-3-super-120b-a12b`
- Embeddings: `nvidia/nemotron-3-embed-1b` with 2,048 dimensions
- Vector storage: PostgreSQL with pgvector
- Retrieval: PostgreSQL full-text search fused with exact cosine vector search using reciprocal-rank fusion

API keys are read from Windows user environment variables and are never stored in source files or logged.

## Implemented product paths

- Create and switch typed learning workspaces with optional Goalify goal linkage, objectives, targets, and exam dates
- Several named chats per workspace, each saying what it is for — main tutor, homework help, a week's deep dive, exam preparation, difficult exercises, questions during a lecture — all reading and writing one shared course and student memory, with messages and history persisted per thread
- Upload and delete PDF, TXT, and Markdown sources, or add pasted text
- Asynchronous extraction, provenance, structure-aware chunking, embeddings, and optional topic extraction
- Source-scoped hybrid retrieval for chat context
- Compact ASCII graph diagrams in monospaced AI responses
- Knowledge map with topic mastery and confidence
- Learning history from recorded study events
- Study plans generated from evidence, mastery, confidence, and review due dates
- Explainable readiness/risk predictions with component breakdowns and fastest improvements
- Evidence-grounded exercises, hint ladders, structured grading, adaptive difficulty, and misconception follow-ups
- Deterministic study sessions, direct Goalify task deep links, and mastery-before/after summaries
- Syllabus, homework, assignment, quiz, and past-exam extraction with automatic source classification
- Evidence-backed exam predictions, verified novel exercises, and adaptive mock exams
- Goalify activation, recommendation/task-link, completion, Copilot-routing, and privacy-safe social-progress contracts
- Permanent retrieval, grading, exercise-novelty, planner, readiness, and goal-classification quality harnesses

### The learning engine

- A learning path built from a goal or a syllabus: modules and lessons in real prerequisite order, with a frontier that shows what is unlocked, what is blocking the rest, and how much is covered
- Lessons that teach — intuition, then the precise statement, then a worked example, then checks — written from your own uploads with citations, and honest about it when the uploads do not cover the lesson yet
- Six cognitive levels per topic, from recall to novel exam-level, with promotion on repeated success
- Repeated failure at an applied level drops to a diagnostic, teaches the prerequisite the diagnostic exposes, and returns to the level that was failing
- Seven activity kinds from practice to final assessment, each with its own support rules and evidence weight; higher-stakes results count for more
- Support released one rung at a time — conceptual direction, the relevant rule, the first step, a partial solution — with the full answer withheld until the ladder is exhausted
- A tutor session for today: an ordered sequence with per-step minutes and the readiness shift it is expected to produce
- A long-term learner profile: what is working, what is at risk, and how you study

The Java/Spring implementation is in [backend](C:\Users\rezus\Desktop\problem\backend), with PostgreSQL setup in `backend\docker-compose.yml`.

Phase 3 audit findings and the compatibility strategy are in `backend/docs/phase-3-audit.md`. The completed milestone and acceptance-flow map is in `backend/docs/phase-3-implementation-status.md`. New Goalify integrations should follow `backend/docs/goalify-studyos-api-contract.md` and use `/api/workspaces`; `/api/courses` remains a compatibility surface.
