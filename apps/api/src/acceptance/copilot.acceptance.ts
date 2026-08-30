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
import { AiProviderError } from '../ai/provider.js';
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

    h.ai.queue(
      'INTERVIEW',
      asks({
        id: 'days_per_week',
        type: 'NUMBER',
        prompt: 'How many days per week can you commit to?',
      }),
      asks(
        {
          id: 'desired_outcome',
          type: 'SINGLE_SELECT',
          prompt: 'What result matters most right now?',
          options: ['Lose weight', 'Build strength', 'Improve endurance', 'Be more active generally'],
        },
        'One useful detail will help me tailor the plan.',
      ),
    );

    const first = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want lose weight; I will start boxing and gym',
    });
    expect(first.question.id).toBe('days_per_week');

    const readyTurn = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: first.question.id, answer: '3 days' },
    );

    expect(readyTurn.canGenerate).toBe(true);
    expect(readyTurn.question).toBeNull();
    expect(readyTurn.assistantMessage).toBe("That's everything I need.");
  });

  it('does not display a capped question after the interview becomes ready', async () => {
    const user = await h.createUser({ timezone: TZ });

    h.ai.queue(
      'INTERVIEW',
      asks({
        id: 'desired_outcome',
        type: 'FREE_TEXT',
        prompt: 'What result would make this goal successful?',
      }),
      {
        ...asks({
          id: 'days_per_week',
          type: 'NUMBER',
          prompt: 'How many days per week can you realistically commit to?',
        }),
        extractedContext: { desired_outcome: 'Lose weight' },
      },
      {
        ...asks(
          {
            id: 'preferred_days',
            type: 'MULTI_SELECT',
            prompt: 'Which days of the week suit you best?',
            options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
          },
          'Which days of the week suit you best?',
        ),
        extractedContext: { days_per_week: 5 },
      },
    );

    const first = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });
    const second = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: first.question.id, answer: 'Lose weight' },
    );
    const readyTurn = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${first.sessionId}/answers`,
      { questionId: second.question.id, answer: 5 },
    );

    expect(readyTurn.canGenerate).toBe(true);
    expect(readyTurn.question).toBeNull();
    expect(readyTurn.assistantMessage).toBe("That's everything I need.");
    expect(readyTurn.assistantMessage).not.toContain('Which days');
  });

  it('answers a goal-related recommendation instead of repeating empty progress', async () => {
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
      },
      {
        explanation: 'Try "Piranesi" by Susanna Clarke, "Project Hail Mary" by Andy Weir, and "Born a Crime" by Trevor Noah. Each is approachable and engaging in a different genre.',
        suggestions: [],
      },
      {
        explanation: 'Next try "Convenience Store Woman" by Sayaka Murata, "The Thursday Murder Club" by Richard Osman, or "Educated" by Tara Westover.',
        suggestions: [],
      },
    );

    const answer = await h.ok(user, 'POST', `/api/goals/${goal.id}/copilot`, {
      message: 'which book u can suggest',
    });

    expect(answer.intent).toBe('ADVICE');
    expect(answer.analysis.explanation).toContain('Piranesi');
    expect(answer.analysis.explanation.match(/\bby\s+/g)).toHaveLength(3);
    expect(h.ai.promptsFor('PROGRESS_ANALYSIS', 'user')).toContain('Request type: ADVICE');
    expect(h.ai.countOf('PROGRESS_ANALYSIS')).toBe(2);

    const more = await h.ok(user, 'POST', `/api/goals/${goal.id}/copilot`, {
      message: 'can you give me more?',
      history: [
        { role: 'user', content: 'which book u can suggest' },
        { role: 'assistant', content: answer.analysis.explanation },
      ],
    });
    expect(more.intent).toBe('ADVICE');
    expect(more.analysis.explanation).toContain('Convenience Store Woman');
    expect(more.analysis.explanation).not.toContain('Piranesi');
    expect(h.ai.promptsFor('PROGRESS_ANALYSIS', 'user')).toContain('Recent conversation');
    expect(h.ai.promptsFor('PROGRESS_ANALYSIS', 'user')).toContain('Piranesi');
    expect(h.ai.countOf('PROGRESS_ANALYSIS')).toBe(3);
  });

  // ------------------------------------------------------------------- PART 48

  it('PART 48 — a goal built in the widget is an ordinary goal', async () => {
    const user = await h.createUser({ timezone: TZ });

    // A vague everyday goal gets one useful question. A follow-up is allowed only
    // when it would materially change the plan; the backend does not pad the flow.
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
      // The second turn ends the interview — but the readiness gate, not the
      // model, decides that. It passes because the model extracted the outcome
      // and the weekly rhythm the user just described into context, which is
      // exactly what a real model does with a real answer of this shape.
      {
        state: 'READY_TO_GENERATE',
        assistantMessage: "That's everything I need.",
        question: null,
        extractedContext: {
          desired_outcome: 'Move most days and feel fitter within two months',
          days_per_week: 3,
        },
      },
    );

    const first = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to become fitter',
    });

    expect(first.question.type).toBe('MULTI_SELECT');
    expect(first.questionCount).toBe(1);
    expect(first.estimatedTotal).toBe(2);
    expect(first.canGenerate).toBe(false);
    // The gate agrees with the question: a vague opening is not ready to plan.
    expect(first.readiness.ready).toBe(false);
    expect(first.readiness.missing[0]).toBe('DESIRED_OUTCOME');

    const second = await h.ok(user, 'POST', `/api/copilot/goal-sessions/${first.sessionId}/answers`, {
      questionId: 'liked_activities',
      answer: ['Walking', 'Swimming'],
    });
    expect(second.questionCount).toBe(1);
    expect(second.canGenerate).toBe(true);
    expect(second.estimatedTotal).toBe(1);
    expect(second.revision).toBeGreaterThan(0);
    expect(h.ai.countOf('INTERVIEW')).toBe(2);

    // Both chosen activities survived into the model's view of the conversation.
    const asked = h.ai.promptsFor('INTERVIEW', 'user');
    expect(asked).toContain('Walking, Swimming');

    h.ai.queue('DRAFT_GENERATION', {
      title: 'Get Fitter',
      description: 'A gentle return to regular movement.',
      category: 'FITNESS',
      targetType: 'HABIT',
      rationale: 'You said walking and swimming suit you, so this starts with three manageable sessions.',
      tasks: [
        {
          title: 'Brisk walk',
          description: 'A steady walk at a pace you can still talk at.',
          recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 2 },
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
    // The generate response carries the gate's verdict: a ready session plans
    // with nothing missing. The limited-information line stays out — the gate did
    // not refuse — and the only standing assumption is the missing deadline.
    expect(generated.readiness.ready).toBe(true);
    expect(generated.missingDimensions).toEqual([]);
    expect(generated.assumptions).not.toContain(
      'Generated with limited information — the plan uses only what you told me.',
    );
    expect(generated.assumptions).toContain(
      'No deadline was provided, so this plan focuses on steady weekly progress.',
    );

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
    expect(editedWalk.recurrenceConfig).toEqual({ timesPerWeek: 2 });
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

  it('P0 — a provider outage is a 503, and no fake plan is left behind', async () => {
    const user = await h.createUser({ timezone: TZ });

    // Walk the interview to a legitimately ready state: two answers given, and
    // the model extracting the desired outcome it just heard about.
    h.ai.queue(
      'INTERVIEW',
      frequencyQuestion,
      asks({ id: 'session_minutes', type: 'NUMBER', prompt: 'How many minutes per session?' }),
      {
        state: 'READY_TO_GENERATE',
        assistantMessage: "That's everything I need.",
        question: null,
        extractedContext: { desired_outcome: 'Feel strong and energetic again' },
      },
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });
    await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'days_per_week',
      answer: 3,
    });
    const finished = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/answers`,
      { questionId: 'session_minutes', answer: 30 },
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
    // a plan, and the session is not stuck at GENERATING — it can try again.
    expect(await prisma.goalDraft.count({ where: { sessionId: started.sessionId } })).toBe(0);
    const session = await prisma.copilotSession.findUniqueOrThrow({
      where: { id: started.sessionId },
    });
    expect(['INTERVIEWING', 'READY_TO_GENERATE']).toContain(session.status);
  });

  it('P0 — racing generates build one draft, and racing confirms create one goal', async () => {
    const user = await h.createUser({ timezone: TZ });

    h.ai.queue(
      'INTERVIEW',
      frequencyQuestion,
      asks({ id: 'session_minutes', type: 'NUMBER', prompt: 'How many minutes per session?' }),
      {
        state: 'READY_TO_GENERATE',
        assistantMessage: "That's everything I need.",
        question: null,
        extractedContext: { desired_outcome: 'Feel strong and energetic again' },
      },
    );

    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });
    await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'days_per_week',
      answer: 3,
    });
    await h.ok(user, 'POST', `/api/copilot/goal-sessions/${started.sessionId}/answers`, {
      questionId: 'session_minutes',
      answer: 30,
    });

    h.ai.queue('DRAFT_GENERATION', {
      title: 'Get Fitter',
      description: 'Three sessions to rebuild the habit.',
      category: 'FITNESS',
      targetType: 'HABIT',
      rationale: 'You said three days a week suits you, so the plan starts there.',
      tasks: [
        {
          title: 'Brisk walk',
          description: 'A steady walk at a pace you can still talk at.',
          recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 },
          estimatedMinutes: 30,
          reason: 'Fits the week you described.',
        },
      ],
    });

    // Two generates enter at the same time. Exactly one may run the model; the
    // other either gets the winner's draft back or a clean conflict — never a
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
    // Both learn the same goal — the second sees what the first created.
    expect(new Set(confirmResponses.map((r) => r.body.goalId)).size).toBe(1);
    expect(await prisma.goal.count({ where: { ownerId: user.id } })).toBe(1);
  });

  it('P0 — a generate request quoting a stale revision is refused', async () => {
    const user = await h.createUser({ timezone: TZ });

    h.ai.queue('INTERVIEW', frequencyQuestion);
    const started = await h.ok(user, 'POST', '/api/copilot/goal-sessions', {
      goal: 'I want to get fitter',
    });

    const snapshot = await h.ok(user, 'GET', `/api/copilot/goal-sessions/${started.sessionId}`);
    expect(snapshot.revision).toBeGreaterThan(0);
    expect(snapshot.readiness.ready).toBe(false);

    // One revision behind — the interview moved on since this caller looked.
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

    // The current revision passes the staleness gate — and then hits the
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

    // The model keeps trying to end the interview; the gate keeps refusing.
    h.ai.queue('INTERVIEW', frequencyQuestion, ready(), ready());

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

    // The model's ready() is downgraded, and the deterministic fallback asks
    // for the first missing blocking dimension: the desired outcome.
    const second = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/answers`,
      { questionId: 'days_per_week', answer: 3 },
    );
    expect(second.canGenerate).toBe(false);
    expect(second.question.id).toBe('essential_success');
    expect(second.questionCount).toBe(2);

    // Answered, but the goal is still outcome-less; the hard cap now closes
    // the interview anyway. It says ready; the gate still says not ready.
    const capped = await h.ok(
      user,
      'POST',
      `/api/copilot/goal-sessions/${started.sessionId}/answers`,
      { questionId: 'essential_success', answer: 'I just want to move more' },
    );
    expect(capped.canGenerate).toBe(true);
    expect(capped.readiness.ready).toBe(false);

    // The hard cap concluded the interview (READY_TO_GENERATE) with nothing
    // left to ask, so a plain generate is allowed: refusing here would dead-end
    // the user with no next question. The non-concluded refusals are asserted
    // above (before the cap). The plan still says out loud that it rests on
    // limited information.
    h.ai.queue('DRAFT_GENERATION', {
      title: 'Move More Gently',
      description: 'A starting plan built from limited answers.',
      category: 'FITNESS',
      targetType: 'HABIT',
      rationale: 'Built from what little was gathered; edit freely.',
      tasks: [
        {
          title: 'Short walk',
          description: 'Ten minutes, any pace.',
          recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 },
          estimatedMinutes: 10,
          reason: 'Matches the days you gave.',
        },
      ],
    });
    const concludedGenerate = await h.ok(user, 'POST', generateUrl, {});
    expect(concludedGenerate.assumptions).toContain(
      'Generated with limited information — the plan uses only what you told me.',
    );

    // Two questions were asked, so the user may also insist explicitly — and
    // that response says out loud what the plan rests on.
    h.ai.queue('DRAFT_GENERATION', {
      title: 'Move More',
      description: 'A starting plan built from limited answers.',
      category: 'FITNESS',
      targetType: 'HABIT',
      rationale: 'Built from what little was gathered; edit freely.',
      tasks: [
        {
          title: 'Short walk',
          description: 'Ten minutes, any pace.',
          recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 },
          estimatedMinutes: 10,
          reason: 'Matches the days you gave.',
        },
      ],
    });
    const forced = await h.ok(user, 'POST', generateUrl, { force: true });
    // The forced plan still says out loud that it rests on limited information,
    // alongside the standing note about the missing deadline.
    expect(forced.assumptions).toContain(
      'Generated with limited information — the plan uses only what you told me.',
    );
    expect(forced.assumptions).toContain(
      'No deadline was provided, so this plan focuses on steady weekly progress.',
    );
    expect(forced.readiness.ready).toBe(false);
    expect(forced.missingDimensions).toContain('DESIRED_OUTCOME');
  });
});
