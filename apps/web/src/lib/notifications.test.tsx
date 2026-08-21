import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationsProvider, useNotifications } from './notifications';
import type { Notification } from './types';

// Milestone 24: the notification list, held once and kept live.
//
// Everything here is about the seam between the socket and the database. The socket is
// faked, because what needs pinning is not Centrifuge — it is that a push and a fetch can
// never leave the list showing something PostgreSQL does not contain, in either direction:
// no duplicates, and nothing missed while the tab was away.

/** Stands in for a Centrifuge client, with hooks for the tests to fire events by hand. */
// Hoisted because `vi.mock` is: the factory below runs before the imports, so the fake it
// returns cannot be a plain top-level class.
const { FakeCentrifuge } = vi.hoisted(() => {
  class FakeCentrifuge {
    static instances: FakeCentrifuge[] = [];
    clientEvents: Record<string, Array<(ctx: unknown) => void>> = {};
    publications: Array<(ctx: { data: unknown }) => void> = [];
    channel: string | null = null;
    subscribed = false;
    disconnected = false;

    constructor(
      public endpoint: string,
      public options: { token?: string; getToken?: (ctx: unknown) => Promise<string> },
    ) {
      FakeCentrifuge.instances.push(this);
    }

    on(event: string, handler: (ctx: unknown) => void) {
      (this.clientEvents[event] ??= []).push(handler);
      return this;
    }

    newSubscription(channel: string) {
      this.channel = channel;
      const sub = {
        on: (event: string, handler: (ctx: { data: unknown }) => void) => {
          if (event === 'publication') this.publications.push(handler);
          return sub;
        },
        subscribe: () => {
          this.subscribed = true;
          return sub;
        },
      };
      return sub;
    }

    connect() {
      this.emit('connected', {});
    }

    disconnect() {
      this.disconnected = true;
      this.emit('disconnected', {});
    }

    emit(event: string, ctx: unknown) {
      for (const handler of this.clientEvents[event] ?? []) handler(ctx);
    }

    /** What Centrifugo would deliver on the channel. */
    push(data: unknown) {
      for (const handler of this.publications) handler({ data });
    }
  }

  return { FakeCentrifuge };
});

vi.mock('centrifuge', () => ({
  Centrifuge: FakeCentrifuge,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

function note(id: string, over: Partial<Notification> = {}): Notification {
  return {
    id,
    type: 'MORNING_SUMMARY',
    title: `Notification ${id}`,
    body: '',
    data: {},
    localDate: '2026-08-21',
    readAt: null,
    createdAt: '2026-08-21T04:00:00.000Z',
    ...over,
  };
}

interface Call {
  path: string;
  method: string;
}

let calls: Call[] = [];
let stored: Notification[] = [];
let realtimeEnabled = true;

beforeEach(() => {
  calls = [];
  stored = [note('a'), note('b', { readAt: '2026-08-20T09:00:00.000Z' })];
  realtimeEnabled = true;
  FakeCentrifuge.instances = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/api/, '');
      const method = init.method ?? 'GET';
      calls.push({ path, method });

      if (path === '/notifications/read') {
        stored = stored.map((n) => (n.readAt ? n : { ...n, readAt: '2026-08-21T10:00:00.000Z' }));
      }

      const payload =
        path === '/notifications'
          ? { notifications: stored, unread: stored.filter((n) => !n.readAt).length }
          : path === '/realtime/token'
            ? realtimeEnabled
              ? {
                  enabled: true,
                  url: 'ws://127.0.0.1:8000/connection/websocket',
                  token: 'signed.by.the.api',
                  channel: 'personal:#user-1',
                  expiresInSeconds: 900,
                }
              : { enabled: false }
            : { ok: true };

      return { ok: true, status: 200, json: async () => payload } as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** Renders the provider around a probe that prints everything the context exposes. */
function renderProvider() {
  function Probe() {
    const { notifications, unread, live, markRead } = useNotifications();
    return (
      <div>
        <p data-testid="unread">{unread}</p>
        <p data-testid="live">{live ? 'live' : 'not live'}</p>
        <ul>
          {notifications.map((n) => (
            <li key={n.id}>{n.title}</li>
          ))}
        </ul>
        <button onClick={() => void markRead()}>mark read</button>
      </div>
    );
  }

  render(
    <NotificationsProvider>
      <Probe />
    </NotificationsProvider>,
  );
  return userEvent.setup();
}

const client = () => FakeCentrifuge.instances[0];
const titles = () => screen.queryAllByRole('listitem').map((li) => li.textContent);
const requests = (path: string) => calls.filter((c) => c.path === path);

describe('the list', () => {
  it('comes from the database, with the unread count derived from it', async () => {
    renderProvider();
    await waitFor(() => expect(titles()).toEqual(['Notification a', 'Notification b']));
    // One of the two rows is already read, and nothing had to be told the count separately.
    expect(screen.getByTestId('unread')).toHaveTextContent('1');
  });

  it('is fetched once for the whole shell, however many badges read it', async () => {
    renderProvider();
    await waitFor(() => expect(client()?.subscribed).toBe(true));
    // The old code fetched once per badge. The connect refetch is the only extra read.
    expect(requests('/notifications').length).toBeLessThanOrEqual(2);
  });
});

describe('the socket', () => {
  it('subscribes to the channel the API named, with the token the API signed', async () => {
    renderProvider();
    await waitFor(() => expect(client()).toBeDefined());
    expect(client().endpoint).toBe('ws://127.0.0.1:8000/connection/websocket');
    expect(client().options.token).toBe('signed.by.the.api');
    // Not built on the client from a user id — the channel name arrives with the token.
    expect(client().channel).toBe('personal:#user-1');
    await waitFor(() => expect(screen.getByTestId('live')).toHaveTextContent('live'));
  });

  it('is never opened when the server has no Centrifugo', async () => {
    realtimeEnabled = false;
    renderProvider();
    await waitFor(() => expect(titles()).toHaveLength(2));
    // The list still works. `enabled: false` is a working answer, not a failure.
    expect(FakeCentrifuge.instances).toHaveLength(0);
    expect(screen.getByTestId('live')).toHaveTextContent('not live');
  });

  it('leaves the list alone when the token endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = String(url).replace(/^\/api/, '');
        if (path === '/realtime/token') throw new Error('offline');
        return {
          ok: true,
          status: 200,
          json: async () => ({ notifications: stored, unread: 1 }),
        } as Response;
      }),
    );
    renderProvider();
    await waitFor(() => expect(titles()).toHaveLength(2));
    expect(FakeCentrifuge.instances).toHaveLength(0);
  });
});

describe('pushed notifications', () => {
  it('appear at the top without a refetch', async () => {
    renderProvider();
    await waitFor(() => expect(client()?.subscribed).toBe(true));
    const before = requests('/notifications').length;

    act(() => client().push({ event: 'notification', notification: note('c', { title: 'Brand new' }) }));

    expect(titles()).toEqual(['Brand new', 'Notification a', 'Notification b']);
    expect(screen.getByTestId('unread')).toHaveTextContent('2');
    expect(requests('/notifications')).toHaveLength(before);
  });

  it('are not shown twice when a push and a fetch race', async () => {
    renderProvider();
    await waitFor(() => expect(client()?.subscribed).toBe(true));

    // The same row arriving by both paths: the API builds each with one mapper, so this is
    // the same notification, and the only question is whether it is rendered once.
    act(() => client().push({ event: 'notification', notification: note('a') }));

    expect(titles()).toEqual(['Notification a', 'Notification b']);
  });

  it('ignore anything that is not a notification event', async () => {
    renderProvider();
    await waitFor(() => expect(client()?.subscribed).toBe(true));

    act(() => client().push({ event: 'something-else', notification: note('c') }));
    act(() => client().push({ event: 'notification' }));
    act(() => client().push(null));

    expect(titles()).toEqual(['Notification a', 'Notification b']);
  });
});

describe('reconnecting', () => {
  it('re-reads the database, because Centrifugo keeps no history', async () => {
    renderProvider();
    await waitFor(() => expect(client()?.subscribed).toBe(true));
    await waitFor(() => expect(screen.getByTestId('live')).toHaveTextContent('live'));

    // While the tab was away a notification was created. It was pushed to nobody, so the
    // only way it can appear is by asking PostgreSQL again on reconnect.
    act(() => client().emit('disconnected', {}));
    expect(screen.getByTestId('live')).toHaveTextContent('not live');
    stored = [note('missed', { title: 'Sent while offline' }), ...stored];

    act(() => client().emit('connected', {}));

    await waitFor(() => expect(titles()[0]).toBe('Sent while offline'));
    expect(screen.getByTestId('live')).toHaveTextContent('live');
  });
});

describe('the read receipt', () => {
  it('clears the count straight away and then confirms it with the server', async () => {
    const user = renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('1'));

    await user.click(screen.getByRole('button', { name: 'mark read' }));

    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));
    expect(requests('/notifications/read').map((c) => c.method)).toEqual(['POST']);
    // Re-read afterwards, so the badge reflects the write rather than the optimism.
    expect(requests('/notifications').length).toBeGreaterThanOrEqual(2);
    expect(titles()).toHaveLength(2);
  });

  it('brings the count back if the write did not land', async () => {
    const user = renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('1'));

    // The POST fails and changes nothing, so the reload that follows finds it still unread.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = String(url).replace(/^\/api/, '');
        if (path === '/notifications/read') throw new Error('offline');
        return {
          ok: true,
          status: 200,
          json: async () => ({ notifications: stored, unread: 1 }),
        } as Response;
      }),
    );

    await user.click(screen.getByRole('button', { name: 'mark read' }));

    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('1'));
  });
});
