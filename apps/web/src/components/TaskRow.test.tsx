import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TaskRow from './TaskRow';
import { ToastProvider } from './ui';
import type { TodayTask } from '../lib/types';

// Milestone 13. The rule these tests exist to protect: rating a task is a comment,
// not a command. It reaches the server, it changes nothing else, and the row it came
// from does not report progress that did not happen.

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];
let failFeedback = false;

const task: TodayTask = {
  occurrenceId: 'occ-1',
  taskId: 'task-1',
  title: 'Evening walk',
  description: '',
  reward: 12,
  reminderTime: '19:30',
  status: 'PENDING',
  dueDate: '2026-08-20',
  progression: null,
  feedback: null,
};

beforeEach(() => {
  calls = [];
  failFeedback = false;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/api/, '');
      const method = init.method ?? 'GET';
      calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });

      if (failFeedback && path.endsWith('/feedback')) {
        // Shaped exactly like a real refusal: the server sends the message as a
        // plain string at `error`, and lib/api.ts uses that value as-is. Nesting it
        // under `message` here would pass while the real thing rendered
        // "[object Object]" at the user.
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'That day has not happened yet', code: 'NOT_DUE_YET' }),
        } as Response;
      }
      const payload = path.endsWith('/complete') ? { ok: true, reward: 12 } : { ok: true };
      return { ok: true, status: 200, json: async () => payload } as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderRow(over: Partial<TodayTask> = {}) {
  const onChanged = vi.fn();
  render(
    <ToastProvider>
      <TaskRow task={{ ...task, ...over }} onChanged={onChanged} />
    </ToastProvider>,
  );
  return { onChanged, user: userEvent.setup() };
}

const ask = () => screen.queryByRole('button', { name: 'How did that feel?' });
const feedbackCalls = () => calls.filter((c) => c.path.endsWith('/feedback'));

describe('difficulty feedback', () => {
  it('does not ask about a task that has not been done', () => {
    renderRow();
    expect(ask()).toBeNull();
  });

  it('asks once the task is complete', async () => {
    const { user } = renderRow();
    await user.click(screen.getByRole('button', { name: /Evening walk/ }));
    expect(await screen.findByRole('button', { name: 'How did that feel?' })).toBeInTheDocument();
  });

  it('sends the rating and says so in words afterwards', async () => {
    const { user } = renderRow({ status: 'COMPLETED' });
    await user.click(screen.getByRole('button', { name: 'How did that feel?' }));
    await user.click(screen.getByRole('button', { name: /Too hard/ }));

    expect(feedbackCalls()).toEqual([
      { path: '/task-occurrences/occ-1/feedback', method: 'POST', body: { rating: 'TOO_HARD' } },
    ]);
    // Read back as text, not as a colour: the choice has to survive a user who
    // cannot tell the filled chip from the unfilled ones.
    expect(await screen.findByRole('button', { name: /Felt too hard/ })).toBeInTheDocument();
  });

  it('does not tell the page anything changed, because nothing did', async () => {
    const { onChanged, user } = renderRow({ status: 'COMPLETED' });
    await user.click(screen.getByRole('button', { name: 'How did that feel?' }));
    await user.click(screen.getByRole('button', { name: /Just right/ }));

    await screen.findByRole('button', { name: /Felt just right/ });
    // A rating earns no coins and moves no stage. Reporting a delta here would make
    // the day's total jump for no reason.
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('submits nothing until an answer is chosen', async () => {
    const { user } = renderRow({ status: 'COMPLETED' });
    await user.click(screen.getByRole('button', { name: 'How did that feel?' }));
    expect(feedbackCalls()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(feedbackCalls()).toHaveLength(0);
    expect(ask()).toBeInTheDocument();
  });

  it('shows a rating the server already had', async () => {
    const { user } = renderRow({ status: 'COMPLETED', feedback: 'TOO_EASY' });
    expect(await screen.findByRole('button', { name: /Felt too easy/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Felt too easy/ }));
    expect(screen.getByRole('button', { name: /Too easy/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /Too hard/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('lets an existing rating be changed to another', async () => {
    const { user } = renderRow({ status: 'COMPLETED', feedback: 'TOO_HARD' });
    await user.click(screen.getByRole('button', { name: /Felt too hard/ }));
    await user.click(screen.getByRole('button', { name: /Too easy/ }));

    expect(feedbackCalls()).toHaveLength(1);
    expect(feedbackCalls()[0].body).toEqual({ rating: 'TOO_EASY' });
    expect(await screen.findByRole('button', { name: /Felt too easy/ })).toBeInTheDocument();
  });

  it('keeps a rating reachable after the completion is undone', async () => {
    const { user } = renderRow({ status: 'COMPLETED', feedback: 'TOO_HARD' });
    await user.click(screen.getByRole('button', { name: /Evening walk/ }));

    // An accidental rating must not become permanent just because the row it was
    // given on stopped looking complete.
    expect(await screen.findByRole('button', { name: /Felt too hard/ })).toBeInTheDocument();
  });

  it('rolls the choice back when the server refuses it', async () => {
    failFeedback = true;
    const { user } = renderRow({ status: 'COMPLETED' });
    await user.click(screen.getByRole('button', { name: 'How did that feel?' }));
    await user.click(screen.getByRole('button', { name: /Too hard/ }));

    // Showing "Felt too hard" over a rejected request would be a lie about what the
    // server holds.
    expect(await screen.findByText('That day has not happened yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Too hard/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('keeps the completion button out of the feedback controls', async () => {
    const { user } = renderRow({ status: 'COMPLETED' });
    await user.click(screen.getByRole('button', { name: 'How did that feel?' }));

    // Nested buttons are invalid markup and unreachable by keyboard; this is the
    // reason the row is a div wrapping two siblings rather than one big button.
    const group = screen.getByRole('group', { name: 'How did that feel?' });
    expect(group.querySelector('button[aria-pressed="true"]')).toBeNull();
    expect(group.textContent).not.toContain('Evening walk');
  });
});
