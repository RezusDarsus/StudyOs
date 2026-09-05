import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { ToastProvider } from '../components/ui';
import DraftReview from './DraftReview';

afterEach(() => vi.restoreAllMocks());
function show() {
  vi.spyOn(api, 'get').mockResolvedValue({ draft: {
    id: 'd1', title: 'Read more', description: 'A reading plan', category: 'READING', targetType: 'HABIT',
    targetValue: null, deadline: null, visibility: 'PRIVATE', rationale: 'Make time for reading',
    status: 'GENERATED', tasks: [], sessionId: 's1', createdGoalId: null,
  } });
  render(<MemoryRouter initialEntries={['/draft/d1']}><ToastProvider><Routes>
    <Route path="/draft/:id" element={<DraftReview />} />
    <Route path="/app/goals" element={<p>Goals list opened</p>} />
  </Routes></ToastProvider></MemoryRouter>);
  return userEvent.setup();
}
describe('draft review failed actions', () => {
  it('keeps the draft open after failed discard and allows retry', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new ApiError(503, 'Discard unavailable')).mockResolvedValue({ ok: true });
    const user = show();
    await user.click(await screen.findByRole('button', { name: /^Discard$/ }));
    expect(await screen.findByText('Discard unavailable')).toBeVisible();
    expect(screen.queryByText('Goals list opened')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Discard$/ }));
    expect(await screen.findByText('Goals list opened')).toBeVisible();
    expect(post).toHaveBeenCalledTimes(2);
  });
  it('reports feedback failure and lets the user retry', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new ApiError(503, 'Feedback unavailable')).mockResolvedValue({ ok: true });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Yes, useful' }));
    expect(await screen.findByText('Feedback unavailable')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Yes, useful' }));
    expect(post).toHaveBeenCalledTimes(2);
  });
});
