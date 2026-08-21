import { describe, expect, it, vi } from 'vitest';
import {
  checkDatabase,
  checkJobs,
  checkRealtime,
  liveness,
  probeCentrifugo,
  readiness,
  type HealthDeps,
} from './health.js';
import type { RealtimeConfig } from './realtime.js';

const config: RealtimeConfig = {
  apiUrl: 'http://centrifugo:8000',
  apiKey: 'test-key',
  hmacSecret: 'test-secret',
  websocketUrl: 'ws://localhost:8080/connection/websocket',
};

/** All dependencies healthy, all injected: these tests touch no Postgres and no network. */
function healthy(overrides: HealthDeps = {}): HealthDeps {
  return {
    pingDatabase: async () => [{ '1': 1 }],
    realtime: () => config,
    pingRealtime: async () => {},
    jobs: () => ({ disabled: false, running: true }),
    ...overrides,
  };
}

describe('checkDatabase', () => {
  it('reports up with a latency when the query answers', async () => {
    const check = await checkDatabase(healthy());
    expect(check.status).toBe('up');
    expect(check.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports down rather than throwing when the query fails', async () => {
    const check = await checkDatabase(
      healthy({
        pingDatabase: async () => {
          throw new Error("Can't reach database server at `postgres`:`5432`");
        },
      }),
    );
    expect(check.status).toBe('down');
  });

  it('reports down when the query hangs, instead of hanging with it', async () => {
    const check = await checkDatabase(
      healthy({ pingDatabase: () => new Promise(() => {}), timeoutMs: 5 }),
    );
    expect(check.status).toBe('down');
  });
});

describe('checkRealtime', () => {
  it('is disabled, not down, when no Centrifugo is configured', async () => {
    const check = await checkRealtime(healthy({ realtime: () => null }));
    expect(check.status).toBe('disabled');
    // No call was made, so there is no latency to report.
    expect(check.latencyMs).toBeUndefined();
  });

  it('reports down when the probe fails', async () => {
    const check = await checkRealtime(
      healthy({
        pingRealtime: async () => {
          throw new Error('Centrifugo returned 401');
        },
      }),
    );
    expect(check.status).toBe('down');
  });
});

describe('checkJobs', () => {
  it('is up when a runner is going', () => {
    expect(checkJobs(healthy())).toEqual({ status: 'up' });
  });

  it('is disabled when jobs were turned off deliberately', () => {
    expect(checkJobs(healthy({ jobs: () => ({ disabled: true, running: false }) }))).toEqual({
      status: 'disabled',
    });
  });

  it('is down when jobs should be running and are not', () => {
    expect(checkJobs(healthy({ jobs: () => ({ disabled: false, running: false }) }))).toEqual({
      status: 'down',
    });
  });
});

describe('readiness', () => {
  it('is ok when everything answers', async () => {
    const result = await readiness(healthy());
    expect(result).toEqual({
      ok: true,
      status: 'ok',
      checks: {
        database: { status: 'up', latencyMs: expect.any(Number) },
        realtime: { status: 'up', latencyMs: expect.any(Number) },
        jobs: { status: 'up' },
      },
    });
  });

  it('is unavailable, and not ok, when the database is unreachable', async () => {
    const result = await readiness(
      healthy({
        pingDatabase: async () => {
          throw new Error('connection refused');
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('unavailable');
  });

  // The distinction the whole module exists for: realtime and jobs are enhancements, so
  // losing them must not take the API out of rotation. If either of these ever flips to
  // ok: false, a Centrifugo restart becomes an outage of the entire product.
  it('stays ok when realtime is down', async () => {
    const result = await readiness(
      healthy({
        pingRealtime: async () => {
          throw new Error('fetch failed');
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('degraded');
    expect(result.checks.realtime.status).toBe('down');
  });

  it('stays ok when the scheduler is down', async () => {
    const result = await readiness(healthy({ jobs: () => ({ disabled: false, running: false }) }));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('degraded');
  });

  it('is ok, not degraded, when optional dependencies are switched off', async () => {
    const result = await readiness(
      healthy({ realtime: () => null, jobs: () => ({ disabled: true, running: false }) }),
    );
    expect(result.status).toBe('ok');
  });

  it('unavailable outranks degraded', async () => {
    const result = await readiness(
      healthy({
        pingDatabase: async () => {
          throw new Error('connection refused');
        },
        pingRealtime: async () => {
          throw new Error('fetch failed');
        },
      }),
    );
    expect(result.status).toBe('unavailable');
  });

  it('reports failures to the log and nowhere else', async () => {
    const onError = vi.fn();
    // A message shaped like the ones that actually leak: Prisma quotes the datasource URL
    // back on a malformed connection string, and the password is in it.
    const secret = 'postgresql://goalify:sup3rs3cret@postgres:5432/goalify';
    const result = await readiness(
      healthy({
        onError,
        pingDatabase: async () => {
          throw new Error(`Error parsing connection string: ${secret}`);
        },
      }),
    );

    expect(onError).toHaveBeenCalledWith('database', expect.any(Error));
    expect(JSON.stringify(result)).not.toContain('sup3rs3cret');
    expect(JSON.stringify(result)).not.toContain('parsing connection string');
  });

  it('answers even when every dependency hangs', async () => {
    const result = await readiness(
      healthy({
        pingDatabase: () => new Promise(() => {}),
        pingRealtime: () => new Promise(() => {}),
        timeoutMs: 5,
      }),
    );
    expect(result.status).toBe('unavailable');
    expect(result.checks.realtime.status).toBe('down');
  });
});

describe('probeCentrifugo', () => {
  it('sends the API key and accepts a good reply', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: { nodes: [] } })));
    await expect(
      probeCentrifugo(config, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://centrifugo:8000/api/info');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('test-key');
  });

  // The failure this check exists for: the port is open and subscriptions work, but the
  // key is wrong, so every push is rejected and nothing else would notice.
  it('rejects a wrong API key', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    await expect(probeCentrifugo(config, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      '401',
    );
  });

  it('rejects a 200 that carries an error object', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: 108, message: 'not available' } })),
    );
    await expect(probeCentrifugo(config, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      '108',
    );
  });

  it('rejects when the connection fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await expect(probeCentrifugo(config, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'fetch failed',
    );
  });

  it('aborts rather than waiting forever', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(
      probeCentrifugo(config, fetchImpl as unknown as typeof fetch, 5),
    ).rejects.toThrow('aborted');
  });
});

describe('liveness', () => {
  it('reports ok and a whole number of seconds', () => {
    expect(liveness(() => 12.7)).toEqual({ ok: true, uptimeSeconds: 13 });
  });
});
