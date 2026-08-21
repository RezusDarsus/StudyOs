// Realtime push: how a notification that already exists in PostgreSQL reaches a browser
// that happens to be open right now.
//
// The ordering is the entire design. A notification is a row first and a push second, and
// the push is allowed to fail. Centrifugo runs on its in-memory engine with no history
// configured, so it cannot answer "what did I miss" — and it is never asked to. The client
// fetches GET /api/notifications on connect and again on every reconnect; the push exists
// only to spare it from polling while the tab is open.
//
// Two rules follow from that, and both are load-bearing:
//
//   1. Nothing in this file may throw into a caller. A failed push must never fail the
//      request, job or transaction that created the notification.
//   2. Nothing in this file is a source of truth. Delete it and the product is still
//      correct — only less immediate.
//
// Realtime is also optional. With the environment unset the API serves every endpoint as
// before and the widget falls back to fetching. That is what makes it safe to run the API
// in a context where no Centrifugo exists, such as a test or a one-off script.

import { signHs256 } from '../lib/jwt.js';

/**
 * How long a connection token is good for.
 *
 * Short, because it is a bearer credential: whoever holds it can open a socket as that
 * user until it expires. The client does not have to care — Centrifugo's SDK asks for a
 * fresh one through the same authenticated endpoint when this expires, so the ceiling on
 * a leaked token is minutes rather than the thirty days a session cookie lasts.
 */
export const CONNECTION_TOKEN_TTL_SECONDS = 15 * 60;

/** How long to wait on Centrifugo before giving up on a push. */
const PUBLISH_TIMEOUT_MS = 3_000;

export interface RealtimeConfig {
  /** Server-side base URL — how the API reaches Centrifugo. */
  apiUrl: string;
  apiKey: string;
  hmacSecret: string;
  /** Browser-facing WebSocket URL — what the API tells clients to connect to. */
  websocketUrl: string;
}

/**
 * The channel a user's own events go to: `personal:#<userId>`.
 *
 * `#` is Centrifugo's user boundary. Because the `personal` namespace sets
 * `allow_user_limited_channels`, Centrifugo itself checks that the id after the `#`
 * matches the user id in the subscriber's connection token, and rejects everyone else
 * with `103: permission denied`. That check is why this design needs no per-channel
 * subscription tokens: there is no secret to issue, leak or forget to scope.
 */
export function channelFor(userId: string): string {
  return `personal:#${userId}`;
}

/**
 * Turn the server-side URL into one a browser can use, but only for loopback.
 *
 * In development both are the same host and requiring two variables would be noise. In a
 * real deployment they genuinely differ — the API talks to `http://centrifugo:8000` on a
 * container network while the browser goes to `wss://goalify.app` through the proxy that
 * terminates TLS. Guessing in that case would hand every client an internal hostname it
 * cannot resolve, so anything that is not loopback has to say so explicitly.
 */
function derivedWebsocketUrl(apiUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  const isLoopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (!isLoopback) return null;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/connection/websocket';
  url.search = '';
  return url.toString();
}

/**
 * Read the environment, or return null if realtime is not configured.
 *
 * All three secrets must be present together. A half-configured Centrifugo — an API key
 * but no signing secret, say — would publish events that no client is able to subscribe
 * for, which looks like working software and is not.
 */
export function realtimeConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig | null {
  const apiUrl = env.CENTRIFUGO_URL?.trim();
  const apiKey = env.CENTRIFUGO_API_KEY?.trim();
  const hmacSecret = env.CENTRIFUGO_TOKEN_HMAC_SECRET?.trim();
  if (!apiUrl || !apiKey || !hmacSecret) return null;

  const websocketUrl = env.CENTRIFUGO_WS_URL?.trim() || derivedWebsocketUrl(apiUrl);
  if (!websocketUrl) return null;

  return { apiUrl: apiUrl.replace(/\/+$/, ''), apiKey, hmacSecret, websocketUrl };
}

/**
 * A connection token for one user.
 *
 * `sub` comes from the caller, and every caller takes it from the resolved session rather
 * than from request input — see routes/realtime.ts. This is the single place where the
 * identity of a socket is decided, so it is the single place that could get it wrong.
 */
export function issueConnectionToken(
  userId: string,
  secret: string,
  now: number = Date.now(),
): string {
  const issuedAt = Math.floor(now / 1000);
  return signHs256(
    {
      // A string, per Centrifugo's contract — a numeric sub is rejected.
      sub: userId,
      iat: issuedAt,
      exp: issuedAt + CONNECTION_TOKEN_TTL_SECONDS,
    },
    secret,
  );
}

// ------------------------------------------------------------------ publishing

/**
 * Failure logging, rate limited.
 *
 * Centrifugo being down should be visible, but the daily notification tick pushes to
 * every active user at once, and one line per user would bury the log at the exact moment
 * someone is reading it. So: the first failure speaks, then at most one line a minute,
 * carrying the count of everything it stood in for.
 */
const FAILURE_LOG_INTERVAL_MS = 60_000;
let suppressedFailures = 0;
let lastFailureLoggedAt = 0;

function noteFailure(reason: string, now = Date.now()): void {
  suppressedFailures++;
  if (now - lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) return;
  const also = suppressedFailures > 1 ? ` (+${suppressedFailures - 1} more since last report)` : '';
  console.warn(`[realtime] push failed: ${reason}${also}`);
  lastFailureLoggedAt = now;
  suppressedFailures = 0;
}

/**
 * Publish one event to a user's own channel. Never throws; returns whether it landed.
 *
 * Centrifugo's server API answers 200 with an `error` object for application-level
 * failures — an unknown namespace, a malformed channel — so the status code alone does
 * not mean success and is not treated as if it did.
 */
export async function publishToUser(
  userId: string,
  event: unknown,
  config: RealtimeConfig | null = realtimeConfig(),
): Promise<boolean> {
  if (!config) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.apiUrl}/api/publish`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        // The header form rather than ?api_key=, which would land the key in access logs.
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: channelFor(userId), data: event }),
    });

    if (!response.ok) {
      noteFailure(`Centrifugo returned ${response.status}`);
      return false;
    }

    const body = (await response.json().catch(() => null)) as {
      error?: { code?: number; message?: string };
    } | null;
    if (body?.error) {
      noteFailure(`Centrifugo error ${body.error.code}: ${body.error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    noteFailure(
      (err as Error).name === 'AbortError' ? 'timed out' : ((err as Error).message ?? 'unknown'),
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
