import { ApiError } from './api';

/**
 * What a Copilot failure says to the person it happened to.
 *
 * The server's codes are the truth about what went wrong; its raw messages are
 * written for the API surface. Each known code gets words that say what happened
 * to the user's data — the interview answers are saved — and what is worth doing
 * next. Unknown codes still have a server message to fall back on.
 */
export function describeCopilotError(err: unknown): string {
  const code = err instanceof ApiError ? err.code : undefined;
  switch (code) {
    case 'NOT_READY':
      return 'A bit more information is needed before I can build a good plan.';
    case 'STALE_REQUEST':
      return 'This interview changed since the plan was requested — try again.';
    case 'FREQUENCY_CONFLICT':
      return 'I need you to settle a scheduling conflict before I can build the plan — answer the question above.';
    case 'GENERATE_IN_PROGRESS':
      return 'Your plan is already being built — one moment.';
    case 'AI_TIMEOUT':
    case 'AI_PROVIDER':
      return "Copilot couldn't generate the plan right now. Your interview answers are saved. Try again.";
    case 'AI_RATE_LIMIT':
      return 'Copilot is busy right now. Your answers are saved — try again in a moment.';
    case 'DRAFT_INVALID':
      return "Copilot couldn't create a valid plan from this attempt. Try generating again.";
    case 'COPILOT_DISABLED':
      return 'The Copilot is not configured on this server. You can still create goals manually.';
    default:
      return err instanceof Error && err.message
        ? err.message
        : 'Something went wrong. Please try again.';
  }
}
