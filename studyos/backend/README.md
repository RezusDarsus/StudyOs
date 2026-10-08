# StudyOS backend

Spring Boot 3.4 backend for the StudyOS learning workspace.

## Local run

```powershell
docker compose -f backend\docker-compose.yml up -d
tools\maven\bin\mvn.cmd -f backend\pom.xml spring-boot:run
```

The normal launcher is `C:\Users\rezus\Desktop\problem\run-backend.ps1`; it starts PostgreSQL, loads the Windows user environment configuration, applies Flyway migrations, and starts the server on port 8081 (or `STUDYOS_PORT` when set). It refuses to start if that port is held by something that is not StudyOS, rather than reporting a neighbour's app as a running backend.

## Main API areas

- `/api/workspaces` — typed learning workspaces and optional Goalify goal linkage
- `/api/workspaces/{workspaceId}/sources` — asynchronous PDF, TXT, and Markdown ingestion
- `/api/workspaces/{workspaceId}/sources/text` — asynchronous pasted-text ingestion
- `/api/courses/{courseId}/chats` — chats, messages, and source-grounded AI replies
- `/api/courses/{courseId}/documents` — PDF upload, processing status, listing, and deletion
- `/api/courses/{courseId}/topics` — knowledge map data
- `/api/courses/{courseId}/learning-events` — learning history
- `/api/courses/{courseId}/study-plan` — generated daily study plans
- `/api/courses/{courseId}/predictions` — readiness, risk topics, and predicted focus
- `/api/courses/{courseId}/debug/retrieval` — retrieval diagnostics

Swagger UI is available at `http://localhost:8081/swagger-ui.html`; the OpenAPI 3 document is at `http://localhost:8081/v3/api-docs`.

## AI configuration

The active NVIDIA provider uses:

- Chat endpoint: `https://integrate.api.nvidia.com/v1/chat/completions`
- Chat model: `nvidia/nemotron-3-super-120b-a12b`
- Embedding endpoint: `https://integrate.api.nvidia.com/v1/embeddings`
- Embedding model: `nvidia/nemotron-3-embed-1b`

Set `NVIDIA_API_KEY`, `STUDYOS_AI_PROVIDER=nvidia`, `STUDYOS_AI_CHAT_MODEL`, and `STUDYOS_AI_EMBEDDING_MODEL` in the Windows user environment. Never commit the key.

Source processing is asynchronous. Original PDF/TXT/Markdown files and persisted pasted text remain under `backend\data\uploads`, while metadata, provenance, chunks, embeddings, topics, and learning state are stored in PostgreSQL. Legacy `/api/courses` routes remain compatibility aliases.

Chat context is bounded: recent cross-chat memory and learning events are summarized, retrieval selects the highest-ranked source chunks, and the final evidence is capped before it reaches the model. Embeddings are sent in batches of 32. Large or scanned PDFs are marked for OCR instead of being silently treated as readable text.

User searches are embedded with NVIDIA `input_type=query`; stored PDF chunks and memory episodes use `input_type=passage`. Do not merge these paths because `nemotron-3-embed-1b` is asymmetric.

Optimization evidence and provider capability decisions are recorded in `docs/optimization-baseline-2026-08-14.md` and `docs/ai-provider-capabilities.md`. Native JSON-object mode is enabled. JSON-schema decoding and hosted prefix caching are not claimed unless the exact configured endpoint proves support.

Output limits are task-specific. Ordinary chat defaults to 3,200 tokens, while large exercise-prediction requests are sized from the requested count and capped at 8,192. Override the hard ceilings with `STUDYOS_AI_CHAT_MAX_OUTPUT_TOKENS` and `STUDYOS_AI_PREDICTION_MAX_OUTPUT_TOKENS`. Raising a ceiling allows longer answers but can increase latency and provider usage; normal answer length is still controlled by the prompt.
