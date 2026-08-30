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

// generateDraft itself is exercised here, with the database and the model
// provider stubbed out: the contradiction gate must be observable end-to-end —
// blocking, clarifying, and unblocking — without a live PostgreSQL or provider.

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

describe('generation blocked by a frequency contradiction', () => {
  it('returns 409 FREQUENCY_CONFLICT, stores the clarification question, and calls no model', async () => {
    state.session = sessionWithAnswers(GOAL, answeredFrequency(3));
    const err = await generateDraft('session_1', 'user_1').then(
      () => { throw new Error('generation should have been blocked'); },
      (e: unknown) => e as HttpError,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('FREQUENCY_CONFLICT');
    expect(err.message).toBe(CLARIFICATION);
    expect(chatJsonMock).not.toHaveBeenCalled();
    expect(state.createdMessages).toHaveLength(1);
    expect(state.createdMessages[0]).toMatchObject({ role: 'assistant', content: CLARIFICATION });
    expect(String(state.createdMessages[0].structuredPayload)).toContain('"id":"resolve_frequency_conflict"');
    // The claim is released, and the session returns to INTERVIEWING so the
    // stored question stays visible and answerable in the UI.
    expect(state.sessionUpdates.at(-1)).toMatchObject({ data: { status: 'INTERVIEWING' } });
  });

  it('does not duplicate the clarification question on a second blocked attempt', async () => {
    state.session = sessionWithAnswers(GOAL, answeredFrequency(3), [{
      role: 'assistant',
      content: CLARIFICATION,
      structuredPayload: JSON.stringify({ id: 'resolve_frequency_conflict', type: 'FREE_TEXT', prompt: CLARIFICATION }),
      createdAt: new Date(),
    }]);
    await expect(generateDraft('session_1', 'user_1')).rejects.toMatchObject({ code: 'FREQUENCY_CONFLICT' });
    expect(state.createdMessages).toHaveLength(0);
    expect(chatJsonMock).not.toHaveBeenCalled();
  });
});

describe('generation allowed past the frequency gate', () => {
  it('proceeds when the answer text carries a correction signal, on the corrected total', async () => {
    state.session = sessionWithAnswers(GOAL, answeredFrequency('Actually, make it 3 days per week'));
    chatJsonMock.mockResolvedValue(draftOn([1, 3, 5]));
    const { draft, adjustments } = await generateDraft('session_1', 'user_1');
    expect(draft).toMatchObject({ id: 'draft_1' });
    expect(adjustments).toBeInstanceOf(Array);
    // One model call: the three-day draft satisfied the corrected contract —
    // against the original five-day contract it would have been rejected.
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the goal stated no weekly frequency and the answer fills the gap', async () => {
    state.session = sessionWithAnswers('Read 20 pages of nonfiction.', answeredFrequency(3));
    chatJsonMock.mockResolvedValue(draftOn([1, 3, 5]));
    const { draft } = await generateDraft('session_1', 'user_1');
    expect(draft).toMatchObject({ id: 'draft_1' });
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the answer matches the stated five-day total', async () => {
    state.session = sessionWithAnswers(GOAL, answeredFrequency(5));
    chatJsonMock.mockResolvedValue(draftOn([1, 2, 3, 4, 5]));
    const { draft } = await generateDraft('session_1', 'user_1');
    expect(draft).toMatchObject({ id: 'draft_1' });
    // One model call: the five-day draft satisfied the five-day contract.
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
  });

  it('unblocks generation once a recorded resolution answers the conflict', async () => {
    state.session = sessionWithAnswers(GOAL, (context) => {
      answeredFrequency(3)(context);
      recordAnswer(context, {
        key: 'resolve_frequency_conflict',
        questionId: 'resolve_frequency_conflict',
        question: CLARIFICATION,
        value: 'Make it 3 days per week',
      });
    });
    chatJsonMock.mockResolvedValue(draftOn([1, 3, 5]));
    const { draft } = await generateDraft('session_1', 'user_1');
    expect(draft).toMatchObject({ id: 'draft_1' });
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a direct correction message as the resolution without an extra question', async () => {
    state.session = sessionWithAnswers(GOAL, (context) => {
      answeredFrequency(3)(context);
      applyModelExtraction(context, {}, [], { schedule_note: 'Actually, make it 3 days per week' });
    });
    chatJsonMock.mockResolvedValue(draftOn([1, 3, 5]));
    const { draft } = await generateDraft('session_1', 'user_1');
    expect(draft).toMatchObject({ id: 'draft_1' });
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
  });
});
