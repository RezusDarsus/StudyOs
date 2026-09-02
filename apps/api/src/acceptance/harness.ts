// The rig the twelve acceptance tests run on.
//
// What it deliberately is: the real Fastify server from src/server.ts, the real routes, the
// real services, the real PostgreSQL. Nothing between the test and the application except
// `app.inject()`, which is Fastify's own in-process HTTP.
//
// What it deliberately is not: a mock of anything the product owns. Exactly two things are
// substituted, and both are outside the boundary —
//
//   * the model provider, through the `setProvider` seam that already exists in
//     ai/client.ts. An acceptance test that called NVIDIA would assert on a different
//     sentence every run, cost money, and fail when the network did.
//   * the clock, where a test needs one, through the `now` parameter that
//     runDailyNotifications and loadUserDay already take. No global timer faking.
//
// Sessions are minted with Prisma plus lib/auth.ts's createSession rather than through
// POST /auth/register. That is not a shortcut around authentication — the cookie goes
// through the same resolveSession path every real request uses — it is a way around
// `signupsPerAddress`, a module-level AttemptWindow of ten sign-ups an hour keyed on
// req.ip. Under inject() every request shares one address, so the eleventh user a suite
// created would be refused, and the failure would look like a broken test rather than a
// working rate limiter.

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { setProvider } from '../ai/client.js';
import type { AiChatProvider, AiPurpose, ChatRequest, ChatResponse } from '../ai/provider.js';
import { SESSION_COOKIE, createSession, hashPassword } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { installRuntimeContent } from '../runtime-content.js';
import { buildServer } from '../server.js';
import { ACCEPTANCE_SUFFIX } from './database.js';

// ------------------------------------------------------------------ the provider stub

type StubHandler = (request: ChatRequest) => unknown;

/**
 * A deterministic stand-in for the model.
 *
 * Two ways to program it. `respond` sets a standing answer for a purpose; `queue` adds
 * one-shot answers that are consumed in order and take precedence, which is how a test
 * walks an interview through several different turns.
 *
 * It also keeps every request it was given. Two of the acceptance tests are assertions
 * about the prompt rather than the reply — that a slash survives the round trip, and that
 * one goal's memory never reaches another goal's prompt — and neither is answerable
 * without this.
 */
export class StubProvider implements AiChatProvider {
  readonly name = 'stub';
  readonly model = 'stub-deterministic';
  readonly requests: ChatRequest[] = [];

  private standing = new Map<AiPurpose, StubHandler>();
  private queues = new Map<AiPurpose, unknown[]>();

  respond(purpose: AiPurpose, handler: StubHandler | unknown): this {
    this.standing.set(
      purpose,
      typeof handler === 'function' ? (handler as StubHandler) : () => handler,
    );
    return this;
  }

  queue(purpose: AiPurpose, ...payloads: unknown[]): this {
    const queue = this.queues.get(purpose) ?? [];
    queue.push(...payloads);
    this.queues.set(purpose, queue);
    return this;
  }

  /**
   * Fail every call for a purpose with a thrown provider error — how a test
   * reproduces a genuine provider outage without touching the network.
   */
  fail(purpose: AiPurpose, error: Error): this {
    this.standing.set(purpose, () => {
      throw error;
    });
    return this;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);

    const queued = this.queues.get(request.purpose);
    const payload = queued?.length ? queued.shift() : this.standing.get(request.purpose)?.(request);

    if (payload === undefined) {
      throw new Error(
        `StubProvider has no answer for ${request.purpose}. Add one with queue('${request.purpose}', …) or respond('${request.purpose}', …).`,
      );
    }
    return { content: JSON.stringify(payload), latencyMs: 1 };
  }

  /**
   * Every message the provider was handed for a purpose, flattened to one string.
   *
   * `role` matters more than it looks. The system prompts contain illustrative
   * examples — the interview one literally says `actually I meant swimming` — so
   * "the prompt does not mention swimming" is only a meaningful assertion about the
   * user message, which is where a leaked memory would actually land.
   */
  promptsFor(purpose: AiPurpose, role?: 'system' | 'user' | 'assistant'): string {
    return this.requests
      .filter((r) => r.purpose === purpose)
      .flatMap((r) => r.messages.filter((m) => !role || m.role === role).map((m) => m.content))
      .join('\n');
  }

  countOf(purpose: AiPurpose): number {
    return this.requests.filter((r) => r.purpose === purpose).length;
  }

  reset(): void {
    this.requests.length = 0;
    this.standing.clear();
    this.queues.clear();
    // A draft generation fires preference extraction as a floating promise. Nothing in
    // these tests is about what it learns, so it gets a standing answer that stores
    // nothing — the alternative is a stray rejection in the middle of an unrelated test.
    this.respond('PREFERENCE_EXTRACTION', { preferences: [] });
  }
}

// ------------------------------------------------------------------ users and requests

export interface TestUser {
  id: string;
  email: string;
  name: string;
  timezone: string;
  /** The session cookie's value — the same 32-byte token POST /auth/login hands out. */
  token: string;
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

let userSeq = 0;

async function makeUser(opts: {
  name?: string;
  timezone?: string;
  profile?: Record<string, unknown>;
} = {}): Promise<TestUser> {
  userSeq += 1;
  const name = opts.name ?? `Test User ${userSeq}`;
  const email = `user${userSeq}.${Date.now().toString(36)}@goalify.test`;
  const timezone = opts.timezone ?? 'Asia/Tbilisi';

  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: await hashPassword('goalify123'),
      profile: { create: { timezone, ...opts.profile } },
    },
  });

  return { id: user.id, email, name, timezone, token: await createSession(user.id) };
}

// ------------------------------------------------------------------ the harness itself

export interface Harness {
  readonly app: FastifyInstance;
  readonly ai: StubProvider;
  createUser(opts?: {
    name?: string;
    timezone?: string;
    profile?: Record<string, unknown>;
  }): Promise<TestUser>;
  /** One authenticated request, with the body already parsed. */
  call<T = any>(
    user: TestUser | null,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<ApiResponse<T>>;
  /** The same, but fails the call rather than returning a non-2xx for the test to check. */
  ok<T = any>(
    user: TestUser | null,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<T>;
}

let tableList: string | null = null;

/**
 * Empty every application table, leaving the schema and pg-boss alone.
 *
 * `public` only, on purpose: the `pgboss` schema holds the durable job state, and one of
 * these tests is specifically about that state surviving. TRUNCATE … CASCADE rather than
 * ordered deletes because the foreign keys form a graph, and RESTART IDENTITY because a
 * test that reads better with predictable ids should get them.
 */
export async function resetDatabase(): Promise<void> {
  if (tableList === null) {
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT tablename AS name
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;
    tableList = tables.map((t) => `"public"."${t.name.replace(/"/g, '""')}"`).join(', ');
  }
  if (!tableList) return;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

/**
 * Wire a test file up: one server for the file, a clean database and a clean provider
 * before each test.
 */
export function useHarness(): Harness {
  const ai = new StubProvider();
  let app: FastifyInstance;

  beforeAll(async () => {
    // Stage 3: the runtime-knowledge port must exist before the server (and
    // any direct-service test) reads it. Explicit bootstrap, same as the
    // real server does in buildServer().
    installRuntimeContent();
    // The tripwire. Everything else in this file assumes it is safe to truncate every
    // table, and this is the one line that makes that assumption true. A DATABASE_URL
    // that slipped through pointing at development stops the run here, before the first
    // reset, rather than after it.
    const [{ current_database: database }] = await prisma.$queryRaw<
      Array<{ current_database: string }>
    >`SELECT current_database()`;
    if (!database.endsWith(ACCEPTANCE_SUFFIX)) {
      throw new Error(
        `Refusing to run: connected to "${database}", which does not end in "${ACCEPTANCE_SUFFIX}". The acceptance suite truncates every table and must never point at a real database.`,
      );
    }

    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    await resetDatabase();
    ai.reset();
    setProvider(ai);
  });

  afterAll(async () => {
    setProvider(null);
    await app?.close();
    await prisma.$disconnect();
  });

  const call = async <T,>(
    user: TestUser | null,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<ApiResponse<T>> => {
    const options: InjectOptions = { method, url };
    if (user) options.cookies = { [SESSION_COOKIE]: user.token };
    if (payload !== undefined) options.payload = payload as InjectOptions['payload'];

    const response = await app.inject(options);
    const text = response.body;
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.statusCode, body: body as T };
  };

  return {
    get app() {
      return app;
    },
    ai,
    createUser: makeUser,
    call,
    ok: async <T,>(
      user: TestUser | null,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: unknown,
    ): Promise<T> => {
      const response = await call<T>(user, method, url, payload);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `${method} ${url} expected 2xx, got ${response.status}: ${JSON.stringify(response.body)}`,
        );
      }
      return response.body;
    },
  };
}

// ------------------------------------------------------------------ small conveniences

/** A UTC instant that is `time` on the wall clock of a given IANA zone, on `day`. */
export function instantAt(day: string, time: string, timezone: string): Date {
  // Start from the naive reading, then correct by whatever offset the zone was actually
  // on at that moment. One correction is enough for every real zone: the offset is only
  // wrong by an hour or so, never enough to land in a different DST period.
  const naive = new Date(`${day}T${time}:00.000Z`);
  const offsetMinutes = zoneOffsetMinutes(naive, timezone);
  return new Date(naive.getTime() - offsetMinutes * 60_000);
}

function zoneOffsetMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Poll until `check` returns something truthy, or give up. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  { timeoutMs = 30_000, intervalMs = 500, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A silent logger with the shape pg-boss and the job tick expect. */
export function quietLogger() {
  const noop = () => {};
  const logger: any = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    silent: noop,
    level: 'silent',
  };
  logger.child = () => logger;
  return logger;
}
