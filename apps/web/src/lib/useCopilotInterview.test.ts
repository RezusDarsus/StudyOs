import { describe, expect, it } from 'vitest';
import { interviewProgress } from './useCopilotInterview';
import type { InterviewTurn } from './types';

const turn = (overrides: Partial<InterviewTurn>): InterviewTurn => ({
  sessionId: 'session-1',
  status: 'INTERVIEWING',
  assistantMessage: '',
  question: null,
  questionCount: 0,
  estimatedTotal: 2,
  context: {},
  canGenerate: false,
  ...overrides,
});

describe('Copilot interview progress', () => {
  it('finishes cleanly when a detailed goal needs no questions', () => {
    expect(interviewProgress(turn({ estimatedTotal: 0, canGenerate: true }))).toBe(100);
  });

  it('tracks an adaptive interview without dividing by zero', () => {
    expect(interviewProgress(turn({ questionCount: 1, estimatedTotal: 2 }))).toBe(50);
    expect(interviewProgress(turn({ estimatedTotal: 0 }))).toBe(0);
  });
});
