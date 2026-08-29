import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { describeCopilotError } from './copilot-errors';

// ApiError is exactly what api.ts throws — status plus the server's error
// message and code — so these construct failures in the shape the surfaces
// actually receive.
const serverError = (code?: string, message = 'Server said something') =>
  new ApiError(503, message, code);

describe('describeCopilotError', () => {
  it('translates every code the Copilot API answers with', () => {
    expect(describeCopilotError(serverError('NOT_READY'))).toBe(
      'A bit more information is needed before I can build a good plan.',
    );
    expect(describeCopilotError(serverError('STALE_REQUEST'))).toBe(
      'This interview changed since the plan was requested — try again.',
    );
    expect(describeCopilotError(serverError('GENERATE_IN_PROGRESS'))).toBe(
      'Your plan is already being built — one moment.',
    );
    expect(describeCopilotError(serverError('AI_TIMEOUT'))).toBe(
      "Copilot couldn't generate the plan right now. Your interview answers are saved. Try again.",
    );
    expect(describeCopilotError(serverError('AI_PROVIDER'))).toBe(
      "Copilot couldn't generate the plan right now. Your interview answers are saved. Try again.",
    );
    expect(describeCopilotError(serverError('AI_RATE_LIMIT'))).toBe(
      'Copilot is busy right now. Your answers are saved — try again in a moment.',
    );
    expect(describeCopilotError(serverError('DRAFT_INVALID'))).toBe(
      "Copilot couldn't create a valid plan from this attempt. Try generating again.",
    );
    expect(describeCopilotError(serverError('COPILOT_DISABLED'))).toBe(
      'The Copilot is not configured on this server. You can still create goals manually.',
    );
  });

  it('lets the server speak for codes with no wording of our own', () => {
    expect(describeCopilotError(serverError('SOMETHING_NEW', 'A brand new failure'))).toBe(
      'A brand new failure',
    );
    expect(describeCopilotError(serverError(undefined, 'A brand new failure'))).toBe(
      'A brand new failure',
    );
  });

  it('falls back on its own words when there is no message at all', () => {
    expect(describeCopilotError('not an error object')).toBe(
      'Something went wrong. Please try again.',
    );
    expect(describeCopilotError(new Error(''))).toBe('Something went wrong. Please try again.');
  });
});
