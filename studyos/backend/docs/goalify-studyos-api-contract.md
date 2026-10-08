# Goalify → StudyOS API contract (foundation v1)

The public aggregate is a learning workspace. Goalify owns goals, schedules, task completion, reminders, streaks, rewards, and social state. StudyOS owns sources, learning evidence, learner state, assessment, and recommendations.

## Workspace lifecycle

- `POST /api/workspaces` — create a workspace, optionally linked with `goalifyGoalId`.
- `GET /api/workspaces?userId=&status=` — list workspaces.
- `GET /api/workspaces/{workspaceId}` — fetch setup and linkage metadata.
- `PATCH /api/workspaces/{workspaceId}` — update title, objective, dates, type, or lifecycle status.

Workspace types are `COURSE`, `EXAM`, `CERTIFICATION`, `SKILL`, `LANGUAGE`, `SELF_STUDY`, and `OTHER`. An exam date is optional for every workspace.

## Source operations

- `POST /api/workspaces/{workspaceId}/sources` (`multipart/form-data`) — queue PDF, TXT, or Markdown ingestion.
- `POST /api/workspaces/{workspaceId}/sources/text` — queue pasted text ingestion.
- `GET /api/workspaces/{workspaceId}/sources` — list processing state and provenance metadata.
- `DELETE /api/workspaces/{workspaceId}/sources/{sourceId}` — delete a source and derived data.

Uploads return `202 Accepted`. Goalify must poll source status rather than block navigation.

## Learning intelligence

- `POST /api/workspaces/{workspaceId}/chats/{chatId}/messages` — source-grounded ask/explain interaction.
- `GET /api/workspaces/{workspaceId}/topics` — knowledge map.
- `GET /api/workspaces/{workspaceId}/topic-capsules/{topicId}` — compact topic state and evidence.
- `GET /api/workspaces/{workspaceId}/mastery` — deterministic mastery and confidence.
- `GET /api/workspaces/{workspaceId}/misconceptions` — private active misconceptions.
- `GET /api/workspaces/{workspaceId}/predictions` — readiness and risk forecast.
- `GET /api/workspaces/{workspaceId}/exam-analysis` — evidence-based topic relevance.
- `POST /api/workspaces/{workspaceId}/study-plans/generate` — deterministic daily recommendations.
- `GET /api/workspaces/{workspaceId}/study-plan` — current recommendations.
- `GET /api/workspaces/{workspaceId}/study-tasks/{taskId}` — task rationale, sources, expected outcome, and activity details.
- `POST /api/workspaces/{workspaceId}/quiz` — grounded adaptive exercise generation.
- `POST /api/workspaces/{workspaceId}/quiz/{exerciseId}/support` — support ladder from hints through worked solution.
- `POST /api/workspaces/{workspaceId}/quiz/{exerciseId}/attempts` — structured grading and mastery evidence.
- `POST /api/workspaces/{workspaceId}/sessions` — open a contextual session, optionally for a linked task.
- `POST /api/workspaces/{workspaceId}/sessions/{sessionId}/complete` — summarize evidence and finish the linked task.
- `GET /api/workspaces/{workspaceId}/learner-state` — private mastery, retention, misconceptions, history, and preferences.
- `GET /api/workspaces/{workspaceId}/exam-predictions` — supported likely topics and question structures.
- `POST /api/workspaces/{workspaceId}/mock-exams` — create an adaptive mock exam.

## Goalify integration operations

- `POST /api/integrations/goalify/detect-learning-goal` — classify whether StudyOS activation should be offered.
- `POST /api/integrations/goalify/activate` — opt in and create/link the learning workspace; declining is a normal result.
- `GET /api/integrations/goalify/workspaces/{workspaceId}/recommendations` — return Goalify-ready study tasks with rationale and deep links.
- `POST /api/integrations/goalify/workspaces/{workspaceId}/task-links` — persist the Goalify goal/task mapping.
- `POST /api/integrations/goalify/workspaces/{workspaceId}/task-completions/{studyTaskId}` — synchronize completion without inventing mastery evidence.
- `GET /api/integrations/goalify/workspaces/{workspaceId}/social-progress` — expose aggregate counts/minutes/timestamps only.
- `POST /api/integrations/goalify/copilot/route` — route Copilot to StudyOS only for a selected learning workspace.

Recommendation deep links use `/?workspace={workspaceId}&task={studyTaskId}`. StudyOS opens the linked session context directly.

## Compatibility

Existing `/api/courses` routes remain available during migration. New Goalify code must use `/api/workspaces`; it must not manipulate StudyOS tables directly. `courseId` may still appear as an internal Java/SQL variable during the compatibility period and is not part of the new public vocabulary.
