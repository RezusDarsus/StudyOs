import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CopilotProvider } from './CopilotProvider';
import { ToastProvider } from '../ui';
import type { CopilotQuestion, InterviewTurn } from '../../lib/types';

// Milestones 3–6: the floating widget. These tests drive it through the DOM and
// assert on the requests it makes, because the point of the widget is that it
// talks to the *existing* Copilot API rather than reimplementing it.

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];
let statusEnabled = true;

const question: CopilotQuestion = {
  id: 'how_often',
  type: 'MULTI_SELECT',
  prompt: 'Which days suit you?',
  options: ['Weekdays', 'Weekends'],
  allowCustomAnswer: true,
  optional: false,
};

const turn: InterviewTurn = {
  sessionId: 'session-1',
  status: 'INTERVIEWING',
  assistantMessage: 'Got it. Which days suit you?',
  question,
  questionCount: 1,
  estimatedTotal: 4,
  context: {},
  canGenerate: false,
};

beforeEach(() => {
  calls = [];
  statusEnabled = true;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/api/, '');
      const method = init.method ?? 'GET';
      calls.push({
        path,
        method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });

      const payload =
        path === '/copilot/status'
          ? { enabled: statusEnabled, resumable: [] }
          : path === '/notifications'
            ? { unread: 0 }
            : path === '/copilot/goal-sessions'
              ? turn
              : {};

      return { ok: true, status: 200, json: async () => payload } as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderWidget(path = '/app') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <CopilotProvider>
          <p>page content</p>
        </CopilotProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const fab = () => screen.findByRole('button', { name: 'Open One Up Copilot' });

/** Opens the widget and types a message into its input. */
async function send(user: ReturnType<typeof userEvent.setup>, message: string) {
  await user.click(await fab());
  await user.type(screen.getByLabelText('Message the Copilot'), message);
  await user.click(screen.getByRole('button', { name: 'Send message' }));
}

const sessionStarts = () =>
  calls.filter((c) => c.path === '/copilot/goal-sessions' && c.method === 'POST');

describe('the collapsed button', () => {
  it('is labelled for screen readers and starts closed', async () => {
    renderWidget();
    const button = await fab();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog', { name: 'One Up Copilot' })).toBeNull();
  });

  it('opens the panel when clicked', async () => {
    const user = renderWidget();
    await user.click(await fab());
    expect(screen.getByRole('dialog', { name: 'One Up Copilot' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create a goal with AI/ })).toBeInTheDocument();
  });

  it('closes again on Escape', async () => {
    const user = renderWidget();
    await user.click(await fab());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'One Up Copilot' })).toBeNull();
  });

  it('stays away from the full-page Copilot, which is already a Copilot surface', async () => {
    renderWidget('/app/goals/new/ai');
    // Give the status request a chance to resolve before asserting absence.
    await screen.findByText('page content');
    expect(screen.queryByRole('button', { name: 'Open One Up Copilot' })).toBeNull();
  });

  it('does not appear when the server has no AI provider configured', async () => {
    statusEnabled = false;
    renderWidget();
    await screen.findByText('page content');
    expect(screen.queryByRole('button', { name: 'Open One Up Copilot' })).toBeNull();
  });
});

describe('slash handling in the widget', () => {
  it('treats /help as a command and does not start an interview', async () => {
    const user = renderWidget();
    await send(user, '/help');

    expect(screen.getByText('What I can do')).toBeInTheDocument();
    expect(sessionStarts()).toHaveLength(0);
  });

  it('sends an unknown command as an ordinary message, slash included', async () => {
    const user = renderWidget();
    await send(user, '/random');

    expect(sessionStarts()).toHaveLength(1);
    expect(sessionStarts()[0].body).toEqual({ goal: '/random' });
  });

  it('preserves slashes inside a normal sentence', async () => {
    const user = renderWidget();
    const message = 'I want to walk 5/7 days, walking/hiking both fine';
    await send(user, message);

    expect(sessionStarts()[0].body).toEqual({ goal: message });
  });

  it('starts a fresh interview from /new with the rest of the line', async () => {
    const user = renderWidget();
    await send(user, '/new I want to read more books');

    expect(sessionStarts()).toHaveLength(1);
    expect(sessionStarts()[0].body).toEqual({ goal: 'I want to read more books' });
  });

  it('hands back text too short to start on rather than dropping it', async () => {
    const user = renderWidget();
    await send(user, '/new hi');

    expect(sessionStarts()).toHaveLength(0);
    expect(screen.getByLabelText('Message the Copilot')).toHaveValue('hi');
  });
});

describe('the interview inside the widget', () => {
  it('shows the assistant message and renders the question it returned', async () => {
    const user = renderWidget();
    await send(user, 'I want to get fitter');

    expect(await screen.findByText('Got it. Which days suit you?')).toBeInTheDocument();
    // The shared QuestionInput, not a widget-only copy: multi-select still waits
    // for Continue rather than sending on the first tap.
    expect(screen.getByRole('button', { name: 'Weekdays' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
  });

  it('submits multi-select answers to the existing answers endpoint', async () => {
    const user = renderWidget();
    await send(user, 'I want to get fitter');

    await user.click(await screen.findByRole('button', { name: 'Weekdays' }));
    await user.click(screen.getByRole('button', { name: 'Weekends' }));
    await user.click(screen.getByRole('button', { name: /Continue/ }));

    const answer = calls.find((c) => c.path === '/copilot/goal-sessions/session-1/answers');
    expect(answer?.method).toBe('POST');
    expect(answer?.body).toEqual({
      questionId: 'how_often',
      answer: ['Weekdays', 'Weekends'],
      skipped: false,
    });
  });
});
