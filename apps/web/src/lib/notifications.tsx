// Notifications, held once for the whole authenticated shell.
//
// Two rules shape everything below:
//
//   1. PostgreSQL is the truth. Every list this provider shows came from
//      `GET /api/notifications`. The socket only ever says "something changed" —
//      it is never consulted for what the notifications *are*, and the app is
//      still correct with the socket switched off, merely less immediate.
//
//   2. The socket may fail at any point without the user learning a new word.
//      A server with no Centrifugo answers `{ enabled: false }`; a browser that
//      cannot reach it falls back to the same fetch-only behaviour. Neither is an
//      error state, and neither shows an error.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Centrifuge, UnauthorizedError } from 'centrifuge';
import { ApiError, api } from './api';
import type { Notification } from './types';

/** What `/api/realtime/token` answers. `enabled: false` is a working reply, not a failure. */
type TokenResponse =
  | { enabled: false }
  | { enabled: true; url: string; token: string; channel: string; expiresInSeconds: number };

/** The API returns at most 60 rows; hold the same number so a long session stays bounded. */
const MAX_HELD = 60;

interface NotificationsValue {
  notifications: Notification[];
  /** Derived from the list, so there is only ever one number and it cannot drift. */
  unread: number;
  loading: boolean;
  error: string | null;
  /** Whether pushes are currently arriving. Used to describe, never to hide anything. */
  live: boolean;
  reload(): void;
  /** Marks everything read — the server's own semantics for a bodyless read receipt. */
  markRead(): Promise<void>;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  // Stable for the life of the provider, so the socket set up below can refetch without
  // being torn down and rebuilt every time the list changes.
  const load = useCallback(async () => {
    try {
      const data = await api.get<{ notifications: Notification[] }>('/notifications');
      setNotifications(data.notifications);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load notifications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    let client: Centrifuge | null = null;

    (async () => {
      let first: TokenResponse;
      try {
        first = await api.get<TokenResponse>('/realtime/token');
      } catch {
        return; // Fetch-only from here. The list is still right, just not instant.
      }
      if (cancelled || !first.enabled) return;

      client = new Centrifuge(first.url, {
        token: first.token,
        // Called when a token is actually needed rather than on every reconnect, so this is
        // the refresh path. It goes back to the same authenticated endpoint: the page never
        // holds a secret it could use to mint a token of its own, or one for anybody else.
        getToken: async () => {
          let next: TokenResponse;
          try {
            next = await api.get<TokenResponse>('/realtime/token');
          } catch (err) {
            // Centrifuge retries a rejected getToken forever unless the rejection is an
            // UnauthorizedError. A signed-out session will not start working again.
            if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
              throw new UnauthorizedError('session ended');
            }
            throw err;
          }
          if (!next.enabled) throw new UnauthorizedError('realtime switched off');
          return next.token;
        },
      });

      client
        .newSubscription(first.channel)
        .on('publication', (ctx) => {
          const payload = ctx.data as { event?: string; notification?: Notification };
          const pushed = payload?.notification;
          if (payload?.event !== 'notification' || !pushed) return;
          setNotifications((current) =>
            // A push and a refetch can race. Both are built by the same mapper on the
            // server, so whichever arrives first is the same row either way — all that is
            // left to settle is not showing it twice.
            current.some((n) => n.id === pushed.id) ? current : [pushed, ...current].slice(0, MAX_HELD),
          );
        })
        .subscribe();

      client.on('connected', () => {
        setLive(true);
        // On every connect, not just the first. Centrifugo is deliberately configured with
        // no history, so anything created while this tab was away was pushed to nobody and
        // now exists only in PostgreSQL. Re-reading is what stops the two from diverging —
        // including in the narrow window between the first fetch and the first subscribe.
        void load();
      });
      client.on('disconnected', () => setLive(false));
      client.on('connecting', () => setLive(false));
      // Transport blips and token trouble both arrive here. There is nothing a user could
      // usefully do about either, and Centrifuge reconnects on its own.
      client.on('error', () => {});

      client.connect();
    })();

    return () => {
      cancelled = true;
      client?.disconnect();
    };
  }, [load]);

  const markRead = useCallback(async () => {
    const readAt = new Date().toISOString();
    // Optimistic, because the badge should clear the instant the page opens. The reload
    // afterwards is what makes it true: if the write failed, the unread count comes back.
    setNotifications((current) => current.map((n) => (n.readAt ? n : { ...n, readAt })));
    try {
      await api.post('/notifications/read');
    } catch {
      /* the reload reports whatever actually happened */
    }
    await load();
  }, [load]);

  const value = useMemo<NotificationsValue>(
    () => ({
      notifications,
      unread: notifications.filter((n) => !n.readAt).length,
      loading,
      error,
      live,
      reload: () => void load(),
      markRead,
    }),
    [notifications, loading, error, live, load, markRead],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used inside NotificationsProvider');
  return ctx;
}
