// PARTS 48-52 and 59 — the Copilot half of the Phase 2.5 acceptance suite.
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

import { describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../domain/dates.js';
import { prisma } from '../lib/prisma.js';
import { createProgressionPlan } from '../services/progression.js';
import { useHarness } from './harness.js';

const TZ = 'Asia/Tbilisi';
const day = (offset: number) => addDays(todayIn(TZ), offset);

const h = useHarness();

// ---------------------------------------------------------------- shared fixtures

/** The interview turn a model produces when it wants to ask something. */
const asks = (question: Record<string, unknown>, message = 'Got it — one more thing.') => ({
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
  // ------------------------------------------------------------------- PART 48

  it('PART 48 — a goal built in the widget is an ordinary goal', async () => {
    const user = await h.createUser({ timezone: TZ });

    // "I want to become fitter" states nothing concrete, so the budget is 2-5 questions.
    h.ai.queue(
      'INTERVIEW',
      asks({
        id: 'liked_activities',
        // Deliberately SINGLE_SELECT. The backend is expected to widen it, because
        // "which do you enjoy?" has more than one true answer.
        type: 'SINGLE_SELECT',
        prompt: 'Which activities do you enjoy?',
        options: ['Walking', 'Swimming', 'Dancing', 'Cycling'],
      }),
      asks({
        id: 'days_per_week',
        type: 'NUMBER',
        prompt: 'How many days a week can you train?',
        unit: 'days',
      }),
      ready(),
    );

    const first = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to become fitter',
    });

    expect(first.question.type).toBe('MULTI_SELECT');
    expect(first.questionCount).toBe(1);
    expect(first.estimatedTotal).toBe(5);
    expect(first.canGenerate).toBe(false);

    const second = await h.ok(user, 'POST', `/api/copilot/goal-sessions/${first.sessionId}/answers`, {
      questionId: 'liked_activities',
      answer: ['Walking', 'Swimming'],
    });
    expect(second.questionCount).toBe(2);
    expect(second.canGenerate).toBe(false);

    const third = await h.ok(user, 'POST', `/api/copilot/goal-sessions/${first.sessionId}/answers`, {
      questionId: 'days_per_week',
      answer: 4,
    });
    // Two questions asked, floor met — the interview stops rather than continuing to
    // the ceiling. Three model turns, three questions' worth of budget, no survey.
    expect(third.canGenerate).toBe(true);
    expect(third.questionCount).toBe(2);
    expect(h.ai.countOf('INTERVIEW')).toBe(3);

    // Both chosen activities survived into the model's view of the conversation.
    const asked = h.ai.promptsFor('INTERVIEW', 'user');
    expect(asked).toContain('Walking, Swimming');

    h.ai.queue('DRAFT_GENERATION', {
      title: 'Get Fitter',
      description: 'A gentle return to regular movement.',
      category: 'FITNESS',
      targetType: 'HABIT',
      rationale: 'You said walking and swimming suit you, and that four days a week is realistic.',
      tasks: [
        {
          title: 'Brisk walk',
          description: 'A steady walk at a pace you can still talk at.',
          recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 },
          estimatedMinutes: 30,
          reason: 'You said you enjoy walking.',
        },
        {
          title: 'Swim',
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

    const walk = draft.tasks.find((t: any) => t.title === 'Brisk walk');
    const swim = draft.tasks.find((t: any) => t.title === 'Swim');
    expect(walk.estimatedMinutes).toBe(30);
    expect(swim.estimatedMinutes).toBe(45);

    // "Make walking 25 minutes." — one task, one field.
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
    // Everything else is untouched — the edit was targeted, not a regeneration.
    expect(editedWalk.title).toBe('Brisk walk');
    expect(editedWalk.recurrenceConfig).toEqual({ timesPerWeek: 3 });
    expect(editedSwim.estimatedMinutes).toBe(45);
    expect(editedSwim.title).toBe('Swim');
    expect(edited.applied.length).toBeGreaterThan(0);

    const confirmed = await h.ok(user, 'POST', `/api/copilot/goal-drafts/${draft.id}/confirm`);
    expect(confirmed.alreadyCreated).toBe(false);

    // What came out the other end is a Phase 1 goal, indistinguishable from a hand-made
    // one: it appears in the ordinary goal list, has ordinary tasks, and has occurrences.
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
    expect(goal.tasks.map((t) => t.title).sort()).toEqual(['Brisk walk', 'Swim']);

    // Rewards are the application's, not the model's: 25 minutes banded to 15 coins,
    // 45 to 20. The draft never carried a reward at all.
    const walkTask = goal.tasks.find((t) => t.title === 'Brisk walk')!;
    expect(walkTask.reward).toBe(15);
    expect(goal.tasks.find((t) => t.title === 'Swim')!.reward).toBe(20);

    const occurrences = await prisma.taskOccurrence.count({
      where: { taskDefinition: { goalId: goal.id } },
    });
    expect(occurrences).toBeGreaterThan(0);

    // And nothing parallel was created. The AI's own tables hold a session and a draft
    // that point at this goal — not a second copy of it.
    const draftRow = await prisma.goalDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(draftRow.status).toBe('CONFIRMED');
    expect(draftRow.createdGoalId).toBe(goal.id);
  });

  // ------------------------------------------------------------------- PART 50

  it('PART 50 — a multi-select question keeps every option the user picked', async () => {
    const user = await h.createUser({ timezone: TZ });

    h.ai.queue(
      'INTERVIEW',
      asks({
        id: 'liked_activities',
        type: 'SINGLE_SELECT',
        prompt: 'Which activities do you enjoy?',
        options: ['Walking', 'Swimming', 'Dancing', 'Running'],
      }),
      asks({
        id: 'days_per_week',
        type: 'NUMBER',
        prompt: 'How many days a week can you train?',
      }),
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to move my body more',
    });
    expect(started.question.type).toBe('MULTI_SELECT');
    expect(started.question.options).toEqual(['Walking', 'Swimming', 'Dancing', 'Running']);

    const answered = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/answers`,
      { questionId: 'liked_activities', answer: ['Walking', 'Swimming', 'Dancing'] },
    );

    // All three, in the answer the user gave — not the first one, and not a truncation.
    expect(answered.context.liked_activities).toEqual(['Walking', 'Swimming', 'Dancing']);

    const stored = await prisma.copilotMessage.findFirst({
      where: { sessionId: started.sessionId, role: 'user', content: { contains: 'Dancing' } },
    });
    expect(stored?.content).toBe('Walking, Swimming, Dancing');
    expect(JSON.parse(stored!.structuredPayload!).answer).toEqual([
      'Walking',
      'Swimming',
      'Dancing',
    ]);

    // The next turn is told what was chosen, so it cannot plan around one activity.
    const prompt = h.ai.promptsFor('INTERVIEW', 'user');
    expect(prompt).toContain('Walking, Swimming, Dancing');

    // Reloading the session shows the same three — this is what the widget renders.
    const reloaded = await h.ok(user, 'GET', `/api/copilot/goal-sessions/${started.sessionId}`);
    expect(reloaded.context.liked_activities).toEqual(['Walking', 'Swimming', 'Dancing']);
  });

  // ------------------------------------------------------------------- PART 51

  it('PART 51 — a message containing slashes is accepted and passed through verbatim', async () => {
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

    // Four things already stated (every day / a target / a time), so the budget is
    // 0-2 questions and the Copilot is allowed to go straight to a plan. This is the
    // adaptive interview at its short end.
    h.ai.queue('INTERVIEW', ready('That is plenty to work with.'));

    const session = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to read 10 pages every day at 9pm',
    });
    expect(session.questionCount).toBe(0);
    expect(session.question).toBeNull();
    expect(session.canGenerate).toBe(true);

    h.ai.queue('DRAFT_GENERATION', {
      title: 'Read More',
      description: 'A nightly reading habit that grows.',
      category: 'READING',
      targetType: 'HABIT',
      rationale: 'You said 10 pages every day at 9pm, so the plan starts there and builds.',
      tasks: [
        {
          title: 'Read',
          description: 'Read before bed.',
          recurrence: { type: 'EVERY_DAY' },
          estimatedMinutes: 20,
          preferredTime: '21:00',
          reason: 'You said 9pm suits you.',
          progression: {
            metricType: 'PAGES',
            unitLabel: 'pages',
            stages: [
              { target: 10, minDays: 7 },
              { target: 15, minDays: 7 },
              { target: 20, minDays: 7 },
            ],
          },
        },
      ],
    });

    const { draft } = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${session.sessionId}/generate`,
    );

    // The ladder is shown on the review screen before anything is agreed to.
    expect(draft.tasks[0].progression.stages.map((s: any) => s.target)).toEqual([10, 15, 20]);

    const confirmed = await h.ok(user, 'POST', `/api/copilot/goal-drafts/${draft.id}/confirm`);

    // Today asks for the first rung. Not the last, not nothing.
    const today = await h.ok(user, 'GET', '/api/today');
    const group = today.groups.find((g: any) => g.goalId === confirmed.goalId);
    expect(group).toBeDefined();
    const task = group.tasks[0];
    expect(task.title).toBe('Read');
    expect(task.progression).toEqual({
      target: 10,
      unitLabel: 'pages',
      metricType: 'PAGES',
      stageLabel: 'Stage 1 of 3',
    });

    // Week 1 is 10 pages, week 2 is 15, week 3 is 20 — as a plan the user can see,
    // with each rung held for a week rather than advancing on a timer.
    const definition = await prisma.taskDefinition.findFirstOrThrow({
      where: { goalId: confirmed.goalId },
    });
    const { progression } = await h.ok(user, 'GET', `/api/tasks/${definition.id}/progression`);
    expect(progression.stages).toEqual([
      { stageIndex: 0, target: 10, label: '', minDays: 7, state: 'CURRENT' },
      { stageIndex: 1, target: 15, label: '', minDays: 7, state: 'UPCOMING' },
      { stageIndex: 2, target: 20, label: '', minDays: 7, state: 'UPCOMING' },
    ]);

    // Every materialised day carries the first rung's target. Nothing has advanced
    // because nothing has been completed yet.
    const targets = await prisma.taskOccurrence.findMany({
      where: { taskDefinitionId: definition.id },
      select: { progressionTarget: true },
      distinct: ['progressionTarget'],
    });
    expect(targets.map((t) => t.progressionTarget)).toEqual([10]);
  });

  // ------------------------------------------------------------------- PART 49

  it('PART 49 — the Copilot explains a live goal and may not change it', async () => {
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

    // Six of the last fourteen days done — a real, unimpressive 43%.
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

    // It proposed a reduction — and was refused. The Copilot is never an authorised
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
    // is always allowed — you may always make your own goal easier.
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

    // The decision is on the record either way — the refused proposal and the applied
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

  it('PART 59 — memory from one goal does not reach an unrelated goal', async () => {
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
});
