import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_TOKEN_TTL_SECONDS,
  channelFor,
  issueConnectionToken,
  publishToUser,
  realtimeConfig,
} from './realtime.js';

const SECRET = 'test-secret-not-a-real-one';

/** Decode a compact JWS the way Centrifugo will, and check the signature ourselves. */
function decode(token: string) {
  const [head, body, signature] = token.split('.');
  const expected = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return {
    header: JSON.parse(Buffer.from(head, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
    signatureValid: signature === expected,
  };
}

describe('connection tokens', () => {
  it('signs claims Centrifugo will accept', () => {
    const token = issueConnectionToken('user-123', SECRET, 1_700_000_000_000);
    const { header, claims, signatureValid } = decode(token);

    expect(signatureValid).toBe(true);
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    // A string subject, not a number: Centrifugo rejects a numeric `sub` outright.
    expect(claims.sub).toBe('user-123');
    expect(typeof claims.sub).toBe('string');
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_000_000 + CONNECTION_TOKEN_TTL_SECONDS);
  });

  it('expires, so a leaked token stops working', () => {
    // The point of the assertion is the *presence* of exp. Centrifugo treats a token
    // without one as a connection that never needs re-authorising, which would outlive
    // logout, a password change and the session it was minted from.
    const { claims } = decode(issueConnectionToken('u', SECRET));
    expect(claims.exp).toBeGreaterThan(claims.iat);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60 * 60);
  });

  it('has a signature that depends on the secret', () => {
    const a = issueConnectionToken('user-123', SECRET, 1_700_000_000_000);
    const b = issueConnectionToken('user-123', 'a-different-secret', 1_700_000_000_000);
    expect(a).not.toBe(b);
    // Same claims either way — only the third segment moves.
    expect(a.split('.').slice(0, 2)).toEqual(b.split('.').slice(0, 2));
  });

  it('refuses to sign without a secret', () => {
    expect(() => issueConnectionToken('u', '')).toThrow(/secret/i);
  });
});

describe('channel naming', () => {
  it('puts the user id after the boundary Centrifugo enforces', () => {
    // Both halves matter. `personal` must be a declared namespace or the subscribe fails
    // with "unknown channel"; the `#` is what makes Centrifugo compare the tail against
    // the subscriber's own token instead of letting anyone in.
    expect(channelFor('abc123')).toBe('personal:#abc123');
  });

  it('is the same string for the publisher and the subscriber', () => {
    // Centrifugo matches channel names literally — a publish to a channel spelled even
    // slightly differently succeeds and is delivered to nobody.
    const userId = 'cmt1pgq1v0006v5poaat480ns';
    expect(channelFor(userId)).toBe(channelFor(userId));
    expect(channelFor(userId)).not.toBe(`personal:#${userId} `);
  });
});

describe('configuration', () => {
  const full = {
    CENTRIFUGO_URL: 'http://127.0.0.1:8000',
    CENTRIFUGO_API_KEY: 'key',
    CENTRIFUGO_TOKEN_HMAC_SECRET: 'secret',
  } as NodeJS.ProcessEnv;

  it('derives the browser URL for loopback', () => {
    const config = realtimeConfig(full);
    expect(config?.websocketUrl).toBe('ws://127.0.0.1:8000/connection/websocket');
    expect(config?.apiUrl).toBe('http://127.0.0.1:8000');
  });

  it('upgrades the scheme with the source URL', () => {
    expect(realtimeConfig({ ...full, CENTRIFUGO_URL: 'https://localhost:8000' })?.websocketUrl).toBe(
      'wss://localhost:8000/connection/websocket',
    );
  });

  it('refuses to guess a browser URL for a non-loopback host', () => {
    // `http://centrifugo:8000` is reachable from the API on a container network and from
    // no browser anywhere. Guessing here would ship an unresolvable address to every
    // client, so this must be configured rather than inferred.
    expect(realtimeConfig({ ...full, CENTRIFUGO_URL: 'http://centrifugo:8000' })).toBeNull();
    expect(
      realtimeConfig({
        ...full,
        CENTRIFUGO_URL: 'http://centrifugo:8000',
        CENTRIFUGO_WS_URL: 'wss://goalify.app/connection/websocket',
      })?.websocketUrl,
    ).toBe('wss://goalify.app/connection/websocket');
  });

  it('treats a half-configured Centrifugo as no Centrifugo', () => {
    // An API key without a signing secret publishes events no client can subscribe for.
    // That looks like working software from the server's side, which is the worst case.
    expect(realtimeConfig({})).toBeNull();
    expect(realtimeConfig({ ...full, CENTRIFUGO_API_KEY: undefined })).toBeNull();
    expect(realtimeConfig({ ...full, CENTRIFUGO_TOKEN_HMAC_SECRET: undefined })).toBeNull();
    expect(realtimeConfig({ ...full, CENTRIFUGO_URL: undefined })).toBeNull();
    // Empty and whitespace-only count as unset, not as configured-with-nothing.
    expect(realtimeConfig({ ...full, CENTRIFUGO_API_KEY: '   ' })).toBeNull();
  });

  it('tolerates a trailing slash on the base URL', () => {
    // Otherwise the publish URL becomes http://host:8000//api/publish.
    expect(realtimeConfig({ ...full, CENTRIFUGO_URL: 'http://127.0.0.1:8000/' })?.apiUrl).toBe(
      'http://127.0.0.1:8000',
    );
  });
});

describe('publishing is best effort', () => {
  const config = {
    apiUrl: 'http://centrifugo:8000',
    apiKey: 'key',
    hmacSecret: 'secret',
    websocketUrl: 'ws://x/connection/websocket',
  };

  afterEach(() => vi.unstubAllGlobals());

  it('does nothing, quietly, when realtime is not configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await publishToUser('u', { a: 1 }, null)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the event to the user own channel with the key in a header', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    expect(await publishToUser('user-9', { event: 'notification' }, config)).toBe(true);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://centrifugo:8000/api/publish');
    // In a header, not a query string: ?api_key= would put the key in every access log.
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('key');
    expect(url).not.toContain('api_key');
    expect(JSON.parse(init.body as string)).toEqual({
      channel: 'personal:#user-9',
      data: { event: 'notification' },
    });
  });

  it('treats a 200 carrying an error object as a failure', async () => {
    // Centrifugo answers 200 with {"error":{...}} for application-level problems such as
    // an undeclared namespace. Trusting the status code alone would report a push that
    // reached nobody as delivered.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 102, message: 'unknown channel' } }), {
            status: 200,
          }),
      ),
    );
    expect(await publishToUser('u', {}, config)).toBe(false);
  });

  it('reports a rejected key as a failure rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    expect(await publishToUser('u', {}, config)).toBe(false);
  });

  it('swallows a dead Centrifugo', async () => {
    // The contract the caller depends on: creating a notification must not fail because
    // the realtime server is unreachable. The row is the product; the push is a courtesy.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(publishToUser('u', {}, config)).resolves.toBe(false);
  });

  it('swallows a malformed response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    // Unparseable but 200 and no error field to read: nothing says it failed, so it did not.
    await expect(publishToUser('u', {}, config)).resolves.toBe(true);
  });
});
