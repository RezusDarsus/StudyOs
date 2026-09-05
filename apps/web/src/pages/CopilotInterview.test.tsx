import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';
import CopilotInterview from './CopilotInterview';

afterEach(() => vi.restoreAllMocks());
function show() {
  render(<MemoryRouter initialEntries={['/app/goals/new/ai']}><ToastProvider><Routes>
    <Route path="/app/goals/new/ai" element={<CopilotInterview />} />
    <Route path="/app/goals/drafts/:id" element={<p>Draft review opened</p>} />
  </Routes></ToastProvider></MemoryRouter>);
  return userEvent.setup();
}
describe('full-page goal builder recovery', () => {
  it('shows the routing clarification and lets the user confirm a goal', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ routed: true, intent: 'AMBIGUOUS', clarification: 'Do you want to make a goal from this?' });
    const user = show();
    await user.type(screen.getByLabelText('Your goal'), 'Try something new');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Do you want to make a goal from this?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Create a goal from this' }));
    expect(post).toHaveBeenLastCalledWith('/copilot/goal-sessions', { goal: 'Try something new', intentAnswer: 'goal' });
  });
  it('opens the returned draft when building with partial answers', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce({ sessionId: 's1', status: 'INTERVIEWING',
      assistantMessage: 'Which days work?', question: { id: 'days', type: 'FREE_TEXT', prompt: 'Which days work?', optional: false },
      questionCount: 2, estimatedTotal: 4, revision: 1, context: {}, canGenerate: false,
    }).mockResolvedValueOnce({ draft: { id: 'd1' } });
    const user = show();
    await user.type(screen.getByLabelText('Your goal'), 'Read more');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Build with what we have' }));
    expect(await screen.findByText('Draft review opened')).toBeVisible();
    expect(post).toHaveBeenLastCalledWith('/copilot/goal-sessions/s1/generate', { regenerate: false, force: true, revision: 1 });
  });
});
