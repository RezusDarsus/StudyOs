import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import { ToastProvider } from '../components/ui';

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { name: 'Kitty' } }) }));

let today: unknown;
let goals: unknown[];
let failedPath: string | null;

beforeEach(() => {
  today = { groups: [], summary: { required: 0, completed: 0, coinsToday: 0 } };
  goals = [];
  failedPath = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url).replace(/^\/api/, '');
    const failed = path === failedPath;
    const data = path === '/today' ? today : path.startsWith('/goals') ? { goals } : { friends: [] };
    return { ok: !failed, status: failed ? 503 : 200, json: async () => failed ? { error: 'Temporarily unavailable' } : data } as Response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

function showDashboard() {
  return render(<MemoryRouter><ToastProvider><Dashboard /></ToastProvider></MemoryRouter>);
}

describe('Dashboard presentation states', () => {
  it('does not announce an empty schedule while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    showDashboard();
    expect(screen.getByRole('heading', { name: 'Getting your day ready…' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing scheduled today')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('offers a first goal only when there are no active goals', async () => {
    showDashboard();
    expect(await screen.findByRole('link', { name: 'Shape my first goal' })).toHaveAttribute('href', '/app/goals/new');
  });

  it('treats an existing goal with no tasks as an unscheduled day', async () => {
    goals = [{ id: 'goal-1', title: 'Read more', category: 'READING', progress: 20, todayRequired: 0, todayCompleted: 0, participantCount: 1 }];
    showDashboard();
    expect(await screen.findByText('Nothing scheduled today')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review my goals' })).toHaveAttribute('href', '/app/goals');
    expect(screen.queryByRole('link', { name: 'Shape my first goal' })).not.toBeInTheDocument();
  });

  it('leaves all checkpoints unfilled at zero progress', async () => {
    today = { summary: { required: 1, completed: 0, coinsToday: 0 }, groups: [{ goalId: 'g1', goalTitle: 'Get fit', category: 'FITNESS', streak: 0, tasks: [{ occurrenceId: 'o1', taskId: 't1', title: 'Walk outside', reward: 5, status: 'PENDING', reminderTime: null }] }] };
    const { container } = showDashboard();
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(container.querySelectorAll('.momentum-track .is-settled')).toHaveLength(0);
    expect(screen.queryByText(/recent check-ins suggest/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Plan a new goal with Copilot/ })).toHaveAttribute('href', '/app/goals/new/ai');
  });

  it('distinguishes a friends error from having no friends', async () => {
    failedPath = '/friends';
    showDashboard();
    expect(await screen.findByText('Friends couldn’t be loaded.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Find a friend' })).not.toBeInTheDocument();
  });

  it('does not show completed or empty progress after a task load error', async () => {
    failedPath = '/today';
    showDashboard();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Your day is unavailable.' })).toBeInTheDocument());
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('Rewards unavailable')).toBeInTheDocument();
  });
});
