# Phase 3 implementation status

Updated 2026-08-25 after the learning-engine, lesson-content, and workspace-chats passes. The original audit is preserved in `phase-3-audit.md`; this file records the implemented state after closing its gaps.

Verified state: 318 Java tests pass, and the prompt-routing matrix reports `total=41 matched=41 knownGaps=0` — every tracked student phrasing reaches the handler that can answer it.

## Milestones 1–45

| # | Milestone | Implemented result |
|---:|---|---|
| 1 | Audit | Working, partial, unused, broken, and duplicate paths documented before changes. |
| 2 | Learning Workspace | Public workspace aggregate, types, objectives, lifecycle, target/exam dates, and legacy course compatibility. |
| 3 | Goalify contract | Versioned workspace, source, intelligence, session, and integration contract. |
| 4 | Goal activation | Learning-goal detection plus optional activate/decline and Goalify goal linkage. |
| 5 | PDF/text ingestion | Asynchronous PDF, TXT, Markdown, and pasted-text storage, hashes, extraction, provenance, stages, and failure states. |
| 6 | Source classification | Explicit labels remain authoritative; unlabeled sources receive deterministic type/confidence/reason metadata. |
| 7 | Retrieval benchmark | 50 permanent cases with Recall@5/10, MRR, context precision, and citation correctness. |
| 8 | Reranking | Lexical/vector fusion followed by provider-backed reranking with lexical fallback. |
| 9 | Topic extraction | Local academic patterns and headings plus grounded structured AI enrichment. |
| 10 | Topic canonicalization | Normalized canonical names, aliases, acronym expansion, and AI-confirmed alias output prevent duplicate learner states. |
| 11 | Topic relations | Provenance-preserving prerequisite, part-of, related, and builds-on edges. |
| 12 | Topic capsules | Cached summaries, prerequisites, sources, assessment patterns, mastery, retention, and misconceptions. |
| 13 | Knowledge map | Workspace API and responsive UI with mastery/confidence and weak-topic actions. |
| 14 | Chat modes | Explain, Teach Me, Quiz, Exercise, Review, Summarize, and Exam Prep with depth controls. |
| 15 | Exercise generator | Grounded answer types, source basis, difficulty, modes, and three-level hints. |
| 16 | Novelty verifier | Deterministic near-copy filter followed by an independent adversarial AI verifier before persistence. |
| 17 | Structured grading | Correct/partial/incorrect, score, feedback, error type, misconception, and mastery delta. |
| 18 | LearningEvidence | Attempts and events persist evidence impacts; mere activity never raises mastery. |
| 19 | Misconceptions | Detected, reinforced, improving, resolved lifecycle with learner correction. |
| 20 | Mastery updates | Evidence-weighted deterministic updates persisted before/after. |
| 21 | Confidence | Evidence-count and source-strength confidence exposed with mastery. |
| 22 | Retention | Time-based retention estimate, review due dates, and risk. |
| 23 | Spaced review | Planner prioritizes due/at-risk topics and emits review activities. |
| 24 | Memory compaction | Message history, episodes, summaries, retrieval ranking, and bounded chat context. |
| 25 | Syllabus extraction | Structured units, topics, objectives, readings, dates, weights, and exam-date propagation. |
| 26 | Homework extraction | Individual assessment items retain type, points, difficulty, topic, and source provenance. |
| 27 | Past-exam extraction | Question structure, topic, difficulty, marks, year/source context, and embeddings. |
| 28 | Exam relevance | Deterministic multi-signal relevance and evidence confidence. |
| 29 | Prediction pipeline | Evidence thresholds, insufficient-evidence states, confidence, and fastest improvements. |
| 30 | Prediction UI | Likely topics/structures show status, confidence, why, and source evidence. |
| 31 | Mock exams | Adaptive topic mix, generated questions, start/grade/complete lifecycle, score, and evidence return. |
| 32 | Readiness | Deterministic mastery, priority-topic, coverage, retention, and misconception model. |
| 33 | Readiness breakdown | Private learner-state UI exposes every component and correction controls. |
| 34 | Adaptive planner | Deterministic priority, prerequisites, time allocation, and learner-state refresh. |
| 35 | Why this task | Reason codes, plain-language rationale, sources, expected outcome, difficulty, and activity. |
| 36 | Goalify tasks | Recommendation envelope maps study tasks to Goalify payloads and deep links. |
| 37 | Direct opening | `workspace` + `task` deep links open the exact StudyOS session context. |
| 38 | Study sessions | Start/list/get/complete session lifecycle, timer, exercise, hint ladder, and follow-up UI. |
| 39 | Assessment return | Session attempts update evidence/mastery; completion summarizes before/after and refreshes the next plan. |
| 40 | Copilot | Context router distinguishes a selected learning workspace from general goals. |
| 41 | Privacy | Social progress contains aggregate counts/minutes/timestamps only; private learner state stays in StudyOS. |
| 42 | Quality harnesses | Deterministic retrieval, grading, exercise, planner, readiness, and goal-classification fixtures. |
| 43 | End-to-end testing | Acceptance surfaces covered by 318 Java tests, JavaScript syntax validation, desktop/mobile browser navigation, modal, and responsive checks. |
| 44 | Performance profiling | Bounded retrieval/context, batched ingestion/embeddings, capped generators, cached embeddings/capsules, and measured build/test duration. |
| 45 | Production hardening | Queue backpressure, correct vector dimensions, PATCH CORS, integration validation, novelty score clamping, compatibility aliases, and privacy tests. |

## The learning engine

Milestones 1–45 gave StudyOS evidence about a student. This pass turned that evidence into control over what the student does next. Five systems share one workspace memory, so a failure recorded in a homework chat is known to the exam-preparation chat.

| System | Where it lives | What it decides |
|---|---|---|
| Curriculum graph | `curriculum.CurriculumGraph`, `curriculum.CurriculumService` | Goal → modules → lessons in prerequisite order. A lesson unlocks only when what it depends on is actually held; `frontier` reports what is unlocked, what is blocking the rest, and coverage. |
| Mastery engine | `mastery.MasteryService`, `mastery.BetaEvidenceModel`, `mastery.RetentionModel` | Per-topic mastery, confidence from evidence strength, decay since last practice, and open misconceptions. |
| Adaptive difficulty | `adaptive.DifficultyLadder`, `adaptive.CognitiveLevel`, `adaptive.CognitiveLadderService` | Six levels — recall, understand, apply, analyse, combine, novel/exam-level — with promotion on repeated success. Repeated failure at an applied level does not produce a harder problem: it emits `DIAGNOSE`, then `REMEDIATE_PREREQUISITE` when the diagnostic also fails, then `RESUME_AFTER_DIAGNOSTIC` back to the level that was failing. |
| Exercise and assessment engine | `assessment.ActivityKind`, `assessment.HintLadder`, `assessment.QuizService`, `assessment.MockExamService` | Seven activity kinds from practice to final assessment, each with its own support rules and evidence weight. Answers are never revealed on request: support is released one rung at a time — conceptual direction, the relevant rule, the first step, a partial solution — and the full solution only after the ladder is exhausted. |
| Long-term student model | `learner.LearnerProfiler`, `learner.LearnerProfileService` | Traits computed from the whole learning record: what is working, what is at risk, and how this student studies. |

Tutor mode (`tutor.TutorSessionPlanner`, `tutor.TutorService`) turns all five into one ordered sitting. `GET …/tutor/today` returns the session — minutes, an ordered step list drawn from eleven step kinds, and the readiness shift the sequence is expected to produce — and `POST …/tutor/sessions` starts it, advancing step by step and returning evidence as it goes.

Every one of these has a pure deterministic core with no database and no AI provider, paired with a thin service that does the I/O. The rules are unit-tested on their own; the shell is what talks to PostgreSQL.

## Lesson content

A lesson in the learning path is a promise that something will be taught. `curriculum.LessonBriefComposer` writes it and `curriculum.LessonBriefService` supplies the material, in the fixed order that makes teaching work: plain intuition, the idea stated precisely, one worked example, then questions that check it landed — followed by what this student in particular has already got wrong.

| Endpoint | Behaviour |
|---|---|
| `GET …/curriculum/lessons/{lessonId}/brief` | The lesson, written from retrieved material on first open and cached in `curriculum_lesson_briefs` after that. |
| `POST …/curriculum/lessons/{lessonId}/brief` | Rewrites it — what a student wants after uploading the notes it was missing. |
| `GET …/curriculum/lessons/{lessonId}/brief/text` | The same lesson as plain markdown, for reading in one piece. |

Content is reported honestly through `curriculum_lessons.content_status`:

- `READY` — intuition, precise statement, worked example, and checks are all present.
- `PARTIAL` — something usable exists; `missing` names each gap, and the UI offers to rewrite the lesson from the material.
- `PENDING` — nothing in the uploads supports the lesson. The request returns 409 with the reason, naming the lesson so the student knows what to upload. It never opens with invented prose.

When no draft is available the fallback surfaces the student's own top excerpt with its citation rather than generating a substitute. Check answers are returned separately from questions so the UI can keep them behind a click.

Briefs are stored as JSON, not ingested as documents. `retrieval.HybridRetriever` also excludes `GENERATED_LESSON` documents from both its lexical and dense arms: material StudyOS wrote must never come back as evidence, or each generation would cite the last and drift a little further from the course.

## Chats in a workspace

A workspace holds as many chats as the student wants — a main tutor thread, homework help, one week's deep dive, exam preparation, difficult exercises, questions asked during a lecture. They are threads, not modes: all of them read and write the same course model and the same learner state, so an exercise failed in the homework chat lowers the mastery the exam-preparation chat plans around.

What a chat is for is stored on the row (`chats.purpose`, added in `V32__chat_purposes.sql`) and modelled by `chat.ChatPurpose`. It does two things. It names an untitled chat, so a sidebar of them stays readable. And it decides turns that do not say what they want: "another one" in a difficult-exercises chat is a request for another exercise, while the same two words in homework help are a request for help with the next item.

| Endpoint | Behaviour |
|---|---|
| `GET …/chats/purposes` | The purposes a chat can be created with, each with the one line a student picks it by. The client offers exactly what the router understands, so the choices cannot drift from the behaviour. |
| `POST …/chats` | Creates a chat with an optional title and an optional purpose. A missing title becomes the purpose's own name; a missing, blank, or unrecognised purpose becomes `GENERAL`. |
| `GET …/chats` | Every chat in the workspace in recency order, each with its purpose, its label, and how many messages it holds. |

The rule that keeps this safe is deliberately narrow. `chat.QueryRouter.classify(query, context, purpose)` applies the purpose only when two things hold: the ordinary two-argument routing returned `FACTUAL_QA` — its "nothing here matched" bucket — and the turn contains no question mark and does not open with an interrogative. So "I'm stuck", "next", "3b", and a bare topic name get the chat's reading, while "what does this notation mean?" stays a factual question in every chat. `GENERAL` and `MAIN_TUTOR` carry no fallback at all, because a thread that broad makes guessing wrong more often than right. What the conversation already established still outranks the purpose: "another one" after a run of exam questions is an exam prediction wherever it is typed.

`QueryRouterTest` asserts this against every purpose and every phrasing the matrix tracks, so adding a purpose later cannot quietly capture wording that already routes. The prompt-routing matrix is unchanged by the feature: `total=41 matched=41 knownGaps=0`.

A purpose describes how the student is working, never what they are working on. Nothing in `ChatPurpose` names a subject, a concept, or a course, so the same set fits a chemistry course, a contract law course, and a self-taught reading list without change.

## Acceptance-flow mapping

1. Goalify detects “prepare for Distributed Systems,” offers StudyOS, and activation links a workspace only after opt-in.
2. Syllabus, lecture, homework, and past-exam uploads are stored and processed asynchronously with source classification and visible state.
3. Topics, relations, capsules, mastery/confidence, and exam signals populate the knowledge map.
4. The planner selects the highest priority topic from low mastery, exam relevance, retention, misconceptions, and recent errors, then explains why.
5. Goalify receives a 30-minute task payload and its direct StudyOS session link.
6. The session provides a refresher, verified new exercise, progressive hints, structured grading, misconception feedback, and a targeted follow-up.
7. Correct follow-up evidence changes mastery and completing the session refreshes tomorrow's plan.
8. Hard exam-exercise requests use source evidence, deterministic similarity rejection, independent verification, confidence, and citations.
9. A stated goal builds a curriculum whose lessons unlock in prerequisite order, each opening with teaching content written from the student's own uploads or admitting what is missing from them.
10. Repeated failure at an applied level drops to a diagnostic, teaches the prerequisite the diagnostic exposes, and returns to the level that was failing — rather than reissuing a harder problem.
11. Several chats in one workspace — main tutor, homework help, a week's deep dive, exam preparation, difficult exercises, lecture questions — can be created, switched between, and each read on its own terms, while all of them share one course model and one learner state.

## Verification boundary

The repository-level verification is self-contained. A live PostgreSQL/pgvector HTTP smoke test additionally requires Docker Desktop or PostgreSQL with pgvector; neither executable was present on the verification machine. Flyway migrations and the application package compile successfully, and database-dependent contracts are covered by service/controller code plus deterministic tests.
