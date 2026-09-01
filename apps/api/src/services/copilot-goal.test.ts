import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { draftEditSystemPrompt, progressSystemPrompt } from '../ai/prompts.js';
import { chatJson } from '../ai/client.js';
import type { RecommendationItem } from '../ai/schemas.js';
import { prisma } from '../lib/prisma.js';
import { recommendationIdentity } from './copilot-recommendations.js';
import { askGoalCopilot, goalCopilotIntent } from './copilot-goal.js';

// askGoalCopilot is exercised with the database and the model stubbed out, the
// same way copilot-draft.test.ts does it — the Stage 1 flag behavior must be
// observable end-to-end without a live PostgreSQL or provider.

/** Stage 2 state: what the durable recommendation history answers per test. */
const state2 = vi.hoisted(() => ({
  contextRows: [] as Array<Record<string, unknown>>,
  knownRows: [] as Array<Record<string, unknown>>,
  goalHasEvents: false,
  written: [] as Array<Record<string, unknown>>,
  failCreateMany: null as null | Error,
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    taskDefinition: {
      findMany: async () => [
        { id: 'task_1', title: 'Read 20 pages', recurrenceType: 'TIMES_PER_WEEK', recurrenceConfig: '{}', reminderTime: null },
      ],
    },
    taskOccurrence: { findMany: async () => [] },
    // Stage 2: durable recommendation history. Route the two query shapes to
    // their own configured rows; defaults keep every Stage 1 test untouched.
    recommendationEvent: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        const identityWhere = args.where?.identityKey as { in?: string[] } | string | undefined;
        if (identityWhere && typeof identityWhere === 'object' && Array.isArray(identityWhere.in)) {
          return state2.knownRows;
        }
        return state2.contextRows;
      }),
      findFirst: vi.fn(async () => (state2.goalHasEvents ? { id: 'event_1' } : null)),
      createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
        if (state2.failCreateMany) throw state2.failCreateMany;
        state2.written.push(...args.data);
        return { count: args.data.length };
      }),
    },
  },
}));

const recommendationEventMocks = (prisma as unknown as {
  recommendationEvent: { findMany: Mock; findFirst: Mock; createMany: Mock };
}).recommendationEvent;

vi.mock('../ai/client.js', () => ({
  chatJson: vi.fn(),
  CopilotUnavailableError: class extends Error {},
}));

vi.mock('./goals.js', () => ({
  loadGoalForUser: async () => ({
    goal: { id: 'goal_1', title: 'Read more', category: 'READING' },
    participant: { id: 'participant_1' },
  }),
}));

vi.mock('./occurrences.js', () => ({
  ensureOccurrences: async () => {},
  goalToday: () => '2026-08-30',
  buildScoreInput: async () => ({ tasks: [], completions: [], from: '2026-08-01', to: '2026-08-30' }),
}));

vi.mock('./preferences.js', () => ({
  getPreferencesForPrompt: async () => [],
}));

vi.mock('./copilot-analytics.js', () => ({
  recordEvent: async () => {},
}));

vi.mock('./task-feedback.js', () => ({
  feedbackSummariesForGoal: async () => new Map(),
}));

const applyDecisionMock = vi.hoisted(() => vi.fn());

// Stage 6 canonical path: proposal recording runs through the registry. The
// unit suite stubs the executor boundary; the registry itself is covered by
// the capability/acceptance suites with a real database.
const executeCapabilityMock = vi.hoisted(() => vi.fn());
executeCapabilityMock.mockResolvedValue({
  status: 'succeeded',
  result: { proposals: [], unresolved: 0 },
});

vi.mock('../capabilities/executor.js', () => ({
  executeCapability: executeCapabilityMock,
  unwrapCapability: (outcome: unknown) => outcome as never,
}));

vi.mock('./progression.js', () => ({
  loadPlansForGoal: async () => [
    { id: 'plan_1', taskDefinitionId: 'task_1', status: 'ACTIVE', advanceThreshold: 0.8 },
  ],
  gatherEvidence: async () => ({ completedCount: 0, eligibleCount: 0 }),
  progressionSummary: () => ({
    stageLabel: 'Stage 1 of 2',
    currentTarget: 20,
    unitLabel: 'min',
    currentStageIndex: 0,
    stageCount: 2,
  }),
  applyDecision: applyDecisionMock,
}));

const chatJsonMock = chatJson as unknown as Mock;

const potteryItem: RecommendationItem = {
  entityType: 'pottery_class',
  displayName: 'Wheel Throwing for Beginners',
  attribution: 'Clay House Studio',
  reason: 'Close by and beginner-friendly.',
};

const v7Answer = (overrides: Record<string, unknown> = {}) => ({
  explanation: 'A class that fits your schedule.',
  suggestions: [],
  recommendsItems: true,
  recommendations: [potteryItem],
  ...overrides,
});

describe('goal Copilot intent', () => {
  it('routes structural recommendation asks as advice instead of progress analysis', () => {
    expect(goalCopilotIntent('what should I read next')).toBe('ADVICE');
    expect(goalCopilotIntent('suggest something')).toBe('ADVICE');
    expect(goalCopilotIntent('maybe some ideas?')).toBe('ADVICE');
  });

  it('routes schedule changes as adjustments', () => {
    expect(goalCopilotIntent('Give me one more rest day')).toBe('ADJUSTMENT');
    expect(goalCopilotIntent('Make this easier')).toBe('ADJUSTMENT');
  });

  it('keeps progress questions in progress mode', () => {
    expect(goalCopilotIntent('Why am I falling behind?')).toBe('PROGRESS');
    expect(goalCopilotIntent('How am I doing?')).toBe('PROGRESS');
  });

  it('instructs advice responses to answer even when no sessions exist', () => {
    const prompt = progressSystemPrompt();
    expect(prompt).toContain('give a useful recommendation');
    expect(prompt).toMatch(/does not require\s+completed-session data/);
    expect(prompt).toContain('Do not default to "there is no data"');
    expect(prompt).toContain('"Title" by Author');
    expect(prompt).toContain('recommend 3 real books');
    expect(prompt).toContain('do not repeat books');
  });

  it('treats a question about a missing draft activity as a repair request', () => {
    const prompt = draftEditSystemPrompt();
    expect(prompt).toContain('why is there no gym?');
    expect(prompt).toContain('add the smallest matching task');
  });
});

describe('goal-coach prompt versions (Stage 1)', () => {
  // The legacy prompt is the flag-off rollback path: it must not move at all.
  const v6 = progressSystemPrompt();

  it('defaults to the legacy v6 prompt byte-identically, with or without the opts object', () => {
    expect(progressSystemPrompt({ structuredRecommendations: false })).toBe(v6);
    expect(progressSystemPrompt(undefined)).toBe(v6);
    expect(progressSystemPrompt({})).toBe(v6);
  });

  it('v6 still carries the legacy book contract (pinned for rollback parity)', () => {
    expect(v6).toContain('"Title" by Author');
    expect(v6).toContain('recommend 3 real books');
    expect(v6).toContain('do not repeat books');
  });

  it('v7 swaps the book contract for the domain-open recommendations contract', () => {
    const v7 = progressSystemPrompt({ structuredRecommendations: true });
    expect(v7).not.toBe(v6);
    expect(v7).toContain('recommendsItems');
    expect(v7).toContain('"recommendations"');
    expect(v7).toContain('"entityType"');
    expect(v7).toContain('"displayName"');
    expect(v7).toContain('"attribution"');
    expect(v7).toContain('the two fields must always agree');
    expect(v7).toContain('do not repeat any item');
  });

  it('v7 contains no user-domain taxonomy or catalog wording', () => {
    const v7 = progressSystemPrompt({ structuredRecommendations: true });
    // Nothing book-shaped anywhere in v7: the entityType set is runtime data.
    expect(v7).not.toMatch(/\bbook\b|\bmanga\b|\bnovel\b|\bmovie\b|\bcourse\b|\brestaurant\b/i);
    expect(v7).not.toContain('Title" by Author');
    expect(v7).not.toContain('real books');
  });
});

describe('askGoalCopilot — ADVICE turns (structured canonical path)', () => {
  beforeEach(() => {
    chatJsonMock.mockReset();
    applyDecisionMock.mockReset();
  });

  it('unseen domain: uses the v7 prompt and returns structured recommendations', async () => {
    chatJsonMock.mockResolvedValue(v7Answer());
    const result = await askGoalCopilot('goal_1', 'user_1', 'Can you recommend a pottery class?');
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
    const firstCall = chatJsonMock.mock.calls[0][0];
    expect(firstCall.promptVersion).toBe('goal-coach-v7');
    expect(firstCall.messages[0].content).toContain('RECOMMENDATIONS');
    expect(firstCall.messages[0].content).not.toContain('Title" by Author');
    expect(result.analysis.recommendations).toEqual([potteryItem]);
    // No catalog content can leak into a structured answer.
    expect(JSON.stringify(result)).not.toContain('Piranesi');
  });

  it('repairs exactly once when the model declares items but lists none', async () => {
    chatJsonMock
      .mockResolvedValueOnce(v7Answer({ recommendations: [] }))
      .mockResolvedValueOnce(v7Answer());
    const result = await askGoalCopilot('goal_1', 'user_1', 'Can you recommend a pottery class?');
    expect(chatJsonMock).toHaveBeenCalledTimes(2);
    const repairPrompt = chatJsonMock.mock.calls[1][0].messages[1].content as string;
    expect(repairPrompt).toContain('Your previous reply was rejected');
    expect(repairPrompt).toMatch(/is empty/);
    expect(result.analysis.recommendations).toEqual([potteryItem]);
  });

  it('repairs once when items and the self-report disagree, then fails typed', async () => {
    chatJsonMock.mockResolvedValue(v7Answer({ recommendsItems: false }));
    await expect(
      askGoalCopilot('goal_1', 'user_1', 'Can you recommend a pottery class?'),
    ).rejects.toMatchObject({ code: 'RECOMMENDATIONS_INVALID' });
    // Exactly one semantic repair on top of the first generation.
    expect(chatJsonMock).toHaveBeenCalledTimes(2);
    const repairPrompt = chatJsonMock.mock.calls[1][0].messages[1].content as string;
    expect(repairPrompt).toMatch(/Set "recommendsItems" to true/);
  });

  it('accepts prose-only advice without a repair when the model declares none', async () => {
    chatJsonMock.mockResolvedValue(v7Answer({ recommendsItems: false, recommendations: [] }));
    const result = await askGoalCopilot('goal_1', 'user_1', 'Can you recommend a pottery class?');
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
    expect(result.analysis.recommendations).toEqual([]);
  });

  it('serializes structured history into the prompt and excludes repeats deterministically', async () => {
    const history = [
      { role: 'user' as const, content: 'Can you recommend a pottery class?' },
      { role: 'assistant' as const, content: 'A class that fits your schedule.', recommendations: [potteryItem] },
    ];
    // The model repeats the exact prior item on both attempts ? typed failure.
    chatJsonMock.mockResolvedValue(v7Answer());
    await expect(
      askGoalCopilot('goal_1', 'user_1', 'another one', history),
    ).rejects.toMatchObject({ code: 'RECOMMENDATIONS_INVALID' });
    expect(chatJsonMock).toHaveBeenCalledTimes(2);
    // The prior structured item reached the prompt through the serialization
    // block — not through prose (the explanation has no " by " pattern).
    const firstPrompt = chatJsonMock.mock.calls[0][0].messages[1].content as string;
    expect(firstPrompt).toContain('Recent structured recommendations');
    expect(firstPrompt).toContain('displayName: Wheel Throwing for Beginners');
    const repairPrompt = chatJsonMock.mock.calls[1][0].messages[1].content as string;
    expect(repairPrompt).toMatch(/already appears in the recent conversation/);
  });

  it('keeps fresh items and drops history repeats when the model also returns new ones', async () => {
    const history = [
      { role: 'assistant' as const, content: 'Earlier pick.', recommendations: [potteryItem] },
    ];
    chatJsonMock.mockResolvedValue(
      v7Answer({ recommendations: [potteryItem, { ...potteryItem, displayName: 'Hand-Building Basics' }] }),
    );
    const result = await askGoalCopilot('goal_1', 'user_1', 'another one', history);
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
    expect((result.analysis.recommendations ?? []).map((i) => i.displayName)).toEqual(['Hand-Building Basics']);
  });

  it('routes a structured follow-up through the structured signal, not prose counting', async () => {
    const history = [
      { role: 'user' as const, content: 'Can you recommend a pottery class?' },
      { role: 'assistant' as const, content: 'A class that fits your schedule.', recommendations: [potteryItem] },
    ];
    // The model answers with a different item — the routing is what this pins.
    chatJsonMock.mockResolvedValue(
      v7Answer({ recommendations: [{ ...potteryItem, displayName: 'Hand-Building Basics' }] }),
    );
    const result = await askGoalCopilot('goal_1', 'user_1', 'another one', history);
    // "another one" carried the continuation into ADVICE via lastHadRecommendations.
    expect(chatJsonMock.mock.calls[0][0].promptVersion).toBe('goal-coach-v7');
    expect(result.intent).toBe('ADVICE');
    expect((result.analysis.recommendations ?? []).map((i) => i.displayName)).toEqual(['Hand-Building Basics']);
  });

  it('never routes a prose-only prior answer through prose counting under the flag', async () => {
    // The prior assistant turn looks like advice by prose standards (" by ")
    // but carries NO structured recommendations. The flag-on continuation
    // signal must ignore it: "another one" is not forced into ADVICE, and the
    // legacy book repair never runs.
    const history = [
      { role: 'assistant' as const, content: 'Try "The Example" by John Smith.' },
    ];
    chatJsonMock.mockResolvedValue({
      explanation: 'A steady week overall.',
      suggestions: [],
    });
    const result = await askGoalCopilot('goal_1', 'user_1', 'another one', history);
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
    expect(chatJsonMock.mock.calls[0][0].promptVersion).toBe('goal-coach-v6');
    expect(result.intent).toBe('PROGRESS');
    expect('recommendations' in result.analysis).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Piranesi');
  });
});

describe('askGoalCopilot — flag ON, PROGRESS/ADJUSTMENT turns (unchanged)', () => {
  beforeEach(() => {
    chatJsonMock.mockReset();
  });

  it('keeps the legacy v6 prompt and schema for a progress question, even with structured history', async () => {
    const history = [
      { role: 'assistant' as const, content: 'Earlier pick.', recommendations: [potteryItem] },
    ];
    chatJsonMock.mockResolvedValue({ explanation: 'A steady week overall.', suggestions: [] });
    const result = await askGoalCopilot('goal_1', 'user_1', 'How am I doing?', history);
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
    expect(chatJsonMock.mock.calls[0][0].promptVersion).toBe('goal-coach-v6');
    expect(chatJsonMock.mock.calls[0][0].messages[0].content).toContain('recommend 3 real books');
    expect(result.intent).toBe('PROGRESS');
    expect('recommendations' in result.analysis).toBe(false);
  });

  it('keeps the legacy path for an adjustment request', async () => {
    chatJsonMock.mockResolvedValue({
      explanation: 'Dropping the session length should help.',
      suggestions: [],
    });
    const result = await askGoalCopilot('goal_1', 'user_1', 'Make this easier');
    expect(chatJsonMock.mock.calls[0][0].promptVersion).toBe('goal-coach-v6');
    expect(result.intent).toBe('ADJUSTMENT');
    expect('recommendations' in result.analysis).toBe(false);
  });
});

describe('source boundary (Stage 1 legacy isolation)', () => {
  // Read from disk and normalize line endings: the repository may be checked
  // out with CRLF, and the region markers are newline-anchored.
  const source = () =>
    readFileSync(new URL('./copilot-goal.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  it('the structured ADVICE branch never references legacy recommendation symbols', () => {
    const text = source();
    const start = text.indexOf('async function runStructuredAdviceTurn');
    expect(start).toBeGreaterThan(0);
    const end = text.indexOf('export async function askGoalCopilot', start);
    expect(end).toBeGreaterThan(start);
    const region = text.slice(start, end);
    expect(region).toContain('validateRecommendationTurn');
    expect(region).toContain('RecommendationValidationError');
    expect(region).not.toMatch(
      /BOOK_FALLBACKS|fallbackBookAnswer|namedBookCount|requestedBookCount|readingMedium|READING_MATERIAL/,
    );
  });

  it('the continuation signal is the structured one — prose counting is gone', () => {
    const text = source();
    const head = text.slice(
      text.indexOf('const continuationStart'),
      text.indexOf('const bookFollowUp'),
    );
    expect(head).toContain('lastHadRecommendations');
    expect(head).toContain('durableGoalSignal');
    // The prose counter no longer exists anywhere in the module.
    expect(text).not.toContain('namedBookCount');
    expect(text).not.toContain('isStructuredRecommendationsEnabled');
    expect(text).not.toContain('WRITE_MODE');
    expect(text).not.toContain('recommendationHistoryReadEnabled');
  });

  it('the durable routing signal is goal-scoped and only queried for continuation-shaped messages', () => {
    const text = source();
    const signal = text.slice(
      text.indexOf('const durableGoalSignal'),
      text.indexOf('const lastHadRecommendations'),
    );
    expect(signal).toContain('loadGoalHasRecommendations(goalId)');
    expect(signal).toContain('continuationStart || readingMaterial().test(message)');
  });
});

describe('askGoalCopilot — Stage 2 durable history (UNION reads, mode writes)', () => {
  const itemX: RecommendationItem = { ...potteryItem };
  const itemY: RecommendationItem = { ...potteryItem, displayName: 'Hand-Building Basics' };
  const itemZ: RecommendationItem = { ...potteryItem, displayName: 'Raku Firing Weekend' };
  const v7With = (items: RecommendationItem[]) => v7Answer({ recommendations: items });

  beforeEach(() => {
    chatJsonMock.mockReset();
    state2.contextRows = [];
    state2.knownRows = [];
    state2.goalHasEvents = false;
    state2.written = [];
    state2.failCreateMany = null;
    recommendationEventMocks.findMany.mockClear();
    recommendationEventMocks.findFirst.mockClear();
    recommendationEventMocks.createMany.mockClear();
  });

  it('rejects duplicates from BOTH durable events and the Stage 1 client mirror (UNION)', async () => {
    // Stage 1 mirror carries item X; durable history knows item Y.
    const history = [
      { role: 'assistant' as const, content: 'Earlier pick.', recommendations: [itemX] },
    ];
    state2.knownRows = [{ identityKey: recommendationIdentity(itemY) }];
    chatJsonMock.mockResolvedValue(v7With([itemX, itemY, itemZ]));

    const result = await askGoalCopilot('goal_1', 'user_1', 'Can you recommend a pottery class?', history);

    // Only Z survives; X was rejected from the mirror, Y from durable history.
    expect(result.analysis.recommendations).toEqual([itemZ]);
    // The candidate lookup was bounded to the proposed identity keys.
    const knownCall = recommendationEventMocks.findMany.mock.calls.find(
      (call) => {
        const where = (call[0] as { where?: { identityKey?: { in?: string[] } } }).where;
        return Array.isArray(where?.identityKey?.in);
      },
    );
    expect(knownCall).toBeDefined();
    expect((knownCall![0] as { where: { identityKey: { in: string[] } } }).where.identityKey.in).toEqual(
      [itemX, itemY, itemZ].map(recommendationIdentity),
    );
  });

  it('does not forget a Stage 1 mirrored item when durable history exists', async () => {
    const history = [
      { role: 'assistant' as const, content: 'Earlier pick.', recommendations: [itemX] },
    ];
    state2.contextRows = [
      { userId: 'user_1', identityKey: recommendationIdentity(itemY), entityType: 'pottery_class', displayName: 'Hand-Building Basics', attribution: 'Clay House Studio', seq: 1 },
    ];
    // The model returns the mirrored item X — it must still be rejected even
    // though no event ever carried it.
    chatJsonMock
      .mockResolvedValueOnce(v7With([itemX]))
      .mockResolvedValueOnce(v7With([itemZ]));

    const result = await askGoalCopilot('goal_1', 'user_1', 'Can you recommend a pottery class?', history);
    expect(result.analysis.recommendations).toEqual([itemZ]);
    expect(chatJsonMock).toHaveBeenCalledTimes(2); // all-duplicates repair fired
    // The prompt block feeds from durable context first, mirror second.
    const prompt = chatJsonMock.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('Recent structured recommendations');
    expect(prompt).toContain('displayName: Hand-Building Basics');
    expect(prompt).toContain('displayName: Wheel Throwing for Beginners');
  });

  it('persistence is part of the request: historyPersisted on success', async () => {
    chatJsonMock.mockResolvedValue(v7With([itemX]));

    const result = await askGoalCopilot('goal_1', 'user_1', 'Can you recommend a pottery class?');
    expect(result.analysis.historyPersisted).toBe(true);
    expect(state2.written).toHaveLength(1);
    expect(state2.written[0]).toMatchObject({ eventKind: 'recommended' });
  });

  it('persistence failure fails typed and retryable — never a silently forgotten answer', async () => {
    state2.failCreateMany = new Error('database down');
    chatJsonMock.mockResolvedValue(v7With([itemX]));

    await expect(
      askGoalCopilot('goal_1', 'user_1', 'Can you recommend a pottery class?'),
    ).rejects.toMatchObject({ code: 'RECOMMENDATION_HISTORY_UNAVAILABLE' });
  });
});

describe('askGoalCopilot — Stage 2 durable routing (cross-session continuation)', () => {
  const itemX: RecommendationItem = { ...potteryItem };

  beforeEach(() => {
    chatJsonMock.mockReset();
    state2.contextRows = [];
    state2.knownRows = [];
    state2.goalHasEvents = false;
    state2.written = [];
    state2.failCreateMany = null;
    recommendationEventMocks.findMany.mockClear();
    recommendationEventMocks.findFirst.mockClear();
    recommendationEventMocks.createMany.mockClear();
  });

  it('routes "another one" to ADVICE from durable goal context alone — no client history', async () => {
    state2.goalHasEvents = true;
    chatJsonMock.mockResolvedValue(v7Answer({ recommendations: [{ ...itemX, displayName: 'A New Pick' }] }));

    const result = await askGoalCopilot('goal_1', 'user_1', 'another one');
    expect(result.intent).toBe('ADVICE');
    expect(chatJsonMock.mock.calls[0][0].promptVersion).toBe('goal-coach-v7');
  });

  it('does not route a continuation when this goal has no durable context', async () => {
    state2.goalHasEvents = false;
    chatJsonMock.mockResolvedValue({ explanation: 'A steady week overall.', suggestions: [] });

    const result = await askGoalCopilot('goal_1', 'user_1', 'another one');
    expect(result.intent).toBe('PROGRESS');
    expect(chatJsonMock.mock.calls[0][0].promptVersion).toBe('goal-coach-v6');
  });

  it('never consults the routing signal for ordinary messages', async () => {
    chatJsonMock.mockResolvedValue({ explanation: 'A steady week overall.', suggestions: [] });
    await askGoalCopilot('goal_1', 'user_1', 'How am I doing?');
    expect(recommendationEventMocks.findFirst).not.toHaveBeenCalled();
  });
});
