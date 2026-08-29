import { describe, expect, it } from 'vitest';
import { interviewPhaseLabel, interviewProgress } from './useCopilotInterview';
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
  revision: 1,
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

describe('interviewPhaseLabel', () => {
  it('says nothing while the surfaces show their own states', () => {
    expect(interviewPhaseLabel('OPENING', null)).toBe('');
    expect(interviewPhaseLabel('RESUMING', null)).toBe('');
    expect(interviewPhaseLabel('DONE', null)).toBe('');
  });

  it('hands over to the build step once the gate is satisfied', () => {
    expect(interviewPhaseLabel('READY', null)).toBe('Ready to build your plan');
    expect(interviewPhaseLabel('READY', turn({ questionCount: 4 }))).toBe(
      'Ready to build your plan',
    );
  });

  it('describes what the interview is doing instead of counting', () => {
    expect(interviewPhaseLabel('INTERVIEWING', turn({ questionCount: 0 }))).toBe(
      'Understanding your goal',
    );
    expect(interviewPhaseLabel('INTERVIEWING', turn({ questionCount: 1 }))).toBe(
      'Understanding your goal',
    );
    expect(interviewPhaseLabel('INTERVIEWING', turn({ questionCount: 2 }))).toBe(
      'Setting up your plan',
    );
    expect(interviewPhaseLabel('INTERVIEWING', turn({ questionCount: 3 }))).toBe(
      'Setting up your plan',
    );
    expect(interviewPhaseLabel('INTERVIEWING', turn({ questionCount: 4 }))).toBe('Almost ready');
    expect(interviewPhaseLabel('INTERVIEWING', turn({ questionCount: 9 }))).toBe('Almost ready');
  });

  it('starts at the beginning when no turn has arrived yet', () => {
    expect(interviewPhaseLabel('INTERVIEWING', null)).toBe('Understanding your goal');
  });
});
