// PARTS 48-52 and 59 Ã¢â‚¬â€ the Copilot half of the Phase 2.5 acceptance suite.
//
// These are end-to-end in the sense that matters: a real HTTP request enters the real
// server, real services run, and real rows land in real PostgreSQL. Only the model is
// substituted, because an acceptance test whose expected output is written by a language
// model is not a test.
//
// Read them as the product claims they are:
//
//   48  A goal created entirely through the widget is an ordinary Phase 1 goal.
//   49  The Copilot can explain a goal it is looking at, and cannot change it.
//   50  A question with several true answers accepts several answers.
//   51  A message containing a slash reaches the model unaltered.
//   52  A plan that gets harder over time starts at its first rung.
//   59  One goal's memory does not leak into an unrelated goal.
//   60  Goal chat learns durable preferences into the visible memory panel.

import { describe, expect, it, vi } from 'vitest';
import { addDays, todayIn } from '../domain/dates.js';
import { AiProviderError } from '../ai/provider.js';
import { parseRequirementState } from '../ai/context.js';
import { prisma } from '../lib/prisma.js';
import { createProgressionPlan } from '../services/progression.js';
import { useHarness } from './harness.js';

const TZ = 'Asia/Tbilisi';
const day = (offset: number) => addDays(todayIn(TZ), offset);

const h = useHarness();

// ---------------------------------------------------------------- Stage 6 canonical fixtures
//
// The extraction fragments a real model produces ride the same interview
// turn; the AST gate reads them and concludes. Helpers below build those
// fragments and the canonical requirement atoms.

const frag = (atoms: Array<Record<string, unknown>> = [], groups: Array<Record<string, unknown>> = []) => ({
  atoms, groups, pendingAmbiguity: [],
});
const asksWithReq = (
  question: Record<string, unknown>,
  atoms: Array<Record<string, unknown>>,
  message = 'Got it Ã¢â‚¬â€ one more thing.',
) => ({
  state: 'NEEDS_MORE_INFORMATION',
  assistantMessage: message,
  question,
  requirements: frag(atoms),
});
const readyWithReq = (atoms: Array<Record<string, unknown>>, message = "That's everything I need.") => ({
  state: 'READY_TO_GENERATE',
  assistantMessage: message,
  question: null,
  requirements: frag(atoms),
});
const outcomeAtom = (value: string, evidence: string) => ({
  property: 'goal.outcome', scope: 'goal', relation: 'contains',
  value: { kind: 'text', value }, strength: 'REQUIRED', source: 'stated', evidence,
});
const freqAtom = (n: number, evidence: string) => ({
  property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq',
  value: { kind: 'count', value: n }, strength: 'REQUIRED', source: 'stated', evidence,
});
const lengthAtom = (minutes: number, evidence = 'session length') => ({
  property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
  value: { kind: 'quantity', value: minutes, unit: 'minute' }, strength: 'REQUIRED', source: 'stated', evidence,
});
const deadlineAtom = (date: string, evidence: string) => ({
  property: 'goal.deadline', scope: 'goal', relation: 'eq',
  value: { kind: 'date', value: date }, strength: 'REQUIRED', source: 'stated', evidence,
});

// ---------------------------------------------------------------- shared fixtures

/** The interview turn a model produces when it wants to ask something. */
const asks = (question: Record<string, unknown>, message = 'Got it Ã¢â‚¬â€ one more thing.') => ({
  state: 'NEEDS_MORE_INFORMATION',
  assistantMessage: message,
  question,
});

const ready = (message = "That's everything I need.") => ({
  state: 'READY_TO_GENERATE',
  assistantMessage: message,
  question: null,
});

describe('Copilot acceptance', () => {
  it('shows the real prompt when a redundant model question is replaced', async () => {
    const user = await h.createUser({ timezone: TZ });

    h.ai.queue(
      'INTERVIEW',
      asks(
        {
          id: 'desired_outcome',
          type: 'SINGLE_SELECT',
          prompt: 'What result matters most right now?',
          options: ['Lose weight', 'Build strength', 'Improve endurance'],
        },
        'One useful detail will help me tailor the plan.',
      ),
    );

    const turn = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to lose weight and go to the gym and box',
    });

    expect(turn.question).not.toBeNull();
    expect(turn.question.id).not.toBe('desired_outcome');
    expect(turn.assistantMessage).toBe(turn.question.prompt);
    expect(turn.assistantMessage).not.toBe('One useful detail will help me tailor the plan.');
  });

    it('does not ask for a fitness outcome already stated in the opening message', async () => {
    const user = await h.createUser({ timezone: TZ });

    // The extraction carries the stated outcome, so the gap engine never
    // asks for it: the first asked question is the weekly-capacity gap. Every
    // later atom is grounded in the exact turn it arrives in (the opening
    // message or the literal answer text) — anything else degrades to
    // MODEL_INFERRED and closes nothing (RC-P1-B).
    h.ai.queue(
      'INTERVIEW',
      asksWithReq(
        {
          id: 'days_per_week',
          type: 'NUMBER',
          prompt: 'How many days per week can you commit to?',
        },
        [outcomeAtom('lose weight', 'lose weight')],
      ),
      asksWithReq(
        { id: 'session_minutes', type: 'NUMBER', prompt: 'How many minutes per session?' },
        [freqAtom(3, '3 days')],
      ),
      asksWithReq(
        { id: 'deadline', type: 'DATE', prompt: 'By when do you want to reach it?' },
        [deadlineAtom(day(30), day(30))],
      ),
      readyWithReq([lengthAtom(45, '45')]),
    );

    const first = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want lose weight; I will start boxing and gym',
    });
    expect(first.question.id).toBe('gap_weekly_capacity');

    const sessionTurn = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: first.question.id, answer: '3 days' },
    );
    // The frequency landed; the next blocking gap is the timeframe.
    expect(sessionTurn.question?.id).toBe('gap_timeframe');

    const deadlineTurn = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: sessionTurn.question.id, answer: day(30) },
    );
    // Required coverage is met; the HIGH session-shape gap is still worth
    // one question before the interview concludes.
    expect(deadlineTurn.question?.id).toBe('gap_session_shape');

    const readyTurn = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: deadlineTurn.question.id, answer: 45 },
    );

    expect(readyTurn.question).toBeNull();
    expect(readyTurn.assistantMessage).toBe("That's everything I need.");
  });

    it('does not display a capped question after the interview becomes ready', async () => {
    const user = await h.createUser({ timezone: TZ });

    // Every atom is grounded in the exact turn it arrives in: the stated
    // outcome closes its group; the later answers ground frequency, deadline
    // and session length one by one until required coverage is met and the
    // AST gate concludes without ever showing a capped question.
    h.ai.queue(
      'INTERVIEW',
      asksWithReq(
        { id: 'desired_outcome', type: 'FREE_TEXT', prompt: 'What result would make this goal successful?' },
        [],
      ),
      asksWithReq(
        { id: 'days_per_week', type: 'NUMBER', prompt: 'How many days per week can you commit to?' },
        [outcomeAtom('Lose weight', 'Lose weight')],
      ),
      asksWithReq(
        { id: 'deadline', type: 'DATE', prompt: 'By when do you want to reach it?' },
        [freqAtom(5, '5')],
      ),
      asksWithReq(
        { id: 'session_minutes', type: 'NUMBER', prompt: 'How long should a typical session be, in minutes?' },
        [deadlineAtom(day(60), day(60))],
      ),
      readyWithReq([lengthAtom(45, '45')]),
    );

    const first = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });
    const outcomeTurn = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: first.question.id, answer: 'Lose weight' },
    );
    expect(outcomeTurn.question?.id).toBe('gap_weekly_capacity');
    const freqTurn = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: outcomeTurn.question.id, answer: 5 },
    );
    expect(freqTurn.question?.id).toBe('gap_timeframe');
    const deadlineTurn = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: freqTurn.question.id, answer: day(60) },
    );
    expect(deadlineTurn.question?.id).toBe('gap_session_shape');
    const readyTurn = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: deadlineTurn.question.id, answer: 45 },
    );

    expect(readyTurn.question).toBeNull();
    expect(readyTurn.assistantMessage).toBe("That's everything I need.");
  });

    it('answers a goal-related recommendation with structured items', async () => {
    const user = await h.createUser({ timezone: TZ });
    const { goal } = await h.ok(user, 'POST', '/api/goals', {
      title: 'Read More Books',
      category: 'READING',
      targetType: 'HABIT',
      tasks: [{
        title: 'Read',
        recurrenceType: 'TIMES_PER_WEEK',
        recurrenceConfig: { timesPerWeek: 3 },
      }],
    });

    h.ai.queue(
      'PROGRESS_ANALYSIS',
      {
        explanation: 'Pick a short, engaging novel to get started.',
        suggestions: [],
        recommendsItems: true,
        recommendations: [{ entityType: 'novel', displayName: 'Piranesi', attribution: 'Susanna Clarke', reason: 'Short and imaginative.' }],
      },
    );

    const answer = await h.ok(user, 'POST', `/api/goals/${goal.id}/copilot`, {
      message: 'which book u can suggest',
    });

    expect(answer.intent).toBe('ADVICE');
    expect(answer.analysis.recommendations).toHaveLength(1);
    expect(answer.analysis.recommendations[0].displayName).toBe('Piranesi');
    expect(h.ai.promptsFor('PROGRESS_ANALYSIS', 'user')).toContain('Request type: ADVICE');
    expect(h.ai.countOf('PROGRESS_ANALYSIS')).toBe(1);
  });
  // ------------------------------------------------------------------- PART 48

    it('PART 48 Ã¢â‚¬â€ a goal built in the widget is an ordinary goal', async () => {
    const user = await h.createUser({ timezone: TZ });

    // A vague everyday goal stated with enough specifics for the AST gate to
    // conclude at once: every atom below is grounded in the user's exact
    // opening words, so required coverage closes and the plan becomes an
    // ordinary Phase 1 goal indistinguishable from a hand-made one.
    h.ai.queue(
      'INTERVIEW',
      readyWithReq([
        outcomeAtom('become fitter', 'become fitter'),
        freqAtom(3, '3 days a week'),
        lengthAtom(45, '45 minutes'),
        deadlineAtom(day(60), day(60)),
      ]),
    );

    const first = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to become fitter — 3 days a week, 45 minutes, by ' + day(60),
    });
    expect(first.question).toBeNull();
    expect(first.canGenerate).toBe(true);

    h.ai.queue('DRAFT_GENERATION', {
      title: 'Get Fitter',
      description: 'A gentle return to regular movement.',
      category: 'FITNESS',
      targetType: 'HABIT',
      deadline: day(60),
      rationale: 'You said walking and swimming suit you, so this starts with three manageable sessions.',
      tasks: [
        {
          title: 'Brisk walk Ã¢â‚¬â€ regular movement',
          description: 'A steady walk at a pace you can still talk at.',
          recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 2 },
          estimatedMinutes: 30,
          reason: 'You said you enjoy walking.',
        },
        {
          title: 'Swim Ã¢â‚¬â€ regular movement',
          description: 'Easy laps, stop before you are tired.',
          recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 1 },
          estimatedMinutes: 45,
          reason: 'You said you enjoy swimming.',
        },
      ],
    });

    const generated = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/generate`,
    );
    const draft = generated.draft;
    expect(draft.tasks).toHaveLength(2);
    expect(generated.readiness.ready).toBe(true);
    expect(generated.missingDimensions).toEqual([]);

    const walk = draft.tasks.find((t: any) => t.title.startsWith('Brisk walk'));
    const swim = draft.tasks.find((t: any) => t.title.startsWith('Swim'));
    expect(walk.estimatedMinutes).toBe(30);
    expect(swim.estimatedMinutes).toBe(45);

    h.ai.queue('DRAFT_EDIT', {
      assistantMessage: 'Made the walk 25 minutes.',
      operations: [{ type: 'UPDATE_TASK', taskId: walk.id, changes: { estimatedMinutes: 25 } }],
    });

    const edited = await h.ok(user, 'POST', `/api/copilot/goal-drafts/${draft.id}/copilot-edit`, {
      message: 'Make walking 25 minutes.',
    });
    const editedWalk = edited.draft.tasks.find((t: any) => t.id === walk.id);
    const editedSwim = edited.draft.tasks.find((t: any) => t.id === swim.id);
    expect(editedWalk.estimatedMinutes).toBe(25);
    expect(editedWalk.title).toBe('Brisk walk Ã¢â‚¬â€ regular movement');
    expect(editedWalk.recurrenceConfig).toEqual({ timesPerWeek: 2 });
    expect(editedSwim.estimatedMinutes).toBe(45);
    expect(editedSwim.title).toBe('Swim Ã¢â‚¬â€ regular movement');
    expect(edited.applied.length).toBeGreaterThan(0);

    const confirmed = await h.ok(user, 'POST', `/api/copilot/goal-drafts/${draft.id}/confirm`);
    expect(confirmed.alreadyCreated).toBe(false);

    const list = await h.ok(user, 'GET', '/api/goals');
    expect(list.goals.map((g: any) => g.id)).toContain(confirmed.goalId);

    const goal = await prisma.goal.findUniqueOrThrow({
      where: { id: confirmed.goalId },
      include: { tasks: true, participants: true },
    });
    expect(goal.ownerId).toBe(user.id);
    expect(goal.category).toBe('FITNESS');
    expect(goal.timezone).toBe(TZ);
    expect(goal.participants).toHaveLength(1);
    expect(goal.tasks.map((t) => t.title).sort()).toEqual(['Brisk walk Ã¢â‚¬â€ regular movement', 'Swim Ã¢â‚¬â€ regular movement']);

    const walkTask = goal.tasks.find((t) => t.title.startsWith('Brisk walk'))!;
    expect(walkTask.reward).toBe(15);
    expect(goal.tasks.find((t) => t.title.startsWith('Swim'))!.reward).toBe(20);

    const occurrences = await prisma.taskOccurrence.count({
      where: { taskDefinition: { goalId: goal.id } },
    });
    expect(occurrences).toBeGreaterThan(0);

    const draftRow = await prisma.goalDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(draftRow.status).toBe('CONFIRMED');
    expect(draftRow.createdGoalId).toBe(goal.id);
  });

  // ------------------------------------------------------------------- PART 50

    it('PART 50 — a multi-part answer is preserved verbatim through the canonical flow', async () => {
    const user = await h.createUser({ timezone: TZ });

    h.ai.queue(
      'INTERVIEW',
      asksWithReq(
        { id: 'liked_activities', type: 'FREE_TEXT', prompt: 'Which activities do you enjoy?' },
        [],
      ),
      readyWithReq([
        outcomeAtom('Walking, Swimming, Dancing', 'Walking, Swimming, Dancing'),
        freqAtom(3, 'three days a week'),
        lengthAtom(45),
        deadlineAtom(day(60), 'two months'),
      ]),
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to move my body more',
    });
    expect(started.question.id).toBe('gap_desired_outcome');

    const answered = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/answers`,
      { questionId: started.question.id, answer: 'Walking, Swimming, Dancing' },
    );

    // The answer reached the model's view of the conversation verbatim.
    const prompt = h.ai.promptsFor('INTERVIEW', 'user');
    expect(prompt).toContain('Walking, Swimming, Dancing');

    // Reloading the session shows the same recorded answer.
    const reloaded = await h.ok(user, 'GET', `/api/copilot/goal-sessions/${started.sessionId}`);
    expect(JSON.stringify(reloaded.context)).toContain('Walking, Swimming, Dancing');
  });

  // ------------------------------------------------------------------- PART 51

  it('PART 51 Ã¢â‚¬â€ a message containing slashes is accepted and passed through verbatim', async () => {
    const user = await h.createUser({ timezone: TZ });

    const { goal } = await h.ok(user, 'POST', '/api/goals', {
      title: 'Get Fit',
      category: 'FITNESS',
      targetType: 'HABIT',
      tasks: [{ title: 'Walk', recurrenceType: 'EVERY_DAY', reward: 10 }],
    });

    const message = 'I can exercise 5/7 days and prefer walking/swimming.';
    h.ai.respond('PROGRESS_ANALYSIS', {
      explanation: 'Five days a week is a realistic rhythm, and both activities count.',
      suggestions: [],
    });

    const answer = await h.ok(user, 'POST', `/api/goals/${goal.id}/copilot`, { message });
    expect(answer.analysis.explanation).toContain('Five days a week');

    // The whole message reached the model. Not stripped at the slash, not escaped,
    // not truncated to "I can exercise 5".
    const prompt = h.ai.promptsFor('PROGRESS_ANALYSIS', 'user');
    expect(prompt).toContain(message);
    expect(prompt).toContain('5/7');
    expect(prompt).toContain('walking/swimming');

    // A lone slash is a legitimate thing to type. It used to be a 400 with the send
    // button still enabled, which is how this was reported.
    const lone = await h.call(user, 'POST', `/api/goals/${goal.id}/copilot`, { message: '/' });
    expect(lone.status).toBe(200);

    // A slash-prefixed sentence is a message, not a command.
    const slashFirst = await h.call(user, 'POST', `/api/goals/${goal.id}/copilot`, {
      message: '/skip the weekend sessions',
    });
    expect(slashFirst.status).toBe(200);
    expect(h.ai.promptsFor('PROGRESS_ANALYSIS', 'user')).toContain('/skip the weekend sessions');

    // Empty is still empty. The fix widened what counts as a message; it did not
    // remove the floor.
    const blank = await h.call(user, 'POST', `/api/goals/${goal.id}/copilot`, { message: '   ' });
    expect(blank.status).toBe(400);

    // The same rule applies to the draft editor, which shares the schema.
    const draftBlank = await h.call(user, 'POST', '/api/copilot/goal-drafts/nonexistent/copilot-edit', {
      message: '',
    });
    expect(draftBlank.status).toBe(400);
  });

  // ------------------------------------------------------------------- PART 52

    it('PART 52 — a progressive plan starts on its first rung', async () => {
    const user = await h.createUser({ timezone: TZ });

    // Everything the opening message states is already in the AST — outcome,
    // frequency, session length and deadline, all grounded in the user's
    // exact words — so the gate concludes at zero questions and the Copilot
    // goes straight to a plan.
    h.ai.queue(
      'INTERVIEW',
      readyWithReq([
        { property: 'goal.target', scope: 'goal', relation: 'eq', value: { kind: 'quantity', value: 10, unit: 'page' }, strength: 'REQUIRED', source: 'stated', evidence: '10 pages' },
        freqAtom(7, 'every day'),
        lengthAtom(20, '20 minutes'),
        deadlineAtom(day(90), 'for the next three months'),
      ]),
    );

    const session = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to read 10 pages every day for 20 minutes at 9pm for the next three months',
    });
    expect(session.questionCount).toBe(0);
    expect(session.question).toBeNull();
    expect(session.canGenerate).toBe(true);

    h.ai.queue('DRAFT_GENERATION', {
      title: 'Read More',
      description: 'A nightly reading habit that grows.',
      category: 'READING',
      targetType: 'HABIT',
      deadline: day(90),
      rationale: 'You said 10 pages every day at 9pm, so the plan starts there and builds.',
      tasks: [{
        title: 'Read',
        description: 'Read before bed.',
        recurrence: { type: 'EVERY_DAY' },
        estimatedMinutes: 20,
        preferredTime: '21:00',
        reason: 'You said 9pm suits you.',
        progression: {
          metricType: 'PAGES',
          unitLabel: 'pages',
          stages: [{ target: 10, minDays: 7 }, { target: 15, minDays: 7 }, { target: 20, minDays: 7 }],
        },
      }],
    });

    const { draft } = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${session.sessionId}/generate`,
    );
    expect(draft.tasks[0].progression.stages.map((s: any) => s.target)).toEqual([10, 15, 20]);

    const confirmed = await h.ok(user, 'POST', `/api/copilot/goal-drafts/${draft.id}/confirm`);
    const today = await h.ok(user, 'GET', '/api/today');
    const group = today.groups.find((g: any) => g.goalId === confirmed.goalId);
    expect(group).toBeDefined();
    const task = group.tasks[0];
    expect(task.title).toBe('Read');
    expect(task.progression).toEqual({
      target: 10, unitLabel: 'pages', metricType: 'PAGES', stageLabel: 'Stage 1 of 3',
    });

    const definition = await prisma.taskDefinition.findFirstOrThrow({
      where: { goalId: confirmed.goalId },
    });
    const { progression } = await h.ok(user, 'GET', `/api/tasks/${definition.id}/progression`);
    expect(progression.stages).toEqual([
      { stageIndex: 0, target: 10, label: '', minDays: 7, state: 'CURRENT' },
      { stageIndex: 1, target: 15, label: '', minDays: 7, state: 'UPCOMING' },
      { stageIndex: 2, target: 20, label: '', minDays: 7, state: 'UPCOMING' },
    ]);

    const targets = await prisma.taskOccurrence.findMany({
      where: { taskDefinitionId: definition.id },
      select: { progressionTarget: true },
      distinct: ['progressionTarget'],
    });
    expect(targets.map((t) => t.progressionTarget)).toEqual([10]);
  });

  // ------------------------------------------------------------------- PART 49

  it('PART 49 Ã¢â‚¬â€ the Copilot explains a live goal and may not change it', async () => {
    const user = await h.createUser({ timezone: TZ });

    // Three weeks of history, so the numbers the Copilot quotes are real.
    const { goal } = await h.ok(user, 'POST', '/api/goals', {
      title: 'Get Fit',
      category: 'FITNESS',
      targetType: 'HABIT',
      startDate: day(-20),
      tasks: [{ title: 'Walk', recurrenceType: 'EVERY_DAY', reward: 10, startDate: day(-20) }],
    });

    const task = await prisma.taskDefinition.findFirstOrThrow({ where: { goalId: goal.id } });
    await createProgressionPlan({
      taskDefinitionId: task.id,
      metricType: 'MINUTES',
      unitLabel: 'min',
      stages: [{ target: 25 }, { target: 40 }, { target: 60 }],
    });

    // As if it advanced to 40 minutes a week ago and has been slipping since.
    const plan = await prisma.progressionPlan.findFirstOrThrow({
      where: { taskDefinitionId: task.id },
    });
    await prisma.progressionPlan.update({
      where: { id: plan.id },
      data: { currentStageIndex: 1, stageStartedOn: day(-7) },
    });
    await prisma.taskOccurrence.updateMany({
      where: { taskDefinitionId: task.id },
      data: { progressionStageIndex: 1, progressionTarget: 40 },
    });

    // Six of the last fourteen days done Ã¢â‚¬â€ a real, unimpressive 43%.
    const recent = await prisma.taskOccurrence.findMany({
      where: { taskDefinitionId: task.id, dueDate: { gte: day(-13), lte: day(0) } },
      orderBy: { dueDate: 'asc' },
    });
    expect(recent).toHaveLength(14);
    await prisma.taskOccurrence.updateMany({
      where: { id: { in: recent.slice(0, 6).map((o) => o.id) } },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    h.ai.respond('PROGRESS_ANALYSIS', {
      explanation:
        'You have completed 6 of the last 14 walks. The jump to 40 minutes is the change that stopped it working.',
      suggestions: [
        {
          summary: 'Drop back to 25 minutes until the habit is steady again.',
          taskTitle: 'Walk',
          proposedMinutes: 25,
          proposedProgressionAction: 'REDUCE',
        },
      ],
    });

    const answer = await h.ok(user, 'POST', `/api/goals/${goal.id}/copilot`, {
      message: 'Why am I falling behind?',
    });

    // The explanation is grounded in figures the backend computed, not invented ones.
    expect(answer.summary.goalTitle).toBe('Get Fit');
    expect(answer.summary.eligibleTaskOccurrences).toBe(14);
    expect(answer.summary.completedTaskOccurrences).toBe(6);
    expect(answer.summary.schedule[0].progression).toMatchObject({
      stageLabel: 'Stage 2 of 3',
      currentTarget: 40,
      unitLabel: 'min',
      atFinalStage: false,
    });
    const sent = h.ai.promptsFor('PROGRESS_ANALYSIS', 'user');
    expect(sent).toContain('"completedTaskOccurrences": 6');
    expect(sent).toContain('Why am I falling behind?');

    // It proposed a reduction Ã¢â‚¬â€ and was refused. The Copilot is never an authorised
    // source for a stage change, however sensible the suggestion is.
    expect(answer.progressionProposals).toHaveLength(1);
    expect(answer.progressionProposals[0]).toMatchObject({
      taskTitle: 'Walk',
      requested: 'REDUCE',
      applied: false,
    });
    expect(answer.progressionProposals[0].reason).toMatch(/copilot/i);

    const afterAsking = await prisma.progressionPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(afterAsking.currentStageIndex).toBe(1);

    // The preview the user sees before deciding. Read-only, and it says so.
    const preview = await h.ok(user, 'GET', `/api/tasks/${task.id}/progression/review`);
    expect(preview.review.applied).toBe(false);
    expect(preview.progression.currentStageIndex).toBe(1);
    expect(
      (await prisma.progressionPlan.findUniqueOrThrow({ where: { id: plan.id } })).currentStageIndex,
    ).toBe(1);

    // Now the person presses the button. That request is authorised, and a reduction
    // is always allowed Ã¢â‚¬â€ you may always make your own goal easier.
    const applied = await h.ok(user, 'POST', `/api/tasks/${task.id}/progression/decision`, {
      action: 'REDUCE',
    });
    expect(applied.applied).toBe(true);
    expect(applied.progression.currentStageIndex).toBe(0);
    expect(applied.progression.currentTarget).toBe(25);

    // The days that have already happened still say 40. They really did ask for 40 at
    // the time, and rewriting them would rewrite the user's history.
    const past = await prisma.taskOccurrence.findMany({
      where: { taskDefinitionId: task.id, dueDate: { lte: day(0) } },
      select: { dueDate: true, progressionTarget: true, progressionStageIndex: true },
    });
    expect(past.length).toBeGreaterThan(14);
    expect(past.every((o) => o.progressionTarget === 40)).toBe(true);
    expect(past.every((o) => o.progressionStageIndex === 1)).toBe(true);

    // Tomorrow onwards asks for 25.
    const future = await prisma.taskOccurrence.findMany({
      where: { taskDefinitionId: task.id, dueDate: { gt: day(0) } },
      select: { progressionTarget: true, progressionStageIndex: true },
    });
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((o) => o.progressionTarget === 25)).toBe(true);
    expect(future.every((o) => o.progressionStageIndex === 0)).toBe(true);

    // The decision is on the record either way Ã¢â‚¬â€ the refused proposal and the applied
    // one both, with their sources.
    const decisions = await prisma.progressionDecision.findMany({
      where: { planId: plan.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(decisions.map((d) => [d.source, d.appliedAt !== null])).toEqual([
      ['COPILOT', false],
      ['USER', true],
    ]);
  });

  // ------------------------------------------------------------------- PART 59

  it('PART 59 Ã¢â‚¬â€ memory from one goal does not reach an unrelated goal', async () => {
    const user = await h.createUser({ timezone: TZ });

    // What a previous fitness conversation learned about them.
    await prisma.userPreference.createMany({
      data: [
        {
          userId: user.id,
          scope: 'CATEGORY',
          category: 'FITNESS',
          key: 'preferred_activity',
          value: 'swimming',
          confidence: 0.9,
        },
        {
          userId: user.id,
          scope: 'CATEGORY',
          category: 'FITNESS',
          key: 'disliked_activity',
          value: 'running',
          confidence: 0.9,
        },
      ],
    });

    h.ai.respond('INTERVIEW', () =>
      asks({
        id: 'monthly_amount',
        type: 'NUMBER',
        prompt: 'How much could you set aside each month?',
        unit: 'USD',
      }),
    );

    await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'Save $3,000 for a trip to Italy',
    });

    // The money conversation is told nothing about swimming. Note this asserts on the
    // user message only: the system prompt contains "actually I meant swimming" as a
    // worked example of a correction, which is not a leak.
    const finance = h.ai.promptsFor('INTERVIEW', 'user');
    expect(finance).toContain('Save $3,000 for a trip to Italy');
    expect(finance).toContain('(none on file)');
    expect(finance).not.toMatch(/swimming/i);
    expect(finance).not.toMatch(/running/i);

    // The control, which is what makes the assertion above worth anything: the same
    // memories DO reach a fitness goal, so their absence is the gate working rather
    // than the preferences never having been stored.
    h.ai.requests.length = 0;
    await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fit and exercise more',
    });

    const fitness = h.ai.promptsFor('INTERVIEW', 'user');
    expect(fitness).toContain('preferred_activity: swimming');
    expect(fitness).toContain('disliked_activity: running');

    // And nothing about the finance goal was invented into memory along the way.
    const stored = await prisma.userPreference.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(2);
    expect(stored.every((p) => p.category === 'FITNESS')).toBe(true);
  });

  // ------------------------------------------------------------------- PART 60

  it('PART 60 — goal chat learns durable preferences into memory', async () => {
    const user = await h.createUser({ timezone: TZ });
    const { goal } = await h.ok(user, 'POST', '/api/goals', {
      title: 'Read More Books',
      category: 'READING',
      targetType: 'HABIT',
      tasks: [{
        title: 'Read',
        recurrenceType: 'TIMES_PER_WEEK',
        recurrenceConfig: { timesPerWeek: 2 },
      }],
    });

    // The extraction runs in the background, so the answer arrives first; give
    // the floating promise a beat to land before asserting on the table.
    h.ai.respond('PROGRESS_ANALYSIS', {
      explanation: 'Two sessions a week is a solid start.',
      suggestions: [],
    });
    h.ai.queue('PREFERENCE_EXTRACTION', {
      preferences: [
        {
          key: 'preferred_time_of_day',
          value: 'evenings',
          scope: 'CATEGORY',
          category: 'READING',
          confidence: 0.9,
          persistence: 'LONG_TERM',
        },
      ],
    });

    const answer = await h.ok(user, 'POST', `/api/goals/${goal.id}/copilot`, {
      message: 'I can only read in the evenings after work — how am I doing?',
    });
    expect(answer.intent).toBe('PROGRESS');

    await vi.waitFor(async () => {
      const stored = await prisma.userPreference.findMany({ where: { userId: user.id } });
      expect(stored).toHaveLength(1);
    });
    const stored = await prisma.userPreference.findMany({ where: { userId: user.id } });
    expect(stored[0]).toMatchObject({
      key: 'preferred_time_of_day',
      value: 'evenings',
      scope: 'CATEGORY',
      category: 'READING',
      confidence: 0.9,
      source: 'COPILOT',
    });

    // The panel's read endpoint serves exactly what was learned.
    const panel = await h.ok(user, 'GET', '/api/copilot/preferences');
    expect(panel.preferences).toHaveLength(1);
    expect(panel.preferences[0]).toMatchObject({ key: 'preferred_time_of_day', value: 'evenings' });
  });

  // ------------------------------------------------- P0 correctness fixes
  //
  // Four behaviours the interview and draft flow are now required to have:
  // a provider outage is never dressed up as a plan; two racing requests
  // cannot build two goals; a generate request that quotes an old revision is
  // refused; and an unfinished interview does not get a plan invented for it
  // unless the user insists.

  /** A frequency question the model asks first for a vague goal. */
  const frequencyQuestion = asks({
    id: 'days_per_week',
    type: 'NUMBER',
    prompt: 'How many days a week can you train?',
  });

  it('P0 Ã¢â‚¬â€ a provider outage is a 503, and no fake plan is left behind', async () => {
    const user = await h.createUser({ timezone: TZ });

    // Walk the interview to a legitimately ready state, one grounded atom per
    // turn: the stated outcome arrives with the opening message ('get fitter'
    // is in it), and each answer turn re-affirms only what ITS answer text
    // grounds — the numbers and the date are the literal answers.
    h.ai.queue(
      'INTERVIEW',
      asksWithReq(
        { id: 'days_per_week', type: 'NUMBER', prompt: 'How many days a week can you train?' },
        [outcomeAtom('get fitter', 'get fitter')],
      ),
      asksWithReq(
        { id: 'session_minutes', type: 'NUMBER', prompt: 'How many minutes per session?' },
        [freqAtom(3, '3')],
      ),
      asksWithReq(
        { id: 'deadline', type: 'DATE', prompt: 'By when do you want to reach it?' },
        [deadlineAtom(day(60), day(60))],
      ),
      readyWithReq([lengthAtom(30, '30')]),
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });
    await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'gap_weekly_capacity',
      answer: 3,
    });
    await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'gap_timeframe',
      answer: day(60),
    });
    const finished = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/answers`,
      { questionId: 'gap_session_shape', answer: 30 },
    );
    expect(finished.canGenerate).toBe(true);

    // The provider dies exactly where the plan would have been built.
    h.ai.respond('DRAFT_GENERATION', () => {
      throw new AiProviderError('Stub provider timed out', 'TIMEOUT');
    });

    const response = await h.call(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/generate`,
    );
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('AI_TIMEOUT');

    // The requirement this test exists for: nothing was persisted in place of
    // a plan, and the session is not stuck at GENERATING Ã¢â‚¬â€ it can try again.
    expect(await prisma.goalDraft.count({ where: { sessionId: started.sessionId } })).toBe(0);
    const session = await prisma.copilotSession.findUniqueOrThrow({
      where: { id: started.sessionId },
    });
    expect(['INTERVIEWING', 'READY_TO_GENERATE']).toContain(session.status);
  });

  it('P0 Ã¢â‚¬â€ racing generates build one draft, and racing confirms create one goal', async () => {
    const user = await h.createUser({ timezone: TZ });

    h.ai.queue(
      'INTERVIEW',
      asksWithReq(
        { id: 'days_per_week', type: 'NUMBER', prompt: 'How many days a week can you train?' },
        [outcomeAtom('get fitter', 'get fitter')],
      ),
      asksWithReq(
        { id: 'session_minutes', type: 'NUMBER', prompt: 'How many minutes per session?' },
        [freqAtom(3, '3')],
      ),
      asksWithReq(
        { id: 'deadline', type: 'DATE', prompt: 'By when do you want to reach it?' },
        [deadlineAtom(day(60), day(60))],
      ),
      readyWithReq([lengthAtom(30, '30')]),
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });
    await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'gap_weekly_capacity',
      answer: 3,
    });
    await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'gap_timeframe',
      answer: day(60),
    });
    await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'gap_session_shape',
      answer: 30,
    });

    h.ai.queue('DRAFT_GENERATION', {
      title: 'Feel strong and energetic again',
      description: 'Three sessions to rebuild the habit.',
      category: 'FITNESS',
      deadline: day(60),
      targetType: 'HABIT',
      rationale: 'You said three days a week suits you, so the plan starts there.',
      tasks: [
        {
          title: 'Brisk walk Ã¢â‚¬â€ regular movement',
          description: 'A steady walk at a pace you can still talk at.',
          recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 },
          estimatedMinutes: 30,
          reason: 'Feel strong and energetic again with three sessions a week.',
        },
      ],
    });

    // Two generates enter at the same time. Exactly one may run the model; the
    // other either gets the winner's draft back or a clean conflict Ã¢â‚¬â€ never a
    // second draft and never a 500.
    const generates = await Promise.allSettled([
      h.call(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/generate`),
      h.call(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/generate`),
    ]);
    const generateResponses = generates.map((g) => {
      expect(g.status).toBe('fulfilled');
      return (g as PromiseFulfilledResult<any>).value;
    });
expect(generateResponses.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(generateResponses.some((r) => r.status === 200)).toBe(true);
    expect(h.ai.countOf('DRAFT_GENERATION')).toBe(1);
    expect(await prisma.goalDraft.count({ where: { sessionId: started.sessionId } })).toBe(1);

    const draft = generateResponses.find((r) => r.status === 200)!.body.draft;

    // Both confirms enter at the same time. Exactly one Goal may appear.
    const confirms = await Promise.allSettled([
      h.call(user, 'POST', `/api/copilot/goal-drafts/${draft.id}/confirm`),
      h.call(user, 'POST', `/api/copilot/goal-drafts/${draft.id}/confirm`),
    ]);
    const confirmResponses = confirms.map((c) => {
      expect(c.status).toBe('fulfilled');
      return (c as PromiseFulfilledResult<any>).value;
    });
    expect(confirmResponses.every((r) => r.status === 200)).toBe(true);
    const created = confirmResponses.filter((r) => r.body.alreadyCreated === false);
    expect(created).toHaveLength(1);
    // Both learn the same goal Ã¢â‚¬â€ the second sees what the first created.
    expect(new Set(confirmResponses.map((r) => r.body.goalId)).size).toBe(1);
    expect(await prisma.goal.count({ where: { ownerId: user.id } })).toBe(1);
  });

  it('P0 Ã¢â‚¬â€ a generate request quoting a stale revision is refused', async () => {
    const user = await h.createUser({ timezone: TZ });

    h.ai.queue('INTERVIEW', frequencyQuestion);
    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });

    const snapshot = await h.ok(user, 'GET', `/api/copilot/goal-sessions/${started.sessionId}`);
    expect(snapshot.revision).toBeGreaterThan(0);
    expect(snapshot.readiness.ready).toBe(false);

    // One revision behind Ã¢â‚¬â€ the interview moved on since this caller looked.
    const stale = await h.call(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/generate`,
      { revision: snapshot.revision - 1 },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REQUEST');
    // The refusal happened before any model call or claim.
    expect(h.ai.countOf('DRAFT_GENERATION')).toBe(0);

    // The current revision passes the staleness gate Ã¢â‚¬â€ and then hits the
    // readiness one, because nothing has been answered yet.
    const fresh = await h.call(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/generate`,
      { revision: snapshot.revision },
    );
    expect(fresh.status).toBe(409);
    expect(fresh.body.code).toBe('NOT_READY');
  });

  it('P0 — an unfinished interview refuses to generate unless the user insists', async () => {
    const user = await h.createUser({ timezone: TZ });

    // The model keeps trying to end the interview; the AST gate keeps
    // refusing until required coverage is met. The gate question ids are
    // deterministic, and the answers below follow them in order.
    h.ai.queue(
      'INTERVIEW',
      frequencyQuestion,
      asksWithReq(
        { id: 'session_minutes', type: 'NUMBER', prompt: 'How many minutes per session?' },
        [outcomeAtom('move more', 'I just want to move more')],
      ),
      readyWithReq([freqAtom(3, '3')]),
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });
    expect(started.readiness.ready).toBe(false);
    expect(started.readiness.missing[0]).toBe('DESIRED_OUTCOME');

    // Zero questions answered: the gate refuses, and force is not available
    // below two questions.
    const generateUrl = `/api/copilot/goal-sessions/${started.sessionId}/generate`;
    const early = await h.call(user, 'POST', generateUrl, {});
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('NOT_READY');
    const forcedEarly = await h.call(user, 'POST', generateUrl, { force: true });
    expect(forcedEarly.status).toBe(409);
    expect(forcedEarly.body.code).toBe('NOT_READY');

    // The model's ready() is downgraded; the deterministic gate question for
    // the first blocking gap (DESIRED_OUTCOME) is what the user actually sees.
    const second = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/answers`,
      { questionId: 'gap_desired_outcome', answer: 'I just want to move more' },
    );
    expect(second.canGenerate).toBe(false);
    expect(second.question.id).toBe('gap_weekly_capacity');
    expect(second.questionCount).toBe(2);

    // The outcome landed; the frequency answer is deterministically ingested,
    // but the timeframe is still a BLOCKING gap — the gate keeps refusing.
    const third = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/answers`,
      { questionId: 'gap_weekly_capacity', answer: 3 },
    );
    expect(third.readiness.ready).toBe(false);
    expect(third.canGenerate).toBe(false);
    expect(third.question?.id).toBe('gap_timeframe');

    // The plain generate is still refused: required coverage is incomplete.
    const refused = await h.call(user, 'POST', generateUrl, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NOT_READY');

    // Two questions were asked, so the user may insist — and the forced plan
    // says out loud what it rests on: limited information, no deadline.
    h.ai.queue('DRAFT_GENERATION', {
      title: 'Move More',
      description: 'A starting plan built from limited answers.',
      category: 'FITNESS',
      targetType: 'HABIT',
      rationale: 'Built from what little was gathered; edit freely.',
      tasks: [
        {
          title: 'Move more — short walk',
          description: 'Ten minutes, any pace.',
          recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 },
          estimatedMinutes: 10,
          reason: 'Matches the days you gave.',
        },
      ],
    });
    const forced = await h.ok(user, 'POST', generateUrl, { force: true });
    expect(forced.assumptions).toContain(
      'Generated with limited information — the plan uses only what you told me.',
    );
    expect(forced.assumptions).toContain(
      'No deadline was provided, so this plan focuses on steady weekly progress.',
    );
    expect(forced.readiness.ready).toBe(false);
    // The forced plan rests on an incomplete interview: the timeframe is the
    // blocking gap that remains, and the response says so.
    expect(forced.missingDimensions).toContain('TIMEFRAME');
  });

  it('asks one clarification instead of starting an interview for a question, and creates on confirmation', async () => {
    const user = await h.createUser({ timezone: TZ });

    // A product question must not become an interview. The classifier decides
    // deterministically, so no model call is queued or spent here.
    const routed = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'What happens if I miss a day?',
    });
    expect(routed).toEqual({
      routed: false,
      intent: 'PRODUCT_HELP',
      clarification: 'Do you want me to create a goal for this, or are you asking a question?',
    });
    expect(await prisma.copilotSession.count({ where: { userId: user.id } })).toBe(0);

    // The user answers the clarification: the same words now start the session.
    h.ai.queue(
      'INTERVIEW',
      asks({ id: 'days_per_week', type: 'NUMBER', prompt: 'How many days per week can you commit to?' }),
    );
    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'What happens if I miss a day?',
      intentAnswer: 'goal',
    });
    expect(started.sessionId).toBeDefined();
    expect(started.question.id).toBe('gap_desired_outcome');
  });

  it('answers a product-mechanics interruption without consuming the pending question', async () => {
    const user = await h.createUser({ timezone: TZ });
    const prompt = 'How many days per week can you commit to?';
    h.ai.queue('INTERVIEW', asks({ id: 'days_per_week', type: 'NUMBER', prompt }));

    const first = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });

    // The user types a product question where an answer is expected. The
    // interview must keep its pending question Ã¢â‚¬â€ no model turn runs, nothing
    // is recorded, and the count does not move.
    const interrupted = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: 'gap_weekly_capacity', answer: 'Wait Ã¢â‚¬â€ what happens if I miss one?' },
    );
    expect(interrupted.questionId ?? interrupted.question?.id).toBe('gap_desired_outcome');
    expect(interrupted.question?.id).toBe('gap_desired_outcome');
    expect(interrupted.questionCount).toBe(1);
    expect(interrupted.assistantMessage).toContain('on the way');
    expect(h.ai.countOf('INTERVIEW')).toBe(1);

    // And the very next message can still be the real answer: one more model
    // turn runs, the count moves, and the pending question is finally spent.
    h.ai.queue(
      'INTERVIEW',
      ready('Nice Ã¢â‚¬â€ that is exactly what I needed.'),
    );
    const answered = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: 'gap_desired_outcome', answer: 4 },
    );
    expect(answered.questionCount).toBe(2);
    expect(h.ai.countOf('INTERVIEW')).toBe(2);
  });

  // ------------------------------------------------------- release regression

  it('starts the interview for "I want to read more" when the model extraction is valid', async () => {
    const user = await h.createUser({ timezone: TZ });

    // The exact production defect: this CREATE_GOAL input returned the generic
    // saved-answer failure on every attempt because the interview turn's
    // provider timeout was set below the model's real latency. A valid model
    // extraction must enter the interview instead.
    h.ai.queue(
      'INTERVIEW',
      asksWithReq(
        { id: 'days_per_week', type: 'NUMBER', prompt: 'How many days a week would you like to read?' },
        [{ property: 'goal.outcome', scope: 'goal', relation: 'contains', value: { kind: 'text', value: 'read more' }, strength: 'REQUIRED', source: 'stated', evidence: 'read more' }],
        'Reading more is a great habit to build.',
      ),
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to read more',
    });

    // The interview opened: a real question is pending, the turn is not the
    // generic saved-answer failure, and the state is fresh.
    expect(started.extractionFailed).toBe(false);
    expect(started.assistantMessage).not.toBe(
      "I couldn't process that just now — your answer is saved. Try again in a moment.",
    );
    expect(started.question).not.toBeNull();
    expect(started.status).toBe('INTERVIEWING');

    // The extraction was ingested: the stated outcome is ACTIVE and the gate
    // is asking its deterministic next question.
    expect(started.requirements.ready).toBe(false);
    expect(started.requirements.activeRecords).toBeGreaterThan(0);

    // The fix itself: the interview turn must be sent with a timeout above
    // the provider's measured latency tail — never the 6s cap that timed every
    // call out.
    const interviewRequest = h.ai.requests.find((r) => r.purpose === 'INTERVIEW');
    expect(interviewRequest?.timeoutMs).toBe(60_000);
  });

  it('RC-P1-C — a vague opening asks its gap question without inventing requirements (e2e)', async () => {
    const user = await h.createUser({ timezone: TZ });

    // The post-fix model contract, as a valid turn: the model asks its
    // frequency question and extracts ONLY what the user stated (the outcome).
    // No frequency atom exists — unknown information is a gap, not an atom.
    h.ai.queue(
      'INTERVIEW',
      asksWithReq(
        { id: 'days_per_week', type: 'NUMBER', prompt: 'How many days a week would you like to read?' },
        [{ property: 'goal.outcome', scope: 'goal', relation: 'contains', value: { kind: 'text', value: 'read more' }, strength: 'REQUIRED', source: 'stated', evidence: 'read more' }],
        'Reading more is a great habit to build.',
      ),
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to read more',
    });

    // The interview opened with a genuine question. The deterministic gate
    // replaces the model's own frequency question with the registered gap
    // question for the same slot — that replacement IS the architecture.
    expect(started.question?.id).toBe('gap_weekly_capacity');
    expect(started.extractionFailed).toBe(false);

    // The stated outcome closed its group; weekly capacity is still a gap.
    expect(started.requirements.missing).toContain('WEEKLY_CAPACITY');
    expect(started.requirements.missing).not.toContain('DESIRED_OUTCOME');

    // RC-P1-B, end to end: even when the model DOES emit a fabricated
    // frequency atom (ungrounded evidence), it may not close coverage.
    h.ai.queue(
      'INTERVIEW',
      asksWithReq(
        { id: 'session_length', type: 'NUMBER', prompt: 'How many minutes per session?' },
        [
          // Grounded outcome re-affirmation...
          { property: 'goal.outcome', scope: 'goal', relation: 'contains', value: { kind: 'text', value: 'read more' }, strength: 'REQUIRED', source: 'stated', evidence: 'read more' },
          // ...and a fabricated frequency whose "evidence" is not the user's words.
          { property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq', value: { kind: 'count', value: 3 }, strength: 'REQUIRED', source: 'stated', evidence: 'How many days a week would you like to read?' },
        ],
        'How many minutes per session?',
      ),
    );
    const answered = await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'gap_weekly_capacity',
      answer: 3,
    });

    // The user's OWN answer grounded the frequency; the fabricated one could
    // not close it before, and cannot outrank the user's answer now.
    expect(answered.requirements.missing).not.toContain('WEEKLY_CAPACITY');
    const sessionRow = await prisma.copilotSession.findUniqueOrThrow({
      where: { id: started.sessionId },
    });
    const state = parseRequirementStateOf(sessionRow);
    const freq = state.records.filter(
      (r) => r.status === 'ACTIVE' && r.property === 'schedule.frequency.count',
    );
    expect(freq.length).toBeGreaterThan(0);
    expect(freq.every((r) => r.provenance === 'USER_EXPLICIT')).toBe(true);

    // Generation is refused while required gaps remain open — the gate asks on.
    const refused = await h.call(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/generate`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NOT_READY');
  });

  it('RC-P1-D — a model that extracts nothing cannot livelock the outcome question (e2e)', async () => {
    const user = await h.createUser({ timezone: TZ });

    // The exact live production failure shape, reproduced with the stub: the
    // model parses fine but its requirements channel carries ZERO atoms —
    // what nemotron-3.5-lightning-30b-a3b actually returns today. Pre-fix,
    // gap_desired_outcome re-asked forever because DESIRED_OUTCOME (required
    // coverage) had no ingest path other than model extraction.
    const emptyExtraction = () => ({
      state: 'NEEDS_MORE_INFORMATION',
      assistantMessage: 'What result would make this goal successful?',
      question: {
        id: 'some_model_question',
        type: 'FREE_TEXT',
        prompt: 'What result would make this goal successful?',
        allowCustomAnswer: true,
        optional: false,
      },
      extractedContext: {},
      requirements: { atoms: [], groups: [], pendingAmbiguity: [] },
    });
    h.ai.respond('INTERVIEW', emptyExtraction);

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });
    expect(started.question?.id).toBe('gap_desired_outcome');

    // The user answers the outcome question in their own words.
    const answered = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/answers`,
      {
        questionId: 'gap_desired_outcome',
        answer: 'A noticeable improvement within ten weeks',
      },
    );

    // RC-P1-D: the deterministic ingest closes DESIRED_OUTCOME from the
    // literal answer even though the model extracted nothing — the gate
    // moves ON instead of re-asking the same question.
    expect(answered.requirements.missing).not.toContain('DESIRED_OUTCOME');
    expect(answered.question?.id).not.toBe('gap_desired_outcome');
    expect(answered.requirements.activeRecords).toBeGreaterThan(0);

    // The outcome record is the user's own words at USER_EXPLICIT.
    const sessionRow = await prisma.copilotSession.findUniqueOrThrow({
      where: { id: started.sessionId },
    });
    const state = parseRequirementStateOf(sessionRow);
    const outcome = state.records.find(
      (r) => r.property === 'goal.outcome' && r.status === 'ACTIVE',
    );
    expect(outcome?.provenance).toBe('USER_EXPLICIT');
    expect((outcome?.value as { value: string }).value).toContain('noticeable improvement');
  });

  it('still saves the answer and refuses to generate when the extraction genuinely fails (R1)', async () => {
    const user = await h.createUser({ timezone: TZ });

    // The stale-extraction safety behavior is untouched by the fix: a genuine
    // provider failure on the first turn still saves the message, marks the
    // state stale, and generates nothing.
    h.ai.fail('INTERVIEW', new AiProviderError('The AI took too long to respond', 'TIMEOUT'));

    const started = await h.call(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to read more',
    });
    expect(started.status).toBe(200);
    expect(started.body.assistantMessage).toBe(
      "I couldn't process that just now — your answer is saved. Try again in a moment.",
    );
    expect(started.body.extractionFailed).toBe(true);
    expect(started.body.canForce).toBe(false);

    // The message was persisted before the model call, exactly as designed.
    const session = await prisma.copilotSession.findUniqueOrThrow({
      where: { id: started.body.sessionId },
      include: { messages: true },
    });
    expect(session.messages.map((m) => m.content)).toContain('I want to read more');
    expect(parseRequirementStateOf(session).meta?.lastTurnExtraction).toBe('failed');

    // Generation is refused from stale state, and force is unavailable.
    const refused = await h.call(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.body.sessionId}/generate`,
      { force: true },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NOT_READY');
  });

  it('RC-P1-E — no ghost question: a discarded model question never survives as the visible message (e2e)', async () => {
    const user = await h.createUser({ timezone: TZ });

    // The exact live defect: the user's final answer closes all blocking and
    // HIGH gaps, so the gate concludes — but the model's reply STILL asks a
    // discretionary question ("Which days of the week suit your reading
    // sessions?"). Pre-fix, the gate discarded the question object while
    // keeping the model's question prose as assistantMessage: the UI showed
    // an unanswerable question next to the Build Plan button.
    h.ai.queue(
      'INTERVIEW',
      asksWithReq(
        { id: 'days_per_week', type: 'NUMBER', prompt: 'How many days a week would you like to read?' },
        [outcomeAtom('read more', 'read more')],
      ),
      // Intermediate turns the model produces while the gate walks its own
      // remaining questions (timeframe, then session shape). Their atoms are
      // empty: every required value comes from the deterministic ingests.
      asksWithReq({ id: 'when_by', type: 'DATE', prompt: 'By when?' }, []),
      asksWithReq({ id: 'how_long', type: 'NUMBER', prompt: 'How long per session?' }, []),
      // The model asks a discretionary weekday question exactly when the
      // final HIGH answer arrived — the gate must discard it COHERENTLY.
      {
        state: 'NEEDS_MORE_INFORMATION',
        assistantMessage: 'Which days of the week suit your reading sessions?',
        question: {
          id: 'weekdays_pref',
          type: 'MULTI_SELECT',
          prompt: 'Which days of the week suit your reading sessions?',
          options: ['Monday', 'Wednesday', 'Friday'],
          allowCustomAnswer: true,
          optional: true,
        },
        extractedContext: {},
        requirements: { atoms: [], groups: [], pendingAmbiguity: [] },
      },
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to read more',
    });
    expect(started.question?.id).toBe('gap_weekly_capacity');

    // The gate's own walk: capacity, timeframe, session shape — every answer
    // deterministically ingested, so all blocking AND HIGH gaps close.
    const capped = await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'gap_weekly_capacity', answer: 3,
    });
    expect(capped.question?.id).toBe('gap_timeframe');
    const timed = await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'gap_timeframe', answer: day(60),
    });
    expect(timed.question?.id).toBe('gap_session_shape');
    const finished = await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'gap_session_shape', answer: 45,
    });

    // Coherent READY state: no question object, generation unlocked, and the
    // visible message is NOT the discarded question.
    expect(finished.question).toBeNull();
    expect(finished.canGenerate).toBe(true);
    expect(finished.status).toBe('READY_TO_GENERATE');
    expect(finished.assistantMessage).not.toContain('Which days');
    expect(finished.assistantMessage).not.toMatch(/\?\s*$/);

    // The persisted transcript bubble carries the same coherent message.
    const sessionRow = await prisma.copilotSession.findUniqueOrThrow({
      where: { id: started.sessionId },
      include: { messages: true },
    });
    const lastAssistant = [...sessionRow.messages]
      .reverse()
      .find((m) => m.role === 'assistant')!;
    expect(lastAssistant.content).toBe(finished.assistantMessage);
    expect(lastAssistant.structuredPayload).toBeNull();
  });

  it('RC-P1-E control — a BLOCKING model question is never discarded while gaps remain', async () => {
    const user = await h.createUser({ timezone: TZ });

    // The coherence fix must not overreach: while a required gap is open, the
    // gate still replaces the model's question with the deterministic one for
    // the blocker (that replacement is the architecture), and the message the
    // user sees matches that question.
    h.ai.queue(
      'INTERVIEW',
      asksWithReq(
        { id: 'days_per_week', type: 'NUMBER', prompt: 'How many days a week would you like to read?' },
        [outcomeAtom('read more', 'read more')],
      ),
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to read more',
    });
    expect(started.question?.id).toBe('gap_weekly_capacity');
    // The gate's own question is what the user sees — coherent by construction.
    expect(started.assistantMessage).toBe(started.question?.prompt);
  });

  it('RC-P1-H — a deterministically-ingested answer survives its provider timeout (e2e)', async () => {
    const user = await h.createUser({ timezone: TZ });

    // The exact live failure (frozen-100 cases 3, 4, 9, 17, 30, 97, 7, 21, 98,
    // 99): the user answers a registered gap question; the deterministic
    // ingest writes the atom; the answer turn's MODEL call then times out.
    // The answer is genuinely saved — the state is fresh, not stale — so the
    // interview must move on, generate must be possible, and the just-answered
    // question must never be re-presented.
    let turns = 0;
    h.ai.respond('INTERVIEW', () => {
      turns += 1;
      if (turns === 1) {
        return {
          state: 'NEEDS_MORE_INFORMATION',
          assistantMessage: 'What result would make this goal successful?',
          question: { id: 'any_q', type: 'FREE_TEXT', prompt: 'What result would make this goal successful?', allowCustomAnswer: true, optional: false },
          extractedContext: {},
          requirements: { atoms: [], groups: [], pendingAmbiguity: [] },
        };
      }
      throw new AiProviderError('The AI took too long to respond', 'TIMEOUT');
    });

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'prepare for an exam',
    });
    expect(started.question?.id).toBe('gap_desired_outcome');

    const answered = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/answers`,
      {
        questionId: 'gap_desired_outcome',
        answer: 'A pass on the certification exam',
      },
    );

    // The deterministic ingest closed DESIRED_OUTCOME even though the answer
    // turn's model call died. The state is NOT stale: the gate runs on it.
    expect(answered.requirements.missing).not.toContain('DESIRED_OUTCOME');
    // The just-answered question is never re-presented.
    expect(answered.question?.id).not.toBe('gap_desired_outcome');
    expect(answered.assistantMessage).not.toMatch(/hiccup/i);

    // Generation is not blocked by a stale-extraction flag the answer already
    // survived: required coverage can close and generate succeeds.
    const cap = await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: answered.question?.id ?? 'gap_weekly_capacity',
      answer: 3,
    });
    const timed = await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: cap.question?.id ?? 'gap_timeframe',
      answer: day(60),
    });

    h.ai.queue('DRAFT_GENERATION', {
      title: 'Certification Prep',
      description: 'Steady exam preparation.',
      category: 'STUDY',
      targetType: 'HABIT',
      deadline: day(60),
      rationale: 'Built from the answers you gave.',
      tasks: [{
        title: 'Study — exam prep',
        description: 'Focused review.',
        recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 },
        estimatedMinutes: 30,
        reason: 'Matches the days you gave.',
      }],
    });
    // Answer turns keep timing out; the DRAFT call must still be possible.
    const generated = await h.call(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/generate`,
      {},
    );
    // Ready coverage closed deterministically, so generate succeeds even
    // though interview model turns have been failing.
    expect(generated.status).toBe(200);
    expect(generated.body.draft?.title).toBe('Certification Prep');
  });
});

/** The stored requirement state of a session row, for the R1 assertions. */
function parseRequirementStateOf(session: { structuredContext: string }) {
  return parseRequirementState(session.structuredContext);
}
