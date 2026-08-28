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
import { badRequest, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { ensureOccurrences } from './occurrences.js';
import { createProgressionPlan } from './progression.js';
import { recordEvent } from './copilot-analytics.js';
import { extractPreferences, getPreferencesForPrompt } from './preferences.js';
import { loadSession } from './copilot-session.js';
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
import { AiProviderError } from '../ai/provider.js';

const TRANSCRIPT_WINDOW = 20;

/**
 * A malformed or truncated model response must not dead-end a completed
 * interview. This conservative draft uses only the user's original words and
 * can be edited on the review screen before anything is created.
 */
function fallbackDraft(
  initialGoal: string,
  category: GoalDraftInput['category'] | null,
): GoalDraftInput {
  const goal = initialGoal.replace(/\s+/g, ' ').trim();
  return {
    title: goal.length <= 120 ? goal : `${goal.slice(0, 117)}...`,
    description: goal.slice(0, 1000),
    category: category ?? 'PERSONAL',
    targetType: 'HABIT',
    targetValue: null,
    deadline: null,
    rationale: 'A simple starting plan based on your goal. You can adjust it before creating it.',
    tasks: [
      {
        title: 'Take the first concrete step',
        description: goal.slice(0, 400),
        recurrence: { type: 'ONCE' },
        estimatedMinutes: 20,
        preferredTime: null,
        reason: 'Starting small makes the goal easier to begin and refine.',
        progression: null,
      },
    ],
  };
}

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
export async function generateDraft(sessionId: string, userId: string, regenerate = false) {
  const session = await loadSession(sessionId, userId);
  if (session.status === 'CONFIRMED') {
    throw badRequest('This session already produced a goal', 'ALREADY_CONFIRMED');
  }

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

  let raw: GoalDraftInput;
  try {
    raw = await chatJson(
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
        // A provider outage should reach the editable fallback quickly instead
        // of holding the review flow for two full timeout windows.
        timeoutMs: 8_000,
        retryTransient: false,
        messages,
      },
      goalDraftSchema,
    );
  } catch (err) {
    // A completed interview should still yield something editable when the
    // provider is slow or returns malformed JSON after its bounded retry.
    if (
      !(err instanceof AiProviderError) ||
      (err.kind !== 'BAD_RESPONSE' && err.kind !== 'TIMEOUT')
    ) {
      throw err;
    }
    raw = fallbackDraft(
      session.initialGoalText,
      session.category as GoalDraftInput['category'] | null,
    );
  }

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

    let repaired: GoalDraftInput = await chatJson(
      {
        purpose: 'DRAFT_GENERATION',
        promptVersion: PROMPT_VERSIONS.draft,
        userId,
        sessionId,
        thinking: false,
        temperature: 0.3,
        maxTokens: 4000,
        timeoutMs: 8_000,
        retryTransient: false,
        messages: [
          ...messages,
          { role: 'assistant', content: JSON.stringify(raw).slice(0, 4000) },
          {
            role: 'user',
            content:
              `That plan was rejected: ${err.message}

` +
              'Produce a lighter, genuinely sustainable plan for the same goal. ' +
              'Fewer tasks, shorter sessions, or a lower frequency. Reply with ONLY the JSON.',
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

  await prisma.goalDraft.update({
    where: { id: draftId },
    data: { status: 'CONFIRMED', createdGoalId: goal.id },
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
