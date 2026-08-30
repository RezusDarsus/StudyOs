import { describe, expect, it } from 'vitest';
import { draftEditSystemPrompt, progressSystemPrompt } from '../ai/prompts.js';
import { goalCopilotIntent } from './copilot-goal.js';

describe('goal Copilot intent', () => {
  it('routes recommendations as advice instead of progress analysis', () => {
    expect(goalCopilotIntent('which book u can suggest')).toBe('ADVICE');
    expect(goalCopilotIntent('no i am asking what book u can suggest')).toBe('ADVICE');
    expect(goalCopilotIntent('maybe some book?')).toBe('ADVICE');
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
  });

  it('treats a question about a missing draft activity as a repair request', () => {
    const prompt = draftEditSystemPrompt();
    expect(prompt).toContain('why is there no gym?');
    expect(prompt).toContain('add the smallest matching task');
  });
});
