import { chatJson } from '../ai/client.js';
import {
  PROMPT_VERSIONS,
  draftEditSystemPrompt,
  draftEditUserPrompt,
  draftSystemPrompt,
  draftUserPrompt,
} from '../ai/prompts.js';
import {
  draftPatchSchema,
  goalDraftSchema,
  type DraftPatch,
  type GoalDraftInput,
} from '../ai/schemas.js';
import {
  DraftValidationError,
  rewardForTask,
  validateAndNormalizeDraft,
  type NormalizedDraft,
  type NormalizedProgression,
} from '../ai/draft-validator.js';
import { todayIn } from '../domain/dates.js';
import type { RecurrenceType } from '../domain/enums.js';
import { validateRecurrence } from '../domain/recurrence.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { describeExplicitConstraints, parseExplicitGoalConstraints } from '../ai/goal-constraints.js';
import { prisma } from '../lib/prisma.js';
import { ensureOccurrences } from './occurrences.js';
import { createProgressionPlan } from './progression.js';
import { recordEvent } from './copilot-analytics.js';
import { extractPreferences, getPreferencesForPrompt } from './preferences.js';
import { loadSession, sessionReadiness } from './copilot-session.js';
import {
  currentSessionFacts,
  inferredValues,
  literalAnswers,
  parseContext,
} from '../ai/context.js';
import {
  classifyGoalText,
  MEMORY_GATE_CONFIDENCE,
  memoryGateCategory,
} from '../ai/category.js';
import { scorePlanQuality } from '../ai/plan-quality.js';

const TRANSCRIPT_WINDOW = 20;

async function userTimezone(userId: string) {
  const profile = await prisma.profile.findUnique({ where: { userId } });
  return profile?.timezone ?? 'UTC';
}

/**
 * Read a stored ladder back, defensively.
 *
 * The column is JSON written by this application, but it is still the one place a
 * draft carries a nested structure, and a half-written or hand-edited row must not
 * be able to break confirmation. Anything unreadable is simply no ladder.
 */
export function parseLadder(json: string | null): NormalizedProgression | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as NormalizedProgression;
    if (!Array.isArray(parsed?.stages) || parsed.stages.length < 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Where a minute ladder starts, so a task's minutes and its first day agree. */
function startingMinutes(json: string | null): number | null {
  const ladder = parseLadder(json);
  return ladder?.metricType === 'MINUTES' ? ladder.stages[0].target : null;
}

async function persistDraft(opts: {
  userId: string;
  sessionId: string | null;
  draft: NormalizedDraft;
}) {
  return prisma.goalDraft.create({
    data: {
      userId: opts.userId,
      sessionId: opts.sessionId,
      title: opts.draft.title,
      description: opts.draft.description,
      category: opts.draft.category,
      targetType: opts.draft.targetType,
      targetValue: opts.draft.targetValue,
      deadline: opts.draft.deadline,
      visibility: 'PRIVATE',
      rationale: opts.draft.rationale,
      status: 'GENERATED',
      tasks: {
        create: opts.draft.tasks.map((task, index) => ({
          title: task.title,
          description: task.description,
          recurrenceType: task.recurrenceType,
          recurrenceConfig: JSON.stringify(task.recurrenceConfig),
          estimatedMinutes: task.estimatedMinutes,
          preferredTime: task.preferredTime,
          progressionConfig: task.progression ? JSON.stringify(task.progression) : null,
          reason: task.reason,
          sortOrder: index,
        })),
      },
    },
    include: { tasks: { orderBy: { sortOrder: 'asc' } } },
  });
}

/**
 * Turn a finished interview into a validated draft.
 *
 * Nothing here touches Goal or TaskDefinition — a draft is a proposal the user
 * has not agreed to yet.
 */
export async function generateDraft(
  sessionId: string,
  userId: string,
  regenerate = false,
  opts: { force?: boolean; revision?: number } = {},
) {
  const session = await loadSession(sessionId, userId);
  if (session.status === 'CONFIRMED') {
    throw badRequest('This session already produced a goal', 'ALREADY_CONFIRMED');
  }

  // A generate request carries the revision it saw. If the interview has moved
  // on since — another question asked and answered — the caller is about to
  // plan from a picture that no longer exists, so the request is rejected
  // rather than silently building from something stale. Deliberately checked
  // before the claim below, so a stale request never blocks a live one.
  if (opts.revision !== undefined && opts.revision !== session.revision) {
    throw conflict(
      'This interview changed since the plan was requested. Review the latest question and try again.',
      'STALE_REQUEST',
    );
  }

  // The backend, not the model, decides when an interview is worth planning
  // from. A session the readiness gate calls unfinished does not get a plan
  // invented on its behalf — unless the user explicitly insists on one after
  // having sat through at least two questions.
  const readiness = sessionReadiness(session);
  // An interview that has itself concluded as READY_TO_GENERATE has opened the
  // gate: the hard question cap and the provider-outage fallback both end a
  // vague interview there, with no next question left to ask. Refusing to
  // generate then would dead-end the user, which the fallback question exists
  // to prevent. The assumptions list already says the plan uses only what the
  // user actually said.
  const concluded = session.status === 'READY_TO_GENERATE';
  const forced = concluded || (opts.force === true && session.questionCount >= 2);
  if (!readiness.ready && !forced) {
    throw conflict('The interview has not gathered enough information yet', 'NOT_READY');
  }

  // Claim the session before any model call. The conditional update is the
  // lock: of two concurrent generates exactly one moves the status out of the
  // claimable set, so a double-click can neither run the model twice nor
  // persist two drafts. A plain generate does not claim DRAFT_GENERATED
  // sessions — it gets the existing draft back below — while a regeneration
  // legitimately re-claims one, since re-running the model is the point.
  const claim = await prisma.copilotSession.updateMany({
    where: {
      id: session.id,
      status: regenerate
        ? { in: ['INTERVIEWING', 'READY_TO_GENERATE', 'DRAFT_GENERATED'] }
        : { in: ['INTERVIEWING', 'READY_TO_GENERATE'] },
    },
    data: { status: 'GENERATING' },
  });
  if (claim.count === 0) {
    // Someone else holds the claim — or already finished. An existing draft
    // satisfies a plain generate; only an in-flight regeneration conflicts.
    const existing = await prisma.goalDraft.findFirst({
      where: { sessionId, status: { not: 'DISCARDED' } },
      orderBy: { createdAt: 'desc' },
      include: { tasks: { orderBy: { sortOrder: 'asc' } } },
    });
    if (existing && !regenerate) return { draft: existing, adjustments: [] };
    throw conflict('A plan is already being built or the session is closed', 'GENERATE_IN_PROGRESS');
  }

  try {
    return await buildDraft(session, userId, regenerate);
  } catch (err) {
    // Release the claim. The session goes back to the status it held before —
    // never stuck at GENERATING, so the user can simply try again.
    await prisma.copilotSession
      .updateMany({
        where: { id: session.id, status: 'GENERATING' },
        data: { status: session.status },
      })
      .catch(() => {});
    throw err;
  }
}

/**
 * The model half of generation — runs only under a held claim.
 *
 * A provider failure is surfaced as the error it is. A malformed or timed-out
 * response after the bounded attempt budget ends the request with a structured
 * error; disguising it as a plan the user never asked for is exactly what the
 * fallback used to do, and it is gone.
 */
async function buildDraft(
  session: Awaited<ReturnType<typeof loadSession>>,
  userId: string,
  regenerate: boolean,
) {
  const sessionId = session.id;
  const timezone = await userTimezone(userId);
  const context = parseContext(session.structuredContext, session.initialGoalText);

  // Ground truth (what they literally answered) is kept apart from everything
  // inferred, so the prompt can rank them rather than seeing one flat blob.
  const answers = literalAnswers(context).reduce<Record<string, unknown>>((acc, entry) => {
    acc[entry.key] = { question: entry.question ?? entry.key, answer: entry.value };
    return acc;
  }, {});
  const inferred = { ...currentSessionFacts(context), ...inferredValues(context) };
  const validationSource = [
    session.initialGoalText,
    JSON.stringify(answers),
  ].join('\n');

  // Memory is gated on the user's own words, not the model's category guess.
  const gate = memoryGateCategory(session.initialGoalText, session.category);
  const preferences = await getPreferencesForPrompt(userId, gate.category);

  const messages = [
    { role: 'system' as const, content: draftSystemPrompt() },
    {
      role: 'user' as const,
      content: draftUserPrompt({
        initialGoal: session.initialGoalText,
        answers,
        goalIntent: context.goalIntent,
        context: inferred,
        transcript: session.messages.slice(-TRANSCRIPT_WINDOW),
        knownPreferences: preferences,
        today: todayIn(timezone),
      }),
    },
  ];

  let raw: GoalDraftInput = await chatJson(
    {
      purpose: 'DRAFT_GENERATION',
      promptVersion: PROMPT_VERSIONS.draft,
      userId,
      sessionId,
      // Reasoning was truncating the JSON before it closed. Correct structured
      // output matters far more here than internal deliberation, so thinking is
      // off and the budget is generous.
      thinking: false,
      temperature: regenerate ? 0.6 : 0.35,
      maxTokens: 4000,
      // Long enough for a genuine generation to finish (live median ~7s,
      // with real tails past 8s), short enough that an outage fails fast into
      // a structured, retryable error instead of spinning the review screen.
      timeoutMs: 45_000,
      retryTransient: false,
      messages,
    },
    goalDraftSchema,
  );

  // A clear category in the user's own words outranks an occasional model miss.
  // This prevents “get fitter” from appearing as Personal Growth while leaving
  // genuinely mixed or ambiguous requests to the model.
  const categoryGuess = classifyGoalText(session.initialGoalText);
  if (categoryGuess.category && categoryGuess.confidence >= MEMORY_GATE_CONFIDENCE) {
    raw = { ...raw, category: categoryGuess.category };
  }

  // A plan can be perfectly well-formed and still be unusable — 60 hours a week,
  // or a frequency that is not a real schedule. Give it the same single corrective
  // retry the JSON parser gets, rather than handing the user a dead end.
  let normalized: NormalizedDraft;
  const requireUsefulPlan = (draft: NormalizedDraft) => {
    const quality = scorePlanQuality(session.initialGoalText, draft, JSON.stringify(answers));
    if (quality.planScore < 50) {
      throw new DraftValidationError(
        `The plan is structurally valid but not useful enough: ${quality.issues.join('; ')}`,
      );
    }
  };
  try {
    normalized = validateAndNormalizeDraft(raw, timezone, new Date(), validationSource);
    requireUsefulPlan(normalized);
  } catch (err) {
    if (!(err instanceof DraftValidationError)) throw err;

    // One informed retry: the model gets the exact violation plus the full list
    // of constraints parsed from the user's own words, so the replacement plan
    // is aimed at the real contract instead of guessing at a smaller plan.
    const constraintLines = describeExplicitConstraints(
      parseExplicitGoalConstraints(validationSource, todayIn(timezone)),
    );
    let repaired: GoalDraftInput = await chatJson(
      {
        purpose: 'DRAFT_GENERATION',
        promptVersion: PROMPT_VERSIONS.draft,
        userId,
        sessionId,
        thinking: false,
        temperature: 0.3,
        maxTokens: 4000,
        timeoutMs: 45_000,
        retryTransient: false,
        messages: [
          ...messages,
          { role: 'assistant', content: JSON.stringify(raw).slice(0, 4000) },
          {
            role: 'user',
            content:
              `That plan was rejected: ${err.message}

` +
              `The replacement plan must honor everything the user asked for: ${constraintLines.join('; ') || 'the stated goal, schedule, and limits'}. ` +
              'Fix the stated violation while keeping the plan realistic and sustainable. ' +
              'Reply with ONLY the JSON.',
          },
        ],
      },
      goalDraftSchema,
    );
    if (categoryGuess.category && categoryGuess.confidence >= MEMORY_GATE_CONFIDENCE) {
      repaired = { ...repaired, category: categoryGuess.category };
    }
    normalized = validateAndNormalizeDraft(repaired, timezone, new Date(), validationSource);
    requireUsefulPlan(normalized);
  }
  const draft = await persistDraft({ userId, sessionId, draft: normalized });

  await prisma.copilotSession.update({
    where: { id: sessionId },
    data: { status: 'DRAFT_GENERATED', category: normalized.category },
  });

  await recordEvent({
    userId,
    type: regenerate ? 'DRAFT_REGENERATED' : 'DRAFT_GENERATED',
    sessionId,
    draftId: draft.id,
    meta: { adjustments: normalized.adjustments.length, tasks: normalized.tasks.length },
  });

  // Learn durable preferences in the background — never block the plan on it.
  void extractPreferences({
    userId,
    sessionId,
    category: normalized.category,
    transcript: session.messages.slice(-TRANSCRIPT_WINDOW),
  });

  return { draft, adjustments: normalized.adjustments };
}

export async function loadDraft(draftId: string, userId: string) {
  const draft = await prisma.goalDraft.findUnique({
    where: { id: draftId },
    include: { tasks: { orderBy: { sortOrder: 'asc' } } },
  });
  // A draft belonging to someone else simply does not exist for this caller.
  if (!draft || draft.userId !== userId) throw notFound('Draft not found');
  return draft;
}

// ------------------------------------------------------------- manual edits

export interface ManualDraftEdit {
  title?: string;
  description?: string;
  deadline?: string | null;
  visibility?: 'PRIVATE' | 'PUBLIC';
  tasks?: Array<{
    id?: string;
    title: string;
    description?: string;
    recurrenceType: RecurrenceType;
    recurrenceConfig: Record<string, unknown>;
    estimatedMinutes?: number | null;
    preferredTime?: string | null;
    reason?: string;
    /**
     * Omitted means "leave the build-up alone" — it is carried across by title.
     * Explicit null removes it. There is no way to *add* one by hand here: the
     * ladder editor on a real task is the place for that, and a draft that has
     * been confirmed is a real task.
     */
    progression?: null;
  }>;
}

/** Editing by hand must not require the AI at all. */
export async function applyManualEdit(draftId: string, userId: string, edit: ManualDraftEdit) {
  const draft = await loadDraft(draftId, userId);
  if (draft.status === 'CONFIRMED') throw badRequest('This draft has already been used');

  if (edit.tasks) {
    if (edit.tasks.length === 0) throw badRequest('A plan needs at least one task');
    if (edit.tasks.length > 8) throw badRequest('A plan can have at most 8 tasks');
    for (const task of edit.tasks) {
      validateRecurrence(task.recurrenceType, task.recurrenceConfig);
    }

    // Rows are replaced wholesale, so anything the client does not send would be
    // lost. A build-up the user never mentioned is not theirs to lose, so it is
    // matched back by id, and by title for a client that sends neither.
    const laddersById = new Map(
      draft.tasks.filter((t) => t.progressionConfig).map((t) => [t.id, t.progressionConfig!]),
    );
    const laddersByTitle = new Map(
      draft.tasks
        .filter((t) => t.progressionConfig)
        .map((t) => [t.title.trim().toLowerCase(), t.progressionConfig!]),
    );
    const carriedLadder = (task: { id?: string; title: string; progression?: null }) => {
      if (task.progression === null) return null;
      const byId = task.id ? laddersById.get(task.id) : undefined;
      return byId ?? laddersByTitle.get(task.title.trim().toLowerCase()) ?? null;
    };

    await prisma.goalDraftTask.deleteMany({ where: { draftId } });
    await prisma.goalDraftTask.createMany({
      data: edit.tasks.map((task, index) => {
        const progressionConfig = carriedLadder(task);
        return {
          draftId,
          title: task.title.trim(),
          description: task.description?.trim() ?? '',
          recurrenceType: task.recurrenceType,
          recurrenceConfig: JSON.stringify(task.recurrenceConfig ?? {}),
          // A minute ladder decides where the task starts, here as much as at
          // generation time — otherwise a hand-typed 40 would sit next to a day
          // that asks for 15.
          estimatedMinutes: startingMinutes(progressionConfig) ?? task.estimatedMinutes ?? null,
          preferredTime: task.preferredTime ?? null,
          progressionConfig,
          reason: task.reason ?? '',
          sortOrder: index,
        };
      }),
    });
  }

  await prisma.goalDraft.update({
    where: { id: draftId },
    data: {
      title: edit.title?.trim(),
      description: edit.description?.trim(),
      deadline: edit.deadline === undefined ? undefined : edit.deadline,
      visibility: edit.visibility,
      status: 'EDITING',
    },
  });

  await recordEvent({ userId, type: 'DRAFT_EDITED_MANUALLY', draftId });
  return loadDraft(draftId, userId);
}

// ----------------------------------------------------------------- AI edits

/**
 * Conversational editing.
 *
 * Patch operations rather than regeneration, so "make the walks 30 minutes"
 * changes one field and leaves the rest of a plan the user already liked alone.
 */
export async function applyCopilotEdit(draftId: string, userId: string, message: string) {
  const draft = await loadDraft(draftId, userId);
  if (draft.status === 'CONFIRMED') throw badRequest('This draft has already been used');

  const patch: DraftPatch = await chatJson(
    {
      purpose: 'DRAFT_EDIT',
      promptVersion: PROMPT_VERSIONS.edit,
      userId,
      thinking: false,
      temperature: 0.2,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: draftEditSystemPrompt() },
        {
          role: 'user',
          content: draftEditUserPrompt({
            draft: {
              title: draft.title,
              description: draft.description,
              deadline: draft.deadline,
              tasks: draft.tasks.map((t) => ({
                taskId: t.id,
                title: t.title,
                recurrence: { type: t.recurrenceType, ...JSON.parse(t.recurrenceConfig || '{}') },
                estimatedMinutes: t.estimatedMinutes,
                preferredTime: t.preferredTime,
              })),
            },
            message,
          }),
        },
      ],
    },
    draftPatchSchema,
  );

  const { draft: updated, applied } = await applyPatch(draftId, userId, patch);
  await recordEvent({ userId, type: 'DRAFT_EDITED_WITH_AI', draftId });
  return { draft: updated, assistantMessage: patch.assistantMessage, applied };
}

/**
 * Every operation is re-validated; the model's ids are checked against the draft.
 *
 * Returns a factual list of what was actually applied. The model's own prose can
 * overclaim ("and added a rest day" when it only changed a duration), so the UI
 * shows this instead of taking the assistant's word for it.
 */
export async function applyPatch(draftId: string, userId: string, patch: DraftPatch) {
  const draft = await loadDraft(draftId, userId);
  const validIds = new Set(draft.tasks.map((t) => t.id));
  const applied: string[] = [];
  const titleOf = (id: string) => draft.tasks.find((t) => t.id === id)?.title ?? 'task';

  for (const op of patch.operations) {
    switch (op.type) {
      case 'UPDATE_GOAL': {
        await prisma.goalDraft.update({
          where: { id: draftId },
          data: {
            title: op.changes.title,
            description: op.changes.description,
            deadline: op.changes.deadline === undefined ? undefined : op.changes.deadline,
            targetValue: op.changes.targetValue === undefined ? undefined : op.changes.targetValue,
          },
        });
        applied.push(`Updated the goal (${Object.keys(op.changes).join(', ')})`);
        break;
      }
      case 'UPDATE_TASK': {
        // Silently ignore a hallucinated task id rather than failing the whole edit.
        if (!validIds.has(op.taskId)) break;
        const recurrence = op.changes.recurrence;
        if (recurrence) {
          const config = {
            weekdays: recurrence.weekdays,
            timesPerWeek: recurrence.timesPerWeek,
            allowedWeekdays: recurrence.allowedWeekdays,
            excludedWeekdays: recurrence.excludedWeekdays,
            intervalDays: recurrence.intervalDays,
            dayOfMonth: recurrence.dayOfMonth,
            intervalMonths: recurrence.intervalMonths,
          };
          validateRecurrence(recurrence.type, config);
        }
        await prisma.goalDraftTask.update({
          where: { id: op.taskId },
          data: {
            title: op.changes.title,
            description: op.changes.description,
            reason: op.changes.reason,
            estimatedMinutes:
              op.changes.estimatedMinutes === undefined ? undefined : op.changes.estimatedMinutes,
            preferredTime:
              op.changes.preferredTime === undefined ? undefined : op.changes.preferredTime,
            ...(recurrence
              ? {
                  recurrenceType: recurrence.type,
                  recurrenceConfig: JSON.stringify({
                    weekdays: recurrence.weekdays,
                    timesPerWeek: recurrence.timesPerWeek,
                    allowedWeekdays: recurrence.allowedWeekdays,
                    excludedWeekdays: recurrence.excludedWeekdays,
                    intervalDays: recurrence.intervalDays,
                    dayOfMonth: recurrence.dayOfMonth,
                    intervalMonths: recurrence.intervalMonths,
                  }),
                }
              : {}),
          },
        });
        const fields = Object.keys(op.changes);
        applied.push(`“${titleOf(op.taskId)}”: changed ${fields.join(', ')}`);
        break;
      }
      case 'REMOVE_TASK': {
        if (!validIds.has(op.taskId)) break;
        // Never let an edit empty the plan entirely.
        if (draft.tasks.length <= 1) break;
        applied.push(`Removed “${titleOf(op.taskId)}”`);
        await prisma.goalDraftTask.delete({ where: { id: op.taskId } });
        validIds.delete(op.taskId);
        break;
      }
      case 'ADD_TASK': {
        if (validIds.size >= 8) break;
        const config = {
          weekdays: op.task.recurrence.weekdays,
          timesPerWeek: op.task.recurrence.timesPerWeek,
          allowedWeekdays: op.task.recurrence.allowedWeekdays,
          excludedWeekdays: op.task.recurrence.excludedWeekdays,
          intervalDays: op.task.recurrence.intervalDays,
          dayOfMonth: op.task.recurrence.dayOfMonth,
          intervalMonths: op.task.recurrence.intervalMonths,
        };
        validateRecurrence(op.task.recurrence.type, config);
        const created = await prisma.goalDraftTask.create({
          data: {
            draftId,
            title: op.task.title,
            description: op.task.description ?? '',
            recurrenceType: op.task.recurrence.type,
            recurrenceConfig: JSON.stringify(config),
            estimatedMinutes: op.task.estimatedMinutes ?? null,
            preferredTime: op.task.preferredTime ?? null,
            reason: op.task.reason ?? '',
            sortOrder: draft.tasks.length,
          },
        });
        validIds.add(created.id);
        applied.push(`Added “${created.title}”`);
        break;
      }
    }
  }

  await prisma.goalDraft.update({ where: { id: draftId }, data: { status: 'EDITING' } });
  return { draft: await loadDraft(draftId, userId), applied };
}

// ---------------------------------------------------------------- confirm

/**
 * The only place a draft becomes real.
 *
 * This deliberately goes through the same Goal/TaskDefinition/occurrence path
 * that manual creation uses — no duplicated creation logic lives in the AI module.
 */
export async function confirmDraft(draftId: string, userId: string) {
  const draft = await loadDraft(draftId, userId);
  if (draft.status === 'CONFIRMED' && draft.createdGoalId) {
    return { goalId: draft.createdGoalId, alreadyCreated: true };
  }
  if (draft.tasks.length === 0) throw badRequest('This plan has no tasks');

  // Atomic claim: of any number of concurrent confirms, exactly one moves the
  // draft into CONFIRMED and is allowed to create the Goal. Everyone else
  // either sees that goal appear below or learns the draft was already used.
  const claim = await prisma.goalDraft.updateMany({
    where: { id: draftId, status: { not: 'CONFIRMED' } },
    data: { status: 'CONFIRMED' },
  });
  if (claim.count === 0) {
    // The winner is usually still mid-creation here — creating a goal is
    // several inserts — so wait briefly for the goal id to land rather than
    // answer a double-click with an error.
    const deadline = Date.now() + 3_000;
    for (;;) {
      const latest = await prisma.goalDraft.findUniqueOrThrow({ where: { id: draftId } });
      if (latest.createdGoalId) return { goalId: latest.createdGoalId, alreadyCreated: true };
      if (Date.now() > deadline) throw badRequest('This draft has already been used');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const timezone = await userTimezone(userId);
  const startDate = todayIn(timezone);

  const goal = await prisma.goal.create({
    data: {
      ownerId: userId,
      title: draft.title,
      description: draft.description,
      category: draft.category,
      visibility: draft.visibility,
      targetType: draft.targetType,
      targetValue: draft.targetValue,
      timezone,
      startDate,
      deadline: draft.deadline,
      participants: { create: { userId, role: 'OWNER', joinedOn: startDate } },
      tasks: {
        create: draft.tasks.map((task) => ({
          title: task.title,
          description: task.description,
          recurrenceType: task.recurrenceType,
          recurrenceConfig: task.recurrenceConfig,
          // Reward comes from the application's own rules, never from the model.
          reward: rewardForTask({ estimatedMinutes: task.estimatedMinutes }),
          startDate,
          endDate: draft.deadline,
          reminderTime: task.preferredTime,
        })),
      },
    },
    include: { tasks: true },
  });

  // Any build-up the Copilot proposed becomes an ordinary ProgressionPlan here,
  // through the same service the manual ladder editor calls. Matching is a queue
  // per title rather than a lookup, so two tasks that ended up with the same name
  // cannot end up sharing one ladder.
  const pending = new Map<string, string[]>();
  for (const task of draft.tasks) {
    if (!task.progressionConfig) continue;
    const key = task.title.trim().toLowerCase();
    pending.set(key, [...(pending.get(key) ?? []), task.progressionConfig]);
  }
  if (pending.size > 0) {
    for (const task of goal.tasks) {
      const queue = pending.get(task.title.trim().toLowerCase());
      const ladder = parseLadder(queue?.shift() ?? null);
      if (!ladder) continue;
      // A ladder that no longer validates loses the ladder, not the goal — the
      // user confirmed a plan, and they get the plan.
      try {
        await createProgressionPlan({
          taskDefinitionId: task.id,
          metricType: ladder.metricType,
          unitLabel: ladder.unitLabel,
          stages: ladder.stages,
        });
      } catch {
        continue;
      }
    }
  }

  // After the plans, deliberately. Occurrences are born carrying their stage's
  // target, so day one asks for the first rung instead of nothing.
  await ensureOccurrences(goal.id);

  // Status was set to CONFIRMED by the claim above; only the goal id lands here.
  await prisma.goalDraft.update({
    where: { id: draftId },
    data: { createdGoalId: goal.id },
  });
  if (draft.sessionId) {
    await prisma.copilotSession.update({
      where: { id: draft.sessionId },
      data: { status: 'CONFIRMED' },
    });
  }

  await recordEvent({
    userId,
    type: 'DRAFT_CONFIRMED',
    draftId,
    sessionId: draft.sessionId ?? undefined,
    meta: { goalId: goal.id },
  });

  return { goalId: goal.id, alreadyCreated: false };
}

export async function discardDraft(draftId: string, userId: string) {
  await loadDraft(draftId, userId);
  await prisma.goalDraft.update({ where: { id: draftId }, data: { status: 'DISCARDED' } });
  await recordEvent({ userId, type: 'DRAFT_DISCARDED', draftId });
}

export { DraftValidationError };
