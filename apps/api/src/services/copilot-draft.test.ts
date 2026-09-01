import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { HttpError } from '../lib/errors.js';
import {
  applyModelExtraction,
  createContext,
  recordAnswer,
  serializeContext,
  type CopilotContext,
} from '../ai/context.js';
import { chatJson } from '../ai/client.js';
import { parseRequirementState } from '../ai/context.js';

// generateDraft itself is exercised here, with the database and the model
// provider stubbed out: the contradiction gate must be observable end-to-end â€”
// blocking, clarifying, and unblocking â€” without a live PostgreSQL or provider.

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  createdMessages: [] as Array<Record<string, unknown>>,
  sessionUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    profile: { findUnique: async () => ({ timezone: 'UTC' }) },
    copilotSession: {
      findUnique: async () => state.session,
      updateMany: async (args: Record<string, unknown>) => {
        state.sessionUpdates.push(args);
        return { count: 1 };
      },
      update: async (args: Record<string, unknown>) => {
        state.sessionUpdates.push(args);
        return state.session;
      },
    },
    copilotMessage: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.createdMessages.push(args.data);
        return { id: `message_${state.createdMessages.length}`, ...args.data };
      },
    },
    goalDraft: {
      findFirst: async () => null,
      create: async () => ({ id: 'draft_1', sessionId: 'session_1', status: 'GENERATED', tasks: [] }),
    },
    copilotEvent: { create: async () => ({}) },
  },
}));

vi.mock('../ai/client.js', () => ({
  chatJson: vi.fn(),
  CopilotUnavailableError: class extends Error {},
}));

vi.mock('./preferences.js', () => ({
  extractPreferences: async () => {},
  getPreferencesForPrompt: async () => [],
}));

const { generateDraft } = await import('./copilot-draft.js');

const chatJsonMock = chatJson as unknown as Mock;

const GOAL = 'Read 20 pages of nonfiction every weekday evening.';
const FREQUENCY_QUESTION = 'How many days per week can you realistically work on this goal?';
const CLARIFICATION =
  'You originally said every weekday (5 days a week), but your latest answer says 3 days per week. Which schedule should I use?';

const sessionWithAnswers = (
  goalText: string,
  record: (context: CopilotContext) => void,
  messages: Array<{ role: string; content: string; structuredPayload: string | null; createdAt?: Date }> = [],
) => {
  const context = createContext(goalText);
  record(context);
  return {
    id: 'session_1',
    userId: 'user_1',
    status: 'READY_TO_GENERATE',
    initialGoalText: goalText,
    structuredContext: serializeContext(context),
    category: null,
    questionCount: 2,
    revision: 3,
    askedQuestionIds: '[]',
    expiresAt: new Date(Date.now() + 3_600_000),
    messages: [{ role: 'user', content: goalText, structuredPayload: null, createdAt: new Date() }, ...messages],
  };
};

const answeredFrequency = (value: unknown) => (context: CopilotContext) => {
  recordAnswer(context, {
    key: 'essential_frequency',
    questionId: 'essential_frequency',
    question: FREQUENCY_QUESTION,
    value,
  });
};

/** A model response whose schedule only fits the stated weekly total. */
const draftOn = (weekdays: number[]) => ({
  title: 'Read 20 pages of nonfiction',
  description: 'A steady evening reading habit on the days you chose.',
  category: 'HEALTH',
  targetType: 'HABIT',
  rationale: 'You said which days should carry the reading, so the plan keeps to those evenings.',
  tasks: [{
    title: 'Read 20 pages',
    description: 'Read 20 pages of nonfiction in the evening.',
    recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays },
    estimatedMinutes: 35,
    preferredTime: '20:00',
    reason: 'You want steady evening reading on the agreed days.',
  }],
});

beforeEach(() => {
  state.session = null;
  state.createdMessages = [];
  state.sessionUpdates = [];
  chatJsonMock.mockReset();
});
describe('generation blocked by a requirement contradiction', () => {
  it('refuses generation when the AST conflict engine holds a contradiction, and calls no model', async () => {
    state.session = sessionWithAnswers(GOAL, answeredFrequency(3));
    const ingest = await import('../ai/requirements/index.js');
    const grounding = { turn: 0, message: GOAL, at: new Date().toISOString() };
    const ingested = ingest.ingestExtraction(parseRequirementState(state.session.structuredContext as string), {
      atoms: [
        { property: 'activity.running', scope: 'session', relation: 'contains', value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED', source: 'stated', evidence: 'running' },
        { property: 'activity.running', scope: 'session', relation: 'excludes', value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED', source: 'stated', evidence: 'running' },
      ],
      groups: [],
      pendingAmbiguity: [],
      unmodeledSpans: [],
    }, grounding);
    state.session.structuredContext = serializeContext({ ...createContext(GOAL), requirements: ingested.state });
    const err = await generateDraft('session_1', 'user_1').then(
      () => { throw new Error('generation should have been blocked'); },
      (e: unknown) => e as HttpError,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('NOT_READY');
    expect(chatJsonMock).not.toHaveBeenCalled();
  });
});
