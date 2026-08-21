// Liveness and readiness — two different questions, kept apart on purpose.
//
//   liveness  is this process still working? A no means restart it.
//   readiness can it serve a request correctly right now? A no means stop sending it
//             traffic, but leave it alone — what it is waiting for is not its fault and
//             restarting it will not help.
//
// Conflating the two is how a thirty-second database blip becomes a restart loop that
// outlives the blip. So liveness touches nothing external and answers from the process
// itself; readiness is the only one that reaches for a dependency.
//
// The third state matters as much as the two obvious ones. Realtime push and the job
// scheduler are both enhancements: without Centrifugo the client falls back to fetching
// on load, and without pg-boss the daily notifications are late rather than wrong. Neither
// is a reason to take the API out of rotation, so both are reported as `degraded` and
// neither gates readiness. PostgreSQL does, because without it there is no product.
//
// Nothing here reports what a dependency actually said. A Prisma initialisation error can
// quote the datasource URL back, and that URL contains the database password; Centrifugo's
// info response carries its node's hostname and metrics. Both are useful and neither
// belongs in an unauthenticated response body, so a check returns a status and a latency,
// and the real error goes to the log where it is already privileged.

import { currentBoss } from '../jobs/boss.js';
import { prisma } from '../lib/prisma.js';
import { realtimeConfig, type RealtimeConfig } from './realtime.js';

/** `disabled` is a configuration, not a fault: it never counts as degraded. */
export type CheckStatus = 'up' | 'down' | 'disabled';

export type ReadinessStatus = 'ok' | 'degraded' | 'unavailable';

export interface Check {
  status: CheckStatus;
  /** Round trip in milliseconds. Absent when the check made no call. */
  latencyMs?: number;
}

export interface Readiness {
  /** Whether to send this instance traffic. The HTTP status code mirrors it. */
  ok: boolean;
  status: ReadinessStatus;
  checks: {
    database: Check;
    realtime: Check;
    jobs: Check;
  };
}

export interface Liveness {
  ok: true;
  uptimeSeconds: number;
}

/**
 * How long any one check may take.
 *
 * Under the 5s the container healthcheck allows, and the checks run concurrently, so the
 * whole endpoint answers inside that budget even when every dependency is hanging. A
 * dependency that has not answered in two seconds is not going to answer usefully.
 */
const CHECK_TIMEOUT_MS = 2_000;

/** Everything a check reaches for, injectable so the tests need no Postgres. */
export interface HealthDeps {
  pingDatabase?: () => Promise<unknown>;
  realtime?: () => RealtimeConfig | null;
  pingRealtime?: (config: RealtimeConfig) => Promise<void>;
  jobs?: () => { disabled: boolean; running: boolean };
  now?: () => number;
  timeoutMs?: number;
  /** Where the real error goes. The route points this at the request logger. */
  onError?: (check: string, err: unknown) => void;
}

/**
 * Reject if `promise` has not settled in time.
 *
 * The losing side of the race is not cancelled — a query already sent to PostgreSQL runs
 * to completion regardless. That is acceptable for `SELECT 1` and is why the checks that
 * can cancel their own work, like the Centrifugo fetch below, do so themselves; this is
 * the backstop that guarantees an answer, not the mechanism that tidies up.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
    // Clearing it matters: an uncleared 2s timer holds the event loop open, which turns a
    // one-off script that calls this into a script that takes two seconds to exit.
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Run a probe, time it, and turn any failure into a status rather than a throw. */
async function timed(
  name: string,
  probe: () => Promise<unknown>,
  deps: HealthDeps,
): Promise<Check> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  try {
    await withTimeout(Promise.resolve(probe()), deps.timeoutMs ?? CHECK_TIMEOUT_MS);
    return { status: 'up', latencyMs: now() - startedAt };
  } catch (err) {
    deps.onError?.(name, err);
    // Latency on the failure too: a check that failed in 1ms is a refused connection, one
    // that failed in 2000ms is a hang, and telling them apart is most of a diagnosis.
    return { status: 'down', latencyMs: now() - startedAt };
  }
}

/**
 * Is PostgreSQL answering?
 *
 * `SELECT 1` rather than a count of anything: this asks whether the connection pool can
 * get a live connection and get a reply, which is the only thing readiness turns on. A
 * query over real tables would also fail when a migration is half applied — a genuine
 * problem, but not one a load balancer can do anything about.
 */
export function checkDatabase(deps: HealthDeps = {}): Promise<Check> {
  const ping = deps.pingDatabase ?? (() => prisma.$queryRaw`SELECT 1`);
  return timed('database', ping, deps);
}

/**
 * Can Centrifugo be reached, with the key we hold?
 *
 * `/api/info` rather than Centrifugo's own `/health`, because the failure worth catching
 * is a wrong API key: the port is open, the socket connects, subscriptions work, and every
 * push is silently rejected. /health cannot see that and this returns 401 for it.
 *
 * The response body is read only to check for an application-level error, never reported.
 */
export async function probeCentrifugo(
  config: RealtimeConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.apiUrl}/api/info`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'X-API-Key': config.apiKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) throw new Error(`Centrifugo returned ${response.status}`);
    // 200 with an `error` object is how Centrifugo reports an application-level failure,
    // so the status code alone does not mean the call succeeded.
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: number; message?: string };
    } | null;
    if (body?.error) throw new Error(`Centrifugo error ${body.error.code}: ${body.error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Realtime, or `disabled` when this deployment has no Centrifugo configured. */
export function checkRealtime(deps: HealthDeps = {}): Promise<Check> {
  const config = (deps.realtime ?? realtimeConfig)();
  if (!config) return Promise.resolve({ status: 'disabled' });
  const ping = deps.pingRealtime ?? ((c: RealtimeConfig) => probeCentrifugo(c));
  return timed('realtime', () => ping(config), deps);
}

/**
 * Did the scheduler come up?
 *
 * Synchronous, and shallow on purpose: pg-boss stores its queues in the same PostgreSQL
 * the check above already tested, so the only fact left to establish is whether this
 * process started a runner. `down` here means startJobs failed, which means nobody is
 * being sent a morning or evening notification — worth surfacing loudly, and still not
 * worth refusing requests over.
 */
export function checkJobs(deps: HealthDeps = {}): Check {
  const { disabled, running } = (deps.jobs ??
    (() => ({
      disabled: process.env.JOBS_ENABLED === 'false',
      running: currentBoss() !== null,
    })))();
  if (disabled) return { status: 'disabled' };
  return { status: running ? 'up' : 'down' };
}

/** The whole readiness answer. Never throws: an unanswerable check is a `down`, not a 500. */
export async function readiness(deps: HealthDeps = {}): Promise<Readiness> {
  // Concurrently, so the endpoint costs the slowest check rather than their sum.
  const [database, realtime] = await Promise.all([checkDatabase(deps), checkRealtime(deps)]);
  const jobs = checkJobs(deps);

  const ok = database.status === 'up';
  const degraded = [realtime, jobs].some((check) => check.status === 'down');

  return {
    ok,
    status: !ok ? 'unavailable' : degraded ? 'degraded' : 'ok',
    checks: { database, realtime, jobs },
  };
}

/**
 * Liveness. Deliberately trivial.
 *
 * Uptime is here because it is the one thing this endpoint can report that the caller
 * cannot see for itself, and it is what distinguishes a healthy process from one that is
 * crash-looping fast enough to answer between restarts. No version, no hostname, no
 * configuration: this route is reachable without a session.
 */
export function liveness(uptimeSeconds: () => number = () => process.uptime()): Liveness {
  return { ok: true, uptimeSeconds: Math.round(uptimeSeconds()) };
}
