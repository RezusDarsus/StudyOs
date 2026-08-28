# One Up

Turn your goals into fun social challenges.

A social goal, habit, productivity and challenge platform.

**Phase 1** is the whole product with no AI at all. **Phase 2** adds a personalised
Goal Copilot on top. The Copilot only ever *proposes* — every goal is still created
by the same Phase 1 services, and the product remains fully usable with the AI
switched off. **Phase 2.5** makes it deployable: PostgreSQL, durable jobs, scheduled
notifications, realtime push, containers and a hardened proxy.

## Stack

| Layer     | Choice                                                    |
| --------- | --------------------------------------------------------- |
| Frontend  | Vite + React 18 + TypeScript + Tailwind v4 + React Router |
| Backend   | Fastify + TypeScript + Prisma                             |
| Database  | PostgreSQL 18                                             |
| Jobs      | pg-boss — queues and cron live in the same database        |
| Realtime  | Centrifugo v6, private `personal:#<userId>` channels       |
| Packaging | Docker + Compose, nginx serving the built frontend        |
| Tests     | Vitest — a hermetic unit suite and a separate acceptance suite |


The design system is ported from the Figma Make file
(`Social Productivity Platform`) — colours, radii, shadows, typography and the
`card` / `btn-*` / `sidebar-nav-item` / `progress-bar-*` component classes all come
from it. See `apps/web/src/index.css`.

## Getting started

```bash
npm install
```

Copy the two example env files and fill them in — `.env` drives the Docker stack,
`apps/api/.env` drives the API itself. Neither example contains a real secret.

```bash
cp .env.example .env && cp apps/api/.env.example apps/api/.env
```

Start the infrastructure the app needs (PostgreSQL and Centrifugo):

```bash
docker compose up -d
```

Apply migrations and seed a realistic demo world:

```bash
npm run db:deploy --workspace=apps/api && npm run seed --workspace=apps/api
```

Run both servers from source:

```bash
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:4000 (the web dev server proxies `/api` to it)

To run the product the way it is deployed — built images, nginx in front, no dev
server — use the `app` profile instead. It listens on `APP_PORT` (8080 by default)
and can run beside a dev server without either taking the other's ports:

```bash
docker compose --profile app up -d --build
```

### Demo accounts

Password for all of them: `goalify123`

| Email                | Who                                       |
| -------------------- | ----------------------------------------- |
| `kitty@goalify.app`  | The main account — goals, friends, streaks |
| `alex@goalify.app`   | The most consistent friend                 |
| `maria@goalify.app`  | Owns a public challenge                    |
| `luka@goalify.app`   | Has a pending friend request out           |
| `dana@goalify.app`   | Trailing the leaderboard                   |

## Tests

Two suites, deliberately separate.

```bash
npm test
```

The hermetic suite: no database, no network, no containers. Covers recurrence expansion,
daily/average scoring, streak rules, timezone day boundaries and leaderboard ranking,
including the edge cases that are easy to get wrong (rest days, pre-join days,
no-task days, future days, ties) — plus every Phase 2 guard rail and the Phase 2.5
config audit. Runs in seconds and is what you run while working.

```bash
npm run test:acceptance --workspace=apps/api
```

The acceptance suite: the twelve end-to-end claims of Phase 2.5, against a real
server and real PostgreSQL. Needs `docker compose up -d` running. It creates and
uses a **separate** database — whatever `DATABASE_URL` names, suffixed
`_acceptance` — because it truncates every table between tests, and it refuses to
start if the database it connected to does not carry that suffix. Files are named
`*.acceptance.ts`, which matches nothing in Vitest's default `include`, so `npm test`
can never pick them up.

## Architecture notes

### A challenge is just a Goal with more participants

There is no separate `Challenge` entity.

```
Goal + 1 participant       -> a private personal goal
Goal + 4 participants      -> a private friend challenge
Goal (PUBLIC) + N          -> a public challenge
```

Each `GoalParticipant` has entirely independent progress and their own
`TaskOccurrence` rows. Nobody shares completion state.

### TaskDefinition vs TaskOccurrence

A `TaskDefinition` is the *rule* ("Drink 2L of water, every day"). A
`TaskOccurrence` is one dated instance of it, per participant. Completing
19 August never completes 20 August, and the occurrence history is what powers
streaks, statistics and both leaderboards.

Occurrences are generated lazily on read (`ensureOccurrences`), 14 days ahead.
There is no cron job to keep alive, and someone joining mid-challenge immediately
gets their own rows without touching anyone else's.

### One place computes progress

`apps/api/src/domain/scoring.ts` is the single source of truth for today's
percentage, goal progress, streaks and both leaderboards. No frontend component
recomputes any of it, so two screens can never disagree.

### Days and timezones

Every "challenge day" is a `YYYY-MM-DD` string evaluated in **the goal's own
timezone** (defaulting to the creator's). Day arithmetic goes through UTC noon so
a DST shift can never move a date. This is what makes the daily leaderboard reset
unambiguous.

### The two leaderboards

- **Daily** — the current challenge day only. A participant with nothing
  scheduled shows *"No tasks today"*, never `0%`.
- **Average** — the mean of each *finished* eligible day. Today is excluded (that
  is what Daily is for), so nobody is marked down at 09:00 for a task scheduled at
  20:00. Days before joining, days after leaving, days with nothing scheduled and
  future days are all excluded.

Ties break on current streak, then completed eligible tasks, then a stable id — so
a refresh never reshuffles equal rows.

### Streaks

A streak day is one where the participant did everything **required** of them. A
day with nothing scheduled is neutral: it neither extends nor breaks the streak.
An unfinished *today* never breaks a streak either.

### "X times per week" — available vs required

A flexible weekly task ("gym 3x per week") separates two ideas:

- **available** — completable on any day while quota remains
- **required** — counted in that day's denominator only once the remaining days in
  the week no longer exceed the remaining quota

So Monday does not punish you for not having gone yet, and once you have been
three times the rest of the week is free.

### Shareable invite codes

A goal owner can mint an 8-character code (`POST /goals/:id/invite-code`) and hand
the link to **anyone** — Messenger, WhatsApp, a group chat. The recipient does not
need an account or a friendship.

```
/join/:code   GET   unauthenticated preview  -> title, owner, counts only
/join/:code   POST  authenticated            -> joins, gets their own occurrences
```

The code *is* the grant, so it works even for a `PRIVATE` goal. That is safe
because the owner controls it end to end: only the owner can mint it, rotating
replaces it (killing a leaked link), and revoking removes it entirely. The
unauthenticated preview deliberately exposes nothing about participants, progress
or leaderboards. The code alphabet omits `0/O/1/I/L` so it can be read aloud.

A signed-out visitor arriving from a shared link sees the preview, and the code is
held in `sessionStorage` so they land back on it and join in one tap after signing
up.

### Privacy is enforced server-side

`loadGoalForUser` gates every goal-scoped read and write. A private goal returns
**404** (not 403) to a stranger, so the endpoint does not confirm it exists. Private
goals never appear in Discover or another user's profile, and a participant can
only ever complete their own task occurrences.

Sessions are httpOnly cookies; the token is stored as a SHA-256 hash, so a database
leak yields no usable sessions.

## Deliberate deviations from the Figma file

1. **No "Continue with Google" button.** It appears in the mock, but OAuth is not in
   the Phase 1 auth spec and the brief forbids controls that do nothing.
2. **Landing page traction numbers removed.** The mock shows "12,400+ goals
   created" etc. Those are placeholder marketing copy; shipping them would be a
   false factual claim, so the same layout carries honest value props instead.
3. **Home leads with today's tasks.** The mock's dashboard leads with statistics.
   The brief's stated UX principle — answer *"what should I do today?"* before
   *"what statistics do I have?"* — takes precedence, so tasks are completable
   directly from Home.
4. **Public challenge detail is the same screen as goal detail.** A non-participant
   viewing a public goal sees a preview plus **Join Challenge**, rather than a
   separate page, matching the "one Goal system" rule.
5. **`TaskCompletion` collapsed into `TaskOccurrence`.** Status plus `completedAt`
   on the occurrence is the single source of truth; a second table would create a
   second place to compute progress from.

## Bugs found and fixed by self-testing

| Severity | Issue | Fix |
| --- | --- | --- |
| **Security** | `POST /auth/forgot-password` issued a **real session token**. Holding a reset link logged you in, and the endpoint minted a live 30-day session for any account on demand. | Dedicated `PasswordResetToken` model: single-use, 1-hour expiry, not accepted as a session. |
| **Privacy** | `GET /users/:id` returned another user's **email address**, timezone and notification settings. | `publicUser(userId, viewerId)` — private fields only for the account owner. Types split into `PublicProfile` / `CurrentUser` so the client cannot assume they are present. |
| Cosmetic | Seeded reward history showed `+0🪙` for every past task. | Seed records the real per-occurrence reward. |
| Clarity | Shared-goal count used a confusing `every: {}` Prisma clause. | Rewritten as an explicit `AND` of two `some` clauses. |

Checked and found **correct** (not bugs): double-complete and double-undo are
idempotent and do not drift coins (the apparent drift was achievement rewards,
which are intentionally not revoked on undo); completing a future occurrence,
joining a private goal directly, inviting a non-friend, and completing another
participant's task are all refused; a participant who leaves drops off the
leaderboard.

**Known behaviour, not fixed:** rejoining a goal resets `joinedOn` to today, so
the earlier stint's history stops counting. This is a deliberate fresh start (the
away period does not count as misses either), but it does discard prior credit.
Proper multi-stint history would need a join-periods table.

## Phase 2 — Goal Copilot

Set `NVIDIA_API_KEY` in `apps/api/.env` to enable it. Without a key the Copilot
simply does not appear and goal creation stays manual — nothing else changes.

```
AI_PROVIDER=nvidia
AI_BASE_URL=https://integrate.api.nvidia.com/v1
AI_GOAL_COPILOT_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
NVIDIA_API_KEY=...
```

### The AI proposes; the backend decides

```
User -> Copilot interview -> structured AI output -> server validation
     -> GoalDraft -> user review -> user confirms
     -> existing Phase 1 GoalService / TaskDefinition / occurrence generation
```

The model never writes to `Goal` or `TaskDefinition`. It produces a `GoalDraft`,
which is a proposal with no effect on the product until the user presses
**Create Goal**. Confirmation then goes through the same creation path manual
goals use — there is no duplicated creation logic in the AI module.

### Provider abstraction

`GoalCopilotService -> AiChatProvider -> NvidiaAiChatProvider`. Business logic
imports `AiChatProvider` only, so swapping providers is one new class plus a config
change (`src/ai/provider.ts`, `src/ai/nvidia-provider.ts`, `src/ai/client.ts`).

Two model-specific behaviours are handled in the provider, not leaked upward:
reasoning output is disabled for structured calls (it was truncating JSON mid-object)
and any stray `<think>` block is stripped.

### What the backend refuses to trust

| The model says | What actually happens |
| --- | --- |
| `"walk 300 times per week"` | Capped at 7 and logged as an adjustment |
| An invented recurrence type | Rejected — the Phase 1 enum is authoritative |
| A question type like `RENDER_IFRAME` | Rejected — only 7 question types are allowed |
| `reward: 9999` | Ignored — `rewardForTask()` derives reward from effort, so AI goals cannot inflate the leaderboard |
| A deadline in the past | Removed; a `DEADLINE` goal with no date becomes a habit |
| A plan needing 20+ hours a week | Rejected outright |
| A `taskId` that does not exist | That patch operation is skipped |
| `userId` anywhere in its output | Ignored — identity always comes from the session cookie |

Interview length is enforced server-side (2 minimum, ~7 recommended, 10 hard cap),
so a chatty model cannot trap someone in an endless questionnaire.

### Adaptive interview

Questions are chosen one at a time from what is still unknown. The prompt receives
explicit answered question/answer pairs, which is what stops the model re-asking
something in different words. Facts already stated in the opening message are
extracted rather than asked about — say "I hate running" and it never offers running.

Structured context is authoritative and merged by key, so a correction ("actually
I meant swimming") *replaces* the earlier answer instead of both lingering.

### Authority hierarchy

Every context value carries where it came from, and precedence is settled in code
(`src/ai/context.ts`), never by the model:

```
1. the goal itself            immutable once the session starts
2. what the user said         answers + explicit corrections, latest wins
3. session inference          what the model deduced this conversation
4. long-term memory           hints from previous, unrelated goals
5. model inference            its own guess
```

A remembered "likes walking" can never overwrite an answer of "dancing", because
memory sits two tiers below. Answers and explicit corrections share one tier
ordered by recency, which is what makes *"actually, I meant swimming"* work —
ranking answers strictly above messages would have frozen the first answer forever.

Corrections arrive on their own channel. A plain extraction cannot overwrite
something the user said; only a declared correction can.

**Goal intent outranks personalisation.** Preferences change *how* a goal is
pursued, never *what* it is. Someone building a house who mentions they enjoy
dancing gets a house-building plan — dancing is simply irrelevant there. An
earlier prompt rule ("the activity the user named IS the plan") was an
over-correction from the contamination fix and caused exactly that failure; it is
now conditional on relevance to the goal.

### Memory gating

Which memories are visible is decided from the **user's own words**
(`src/ai/category.ts`), never from the category the model reported.

That loop is precisely how the contamination bug ran: the model classified
"I need to build a house" as FITNESS, the gate handed it the fitness memories, and
it produced a walking plan. Asking the model for a category and then using that
category to choose what to show the model lets it talk itself into any memory.

A deterministic keyword classifier reads the goal text. Category-scoped memory is
injected only when that classifier is confident **and** independently agrees with
the model. Otherwise only GLOBAL preferences — the ones that apply broadly — are
used. Durable preferences still require `LONG_TERM` and 0.75 confidence to persist
at all.

Profile → **What the Copilot remembers** lists everything stored, with per-item and
bulk delete.

### Normalise vs reject

Tolerance has a limit. A near-miss is a representation problem and is normalised;
something semantically broken is rejected so the user never silently receives a
plan nobody asked for:

| Input | Outcome |
| --- | --- |
| `8` times per week | normalised to 7 (reads as a twice-daily session) |
| `300` times per week | **rejected** — not a schedule |
| `300` minutes | trimmed to 240 |
| `900` minutes | **rejected** — not a session |
| `"8:00"` | normalised to `08:00` |
| `"in the morning"` | rejected |

A rejected plan gets one corrective regeneration with the reason fed back, the
same treatment malformed JSON gets, rather than dead-ending the user.

### Quality harness

```bash
node apps/api/scripts/copilot-batch.mjs 3
```

Its first version had a **wrong success condition**: "build a house" answered with
"Dance Every Morning" passed, because the only assertion was "mentions dancing".
Personalisation had eaten the goal and the test called it a win. Assertions are now
independent, so one dimension cannot mask another:

| Dimension | Asks |
| --- | --- |
| INTENT | do the *tasks* pursue the goal that was asked for? |
| CONSTRAINT | are stated numbers, dislikes and availability respected? |
| RELEVANCE | is stored memory used only where it serves this goal? |
| QUESTIONS | were the questions relevant, non-redundant, non-duplicated? |
| SAFETY | is anything harmful produced? |
| INTEGRITY | is session context free of memory and unattributed values? |

Scenarios include project-shaped goals ("build a house", "organise my wedding")
which do not fit a recurring-habit tracker cleanly, and are exactly where
personalisation previously hijacked the goal.

INTENT deliberately checks task titles, not the whole draft — a rationale that
name-drops the goal is not the same as a plan that pursues it.

### Progress-aware Copilot

`POST /goals/:id/copilot` answers questions about a live goal. The model receives a
deterministic aggregate (completion rate, streak, per-task miss rates) computed by
the same Phase 1 scoring engine — never the database — so it cannot invent numbers.
It returns explanation plus *suggestions only*; applying one is a separate explicit
action, and past occurrences are never rewritten.

### Prompts and telemetry

Five separate versioned prompts (`goal-interview-v1`, `goal-draft-v1`,
`goal-edit-v1`, `progress-analysis-v1`, `preference-extraction-v1`). Every call is
logged to `AiCallLog` with provider, model, prompt version, latency, tokens and
status — and deliberately **no prompt or completion text**. Funnel events go to
`CopilotEvent`.

### Not built (Phase 3)

No StudyOS: no course ingestion, embeddings, RAG, mastery tracking, exam prediction
or adaptive study planning. A study goal today produces ordinary practice tasks and
makes no claim to educational intelligence. Phase 2.5 below changed nothing about
this: it is infrastructure and interface, not new capability.

## Phase 2.5 — deployment readiness

Phase 2.5 adds no new domain concepts. Everything below is either the same Copilot
reached from a new place, or the infrastructure a real deployment needs.

### The widget is a surface, not a second brain

The floating Copilot renders on authenticated pages only, and calls the same
`/api/copilot/*` endpoints the full-page interview does. There is no widget-specific
AI path, no `AiGoal`, no `AiTask` — a goal created in the widget is indistinguishable
from one typed into the Phase 1 form, because it *is* one: `confirmDraft` writes a
`Goal` with `TaskDefinition`s and the application's own reward bands, then generates
occurrences the ordinary way.

### The interview asks for what it does not already know

The question budget is derived from the request, not fixed. "I want to read 10 pages
every day at 9pm" already states a frequency, a time and a target, so the budget is
0–2 questions and the model is allowed to go straight to a draft. A bare "I want to
get fitter" states nothing, so the budget is 2–5. The backend enforces both ends: a
model that tries to finish early is sent back for the minimum, and one that keeps
asking is cut off at the maximum. Repeats are caught before they are asked —
`redundancyReason` rejects a question whose id, topic or answer is already on file.

A question with several true answers accepts several: `promoteMultiSelect` widens a
`SINGLE_SELECT` to `MULTI_SELECT` when the prompt is about activities, days, times,
formats or constraints. Widening only — never the reverse.

Slashes are ordinary characters. "5/7 days" and "walking/running" reach the model
verbatim; the only input the message field rejects is one that is empty after
trimming.

### Plans that get harder, starting easy

A drafted task may carry a build-up ladder (walk 25 minutes, then 40, then 60). The
first day is stamped with the *first* rung, and every occurrence stores the target it
was asked for rather than reading the plan's current one — so advancing tomorrow
cannot rewrite what yesterday demanded. Ladders are validated by the same
`validateStages` a hand-made progression goes through, and a ladder that fails
validation is dropped with a note while the plan is kept.

### Adjustment, and who is allowed to do it

`POST /goals/:id/copilot` answers questions about a live goal and may propose a stage
change. It is recorded as a proposal and never applied: `authorizeAction` refuses
`source: 'COPILOT'` before it even evaluates whether the change would be reasonable,
and there is deliberately no endpoint that applies a Copilot suggestion. Advancing or
reducing is a `POST /tasks/:id/progression/decision` from the user, and past
occurrences keep their original targets either way.

### Two scheduled notifications

A morning summary at the user's chosen time (08:00 by default) and an evening
incomplete-task check (20:30). Both run from one five-minute tick, because both start
with the same question — what time is it where this user is. Each user's own IANA
timezone decides, never a fixed offset.

Correctness does not depend on the cron firing on time. A unique
`userId:TYPE:localDate` key means a second tick inside the same window sends nothing,
so frequency buys punctuality only. Each notification has a late tolerance (four
hours for the morning, two and a half for the evening) and neither window wraps past
midnight, so a missed nudge stays missed rather than arriving overnight. Nothing is
sent when there is nothing to say: no tasks scheduled, or none left.

### Realtime is a convenience, never a record

A notification is a PostgreSQL row first and a Centrifugo push second, and the push
is allowed to fail — `publishToUser` never throws and returns whether it landed.
Centrifugo runs on its in-memory engine with no history and is never asked what a
client missed; the client fetches `GET /api/notifications` on connect and on every
reconnect. Delete the realtime layer and the product is still correct, only less
immediate.

Each user has one channel, `personal:#<userId>`. The `personal` namespace sets
`allow_user_limited_channels`, so Centrifugo itself checks the id against the
subscriber's connection token and rejects everyone else — which is why there are no
per-channel subscription tokens to issue, leak or forget to scope. Tokens come from
`GET /api/realtime/token`, are valid for fifteen minutes, and take their subject from
the resolved session rather than from anything the client sent.

### Durable jobs in the database that is already trusted

pg-boss keeps its queues and its cron entry in a `pgboss` schema inside the same
PostgreSQL. Jobs are rows, so a restart resumes rather than skips, and there is no
second datastore to get wrong. Declaring the queue and the schedule are both upserts:
a deploy loop re-declares them without leaving five cron entries behind.

### Packaging and hardening

`docker compose up -d` gives PostgreSQL and Centrifugo for development;
`--profile app` additionally builds the API and the frontend and puts nginx in front
of them. The API exposes `GET /health` (liveness — process is up) and
`GET /health/ready` (readiness — database reachable, migrations applied), both
deliberately unprefixed because they are for the orchestrator rather than the
browser, and neither reveals a secret or a version string.

A startup config audit refuses to boot in production on an unset `DATABASE_URL`, a
Centrifugo secret still set to the placeholder published in this repository, a
wildcard or malformed CORS origin, or an ambiguous `TRUST_PROXY` — it exits non-zero
rather than serving a subtly wrong configuration. Everything that is merely suspicious
(a plain-http origin that will silently drop `Secure` session cookies, `JOBS_ENABLED`
off, a debug log level that would print cookies) is a warning that names the
consequence. `TRUST_PROXY` rejects a bare hop count on purpose: Fastify maps any
number to "trust nothing", so a `1` that looks like "trust one proxy" would silently
disable the setting it appears to enable.

Security headers, a CSP, and per-address auth throttling are applied at the proxy and
in the app; every nginx `location` that sets its own headers re-includes the security
snippet, because `add_header` in a location replaces inherited headers rather than
adding to them.

### Not applicable this phase

Email delivery was taken out of Phase 2.5, so there is no `EmailProvider` and no
transactional email integration. Notifications are in-app and realtime only. The
acceptance suite records this as a skipped test rather than silently omitting it.
