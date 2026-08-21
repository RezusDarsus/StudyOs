import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdjustmentOffers from './AdjustmentOffers';
import { ToastProvider } from './ui';
import type { AdjustmentOffer } from '../lib/types';

// Milestone 14. The rule these tests exist to protect: this panel suggests and
// nothing else. It never writes, it never appears with nothing to say, and an offer
// the completion numbers do not support admits that on the card — before the user
// acts on it.

interface Call {
  path: string;
  method: string;
}

let calls: Call[] = [];
let offers: AdjustmentOffer[] = [];
let canApply = true;
let failOffers = false;

const EASE: AdjustmentOffer = {
  kind: 'EASE_STAGE',
  taskId: 'task-walk',
  taskTitle: 'Evening walk',
  headline: 'Drop Evening walk back to 20 min',
  because: 'You rated it too hard on all 4 days you rated. Completion agrees — 40% at this stage.',
  suggestedAction: 'REDUCE',
  needsOverride: false,
};

const STEP_UP: AdjustmentOffer = {
  kind: 'ADVANCE_STAGE',
  taskId: 'task-gym',
  taskTitle: 'Go to the gym',
  headline: 'Step Go to the gym up to 30 min',
  because:
    'You rated it too easy on all 5 days you rated. Only 45% of these days are getting done though, so stepping up would be your call against the numbers.',
  suggestedAction: 'ADVANCE',
  needsOverride: true,
};

const START: AdjustmentOffer = {
  kind: 'START_LADDER',
  taskId: 'task-water',
  taskTitle: 'Drink 2L of water',
  headline: 'Let Drink 2L of water grow in stages',
  because: 'You rated it too easy on all 3 days you rated.',
  suggestedAction: null,
  needsOverride: false,
};

beforeEach(() => {
  calls = [];
  offers = [];
  canApply = true;
  failOffers = false;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/api/, '');
      calls.push({ path, method: init.method ?? 'GET' });

      if (path.endsWith('/adjustments')) {
        if (failOffers) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: 'Something went wrong', code: 'INTERNAL' }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ today: '2026-08-21', offers, canApply }),
        } as Response;
      }

      // What the progression view asks for. No plan yet, which is the state that
      // renders the form rather than a verdict — nothing has been applied.
      if (path.endsWith('/progression')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ progression: null, history: [] }),
        } as Response;
      }

      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderPanel() {
  const onChanged = vi.fn();
  // Wrapped in a slot of its own because ToastProvider leaves an empty live region
  // behind: "rendered nothing" has to be asked of the panel, not of the whole tree.
  const { container } = render(
    <ToastProvider>
      <div data-testid="slot">
        <AdjustmentOffers goalId="goal-1" onChanged={onChanged} />
      </div>
    </ToastProvider>,
  );
  return { onChanged, container, user: userEvent.setup() };
}

const slot = () => screen.getByTestId('slot');
const heading = () => screen.queryByText('WORTH A LOOK');
const writes = () => calls.filter((c) => c.method !== 'GET');

describe('when there is nothing to say', () => {
  it('renders nothing at all on a goal with no offers', async () => {
    renderPanel();
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/adjustments'))).toBe(true));
    // Not an empty-state card, not a heading with nothing under it. Nothing.
    expect(slot()).toBeEmptyDOMElement();
    expect(heading()).toBeNull();
  });

  it('stays quiet when the offers cannot be fetched', async () => {
    failOffers = true;
    renderPanel();
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/adjustments'))).toBe(true));
    // A suggestion that failed to load is not news the user needs. An error box here
    // would make an optional extra look like a broken goal page.
    await waitFor(() => expect(slot()).toBeEmptyDOMElement());
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });
});

describe('what the cards say', () => {
  it('shows each offer with the reason it was made', async () => {
    offers = [EASE, START];
    renderPanel();
    expect(await screen.findByText(EASE.headline)).toBeTruthy();
    expect(screen.getByText(EASE.because)).toBeTruthy();
    expect(screen.getByText(START.headline)).toBeTruthy();
  });

  it('admits when an offer goes against the completion numbers', async () => {
    offers = [STEP_UP];
    renderPanel();
    await screen.findByText(STEP_UP.headline);
    expect(screen.getByText('Your call')).toBeTruthy();
  });

  it('does not label a supported offer as the user overriding anything', async () => {
    offers = [EASE];
    renderPanel();
    await screen.findByText(EASE.headline);
    expect(screen.queryByText('Your call')).toBeNull();
  });

  it('keeps the order the server sent', async () => {
    // The server puts struggle before slack. Re-sorting here would quietly undo that.
    offers = [EASE, STEP_UP, START];
    const { container } = renderPanel();
    await screen.findByText(EASE.headline);
    const shown = [...container.querySelectorAll('span')]
      .map((el) => el.textContent)
      .filter((text) => offers.some((o) => o.headline === text));
    expect(shown).toEqual([EASE.headline, STEP_UP.headline, START.headline]);
  });

  it('promises out loud that nothing has happened yet', async () => {
    offers = [EASE];
    renderPanel();
    expect(await screen.findByText(/Nothing here has happened/)).toBeTruthy();
  });
});

describe('who may act on an offer', () => {
  it('gives the owner a way through to the build-up', async () => {
    offers = [EASE];
    renderPanel();
    expect(await screen.findByRole('button', { name: /Open the build-up/ })).toBeTruthy();
  });

  it('tells a participant whose ratings these are that the pace is not theirs to set', async () => {
    canApply = false;
    offers = [EASE];
    renderPanel();
    await screen.findByText(EASE.headline);
    expect(screen.queryByRole('button', { name: /build-up/ })).toBeNull();
    expect(screen.getByText(/The goal owner sets the pace/)).toBeTruthy();
  });
});

describe('acting on an offer', () => {
  it('opens the build-up rather than applying anything', async () => {
    offers = [START];
    const { user, onChanged } = renderPanel();
    await user.click(await screen.findByRole('button', { name: /Set up a build-up/ }));

    // The progression view, for the task the card named.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(calls.some((c) => c.path === '/tasks/task-water/progression')).toBe(true);

    // The whole point: opening an offer changes nothing. Not one write, and the goal
    // page is not told to refetch as though something had.
    expect(writes()).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
