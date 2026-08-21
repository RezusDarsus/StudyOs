// Durable background jobs, backed by the same PostgreSQL the app already trusts.
//
// pg-boss keeps its queues in a `pgboss` schema inside our database. That is the whole
// reason to use it rather than setInterval: a notification that must arrive at most once
// per user per day cannot depend on a process staying alive, and a second datastore
// would be a second thing to get wrong. Jobs are rows, so they survive a restart, and a
// deploy in the middle of a run resumes rather than skips.
//
// pg-boss owns its own connection pool, separate from Prisma's. The handlers still use
// Prisma for everything they read and write; pg-boss only needs its own connections for
// polling and maintenance, which have a very different lifetime from a web request.

import { PgBoss } from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The tick that drives both scheduled daily notifications.
 *
 * One queue rather than two because both jobs answer the same first question — what
 * local time is it for this user — and the answer costs one profile scan. The handler
 * decides per user which of the two, if either, is due.
 */
export const DAILY_NOTIFICATIONS_QUEUE = 'daily-notifications';

/**
 * Every five minutes, all day.
 *
 * Users pick their own delivery time, in their own timezone, so there is no single
 * hour at which "the morning job" can run. The tick asks instead: whose local clock
 * has passed the time they asked for, and who has not been told yet? Cron frequency
 * therefore sets *lateness*, never correctness — the dedupe key is what makes a
 * second tick harmless. Five minutes is the worst-case delay on a chosen time.
 */
const DAILY_NOTIFICATIONS_CRON = '*/5 * * * *';

let boss: PgBoss | null = null;

/**
 * The connection string pg-boss can actually use.
 *
 * DATABASE_URL is written for Prisma, and Prisma accepts parameters libpq never heard
 * of — `schema`, `connection_limit`, `pgbouncer`. Handing those to node-postgres either
 * does nothing or does something surprising, and `schema=public` in particular reads
 * like an instruction about where pg-boss should install itself, which it is not.
 * Keep the parts that identify the server and drop the rest.
 */
export function bossConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get('sslmode');
  url.search = sslmode ? `?sslmode=${encodeURIComponent(sslmode)}` : '';
  return url.toString();
}

/**
 * Start the job runner and register everything it should do.
 *
 * Idempotent: calling it twice returns the running instance rather than opening a
 * second pool. `createQueue` and `schedule` are both upserts in pg-boss, so a restart
 * re-declares the same queue and the same cron entry without duplicating either.
 */
export async function startJobs(log: FastifyBaseLogger): Promise<PgBoss | null> {
  if (boss) return boss;

  if (process.env.JOBS_ENABLED === 'false') {
    log.info('jobs: disabled by JOBS_ENABLED=false');
    return null;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error('jobs: DATABASE_URL is not set — no scheduled notifications will be sent');
    return null;
  }

  const instance = new PgBoss({
    connectionString: bossConnectionString(databaseUrl),
    schema: 'pgboss',
    application_name: 'goalify-jobs',
    // Small: this pool exists for polling and maintenance, not for request traffic.
    max: 3,
  });

  // pg-boss emits rather than throws for anything after start(). Unhandled, an
  // 'error' event on an EventEmitter takes the process down, so this listener is
  // required, not optional.
  instance.on('error', (error) => log.error({ err: error }, 'jobs: pg-boss error'));
  instance.on('warning', (warning) => log.warn({ warning }, 'jobs: pg-boss warning'));

  await instance.start();

  await instance.createQueue(DAILY_NOTIFICATIONS_QUEUE, {
    // One tick at a time. If a run is somehow still going when the next cron fires,
    // the new job waits instead of scanning the same users concurrently.
    policy: 'singleton',
    // A tick that has not finished in five minutes is stuck, not slow.
    expireInSeconds: 300,
    retryLimit: 2,
    retryDelay: 60,
    // Ticks are worthless once stale: a missed 08:00 is not worth sending at 09:00
    // from a queued job, because the next tick will decide that question afresh.
    retentionSeconds: 600,
    deleteAfterSeconds: 3600,
  });

  // Imported here rather than at the top of the file so the handler's own imports —
  // Prisma, the scoring domain — are not pulled in by a process that runs no jobs.
  const { runDailyNotifications } = await import('./daily-notifications.js');

  await instance.work(
    DAILY_NOTIFICATIONS_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 15 },
    async () => {
      const result = await runDailyNotifications(log);
      log.info({ ...result }, 'jobs: daily notification tick');
    },
  );

  await instance.schedule(DAILY_NOTIFICATIONS_QUEUE, DAILY_NOTIFICATIONS_CRON, null, {
    // The cron itself is timezone-free — every five minutes is every five minutes.
    // Each user's own timezone is applied inside the handler, where it belongs.
    tz: 'UTC',
  });

  boss = instance;
  log.info(
    { queue: DAILY_NOTIFICATIONS_QUEUE, cron: DAILY_NOTIFICATIONS_CRON },
    'jobs: started',
  );
  return instance;
}

/** Finish the job in flight, then let go of the pool. */
export async function stopJobs(): Promise<void> {
  if (!boss) return;
  const instance = boss;
  boss = null;
  await instance.stop({ graceful: true, close: true, timeout: 30_000 });
}

/** The running instance, or null when jobs are disabled. For diagnostics only. */
export function currentBoss(): PgBoss | null {
  return boss;
}
