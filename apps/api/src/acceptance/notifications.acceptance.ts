// PARTS 53-58 — the notification half of the Phase 2.5 acceptance suite.
//
// Same rules as the Copilot half: a real server, real services, real PostgreSQL. The two
// substitutions here are the clock — through the `now` parameter runDailyNotifications
// already takes — and, in exactly two tests, `globalThis.fetch`, because Centrifugo is a
// separate process and these tests are about what happens on both sides of it.
//
// Read them as the product claims they are:
//
//   53  The morning summary arrives once per local day, and is pushed live.
//   54  The evening check counts what is actually left, not what was scheduled.
//   55  A finished day is not nudged.
//   56  Centrifugo being down loses nothing.
//   57  (email — not applicable this phase, see below)
//   58  The schedule lives in PostgreSQL and survives a restart.

import { describe, expect, it } from 'vitest';
import { timeInTimezone, todayIn } from '../domain/dates.js';
import { DAILY_NOTIFICATIONS_QUEUE, startJobs, stopJobs } from '../jobs/boss.js';
import { runDailyNotifications } from '../jobs/daily-notifications.js';
import { prisma } from '../lib/prisma.js';
import { dedupeKeyFor } from '../services/notifications.js';
import { channelFor, publishToUser } from '../services/realtime.js';
import { instantAt, quietLogger, useHarness, waitFor, type TestUser } from './harness.js';

const TZ = 'Asia/Tbilisi';

const h = useHarness();
const log = quietLogger();

/** The instant at which it is `time` on this user's wall clock, today. */
const at = (time: string) => instantAt(todayIn(TZ), time, TZ);

// ---------------------------------------------------------------- shared fixtures

async function dailyGoal(user: TestUser, title: string, taskTitles: string[]) {
  const { goal } = await h.ok<{ goal: { id: string } }>(user, 'POST', '/api/goals', {
    title,
    category: 'FITNESS',
    targetType: 'HABIT',
    timezone: TZ,
    tasks: taskTitles.map((taskTitle) => ({
      title: taskTitle,
      recurrenceType: 'EVERY_DAY',
      reward: 10,
    })),
  });
  return goal;
}

interface TodayResponse {
  groups: Array<{ goalId: string; tasks: Array<{ occurrenceId: string; title: string }> }>;
  summary: { required: number; completed: number };
}

/** Tick off `count` of today's tasks the way the Home screen does. */
async function completeToday(user: TestUser, count: number): Promise<string[]> {
  const today = await h.ok<TodayResponse>(user, 'GET', '/api/today');
  const occurrences = today.groups.flatMap((g) => g.tasks.map((t) => t.occurrenceId));
  const chosen = occurrences.slice(0, count);
  for (const id of chosen) {
    await h.ok(user, 'POST', `/api/task-occurrences/${id}/complete`);
  }
  return chosen;
}

// ---------------------------------------------------------------- Centrifugo doubles

const REALTIME_KEYS = [
  'CENTRIFUGO_URL',
  'CENTRIFUGO_API_KEY',
  'CENTRIFUGO_TOKEN_HMAC_SECRET',
  'CENTRIFUGO_WS_URL',
] as const;

/**
 * Point the API at a Centrifugo, and hand back the undo.
 *
 * Environment rather than an argument because that is how the application decides: every
 * publish resolves `realtimeConfig()` at call time, so a test can turn realtime on for
 * itself without the server being rebuilt. src/acceptance/env.ts empties these for every
 * other test, which is what makes the rest of the suite silent rather than merely lucky.
 */
function configureRealtime(apiUrl: string): () => void {
  const saved = REALTIME_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.CENTRIFUGO_URL = apiUrl;
  process.env.CENTRIFUGO_API_KEY = 'acceptance-api-key';
  process.env.CENTRIFUGO_TOKEN_HMAC_SECRET = 'acceptance-hmac-secret';
  process.env.CENTRIFUGO_WS_URL = 'ws://127.0.0.1:9/connection/websocket';
  return () => {
    for (const [key, value] of saved) process.env[key] = value ?? '';
  };
}

interface CapturedPublish {
  url: string;
  apiKey: string | null;
  channel: string;
  data: { event?: string; notification?: Record<string, any> };
}

/**
 * Stand in for the Centrifugo HTTP API and record what was sent to it.
 *
 * The one place a double is unavoidable: Part 53 is an assertion about a request leaving
 * this process, and the alternative — asserting against a live Centrifugo — would test
 * Centrifugo's subscription rules, which M23 already did against the real container.
 */
function captureCentrifugo(): { calls: CapturedPublish[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: CapturedPublish[] = [];

  globalThis.fetch = (async (input: any, init: any = {}) => {
    const headers = new Headers(init.headers ?? {});
    const body = JSON.parse(String(init.body ?? '{}'));
    calls.push({ url: String(input), apiKey: headers.get('X-API-Key'), ...body });
    return new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('Notification acceptance', () => {
  // ------------------------------------------------------------------- PART 53

  it('PART 53 — the morning summary arrives once, and is pushed live', async () => {
    const user = await h.createUser({ timezone: TZ });
    await dailyGoal(user, 'Get Fit', ['Morning walk', 'Stretch']);

    const restoreEnv = configureRealtime('http://127.0.0.1:9999');
    const centrifugo = captureCentrifugo();
    try {
      // 08:00 on this user's wall clock, whatever that is in UTC today.
      const first = await runDailyNotifications(log, at('08:00'));

      expect(first.due).toBe(1);
      expect(first.morningSent).toBe(1);
      expect(first.skippedEmpty).toBe(0);
      expect(first.skippedDuplicate).toBe(0);
      expect(first.failed).toBe(0);

      const rows = await prisma.notification.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.type).toBe('MORNING_SUMMARY');
      expect(row.title).toBe('2 tasks today');
      expect(row.body).toBe('2 in Get Fit');
      expect(row.localDate).toBe(todayIn(TZ));
      // The identity that makes a second send impossible, spelled out rather than
      // inferred: this is the whole once-a-day guarantee.
      expect(row.dedupeKey).toBe(dedupeKeyFor(user.id, 'MORNING_SUMMARY', todayIn(TZ)));
      expect(JSON.parse(row.data)).toMatchObject({ required: 2, completed: 0 });

      // ...and the same notification went out over realtime, on this user's own channel.
      expect(centrifugo.calls).toHaveLength(1);
      const [push] = centrifugo.calls;
      expect(push.url).toBe('http://127.0.0.1:9999/api/publish');
      expect(push.apiKey).toBe('acceptance-api-key');
      expect(push.channel).toBe(channelFor(user.id));
      expect(push.channel).toBe(`personal:#${user.id}`);
      expect(push.data.event).toBe('notification');
      expect(push.data.notification).toMatchObject({
        id: row.id,
        type: 'MORNING_SUMMARY',
        title: '2 tasks today',
        localDate: todayIn(TZ),
        readAt: null,
      });

      // A second tick inside the same four-hour window must add nothing at all. Ticks
      // run every five minutes, so this is the ordinary case, not an edge one.
      const second = await runDailyNotifications(log, at('10:30'));
      expect(second.due).toBe(1);
      expect(second.morningSent).toBe(0);
      expect(second.skippedDuplicate).toBe(1);
      expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
      expect(centrifugo.calls).toHaveLength(1);

      // And once the window has closed, a missed morning stays missed rather than
      // arriving at lunchtime.
      const late = await runDailyNotifications(log, at('12:30'));
      expect(late.due).toBe(0);
      expect(late.morningSent).toBe(0);
    } finally {
      centrifugo.restore();
      restoreEnv();
    }
  });

  // ------------------------------------------------------------------- PART 54

  it('PART 54 — the evening check counts what is actually left', async () => {
    const user = await h.createUser({ timezone: TZ });
    const goal = await dailyGoal(user, 'Get Fit', ['Walk', 'Stretch', 'Water', 'Journal']);
    await completeToday(user, 2);

    const result = await runDailyNotifications(log, at('20:30'));

    expect(result.due).toBe(1);
    expect(result.eveningSent).toBe(1);
    expect(result.skippedEmpty).toBe(0);
    expect(result.failed).toBe(0);
    // The morning window closed at 12:00, so nothing about it is due at 20:30.
    expect(result.morningSent).toBe(0);

    const rows = await prisma.notification.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.type)).toEqual(['EVENING_INCOMPLETE']);
    const [row] = rows;
    // Two of four done, so the nudge is about two — not four, and not "you failed".
    expect(row.title).toBe('2 tasks still open today');
    expect(row.body).toBe('Get Fit — 2 left');
    expect(row.dedupeKey).toBe(dedupeKeyFor(user.id, 'EVENING_INCOMPLETE', todayIn(TZ)));
    expect(JSON.parse(row.data)).toMatchObject({
      remaining: 2,
      required: 4,
      completed: 2,
      goalIds: [goal.id],
    });

    // Same once-a-day rule as the morning.
    const again = await runDailyNotifications(log, at('22:00'));
    expect(again.eveningSent).toBe(0);
    expect(again.skippedDuplicate).toBe(1);
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
  });

  // ------------------------------------------------------------------- PART 55

  it('PART 55 — a finished day is not nudged', async () => {
    const user = await h.createUser({ timezone: TZ });
    await dailyGoal(user, 'Get Fit', ['Walk', 'Stretch']);
    await completeToday(user, 2);

    const result = await runDailyNotifications(log, at('20:30'));

    // Due — the user asked to be checked on — but there was nothing to say.
    expect(result.due).toBe(1);
    expect(result.eveningSent).toBe(0);
    expect(result.skippedEmpty).toBe(1);
    expect(
      await prisma.notification.count({
        where: { userId: user.id, type: 'EVENING_INCOMPLETE' },
      }),
    ).toBe(0);

    // Finishing the day does produce a notification, and it is the one the completion
    // itself sends. Asserted so that "no evening nudge" cannot be read as "silence".
    const congratulations = await prisma.notification.findMany({
      where: { userId: user.id, type: 'PROGRESS' },
    });
    expect(congratulations).toHaveLength(1);
    expect(congratulations[0].title).toBe('Get Fit: today is done');
  });

  // ------------------------------------------------------------------- PART 56

  it('PART 56 — Centrifugo being down loses nothing', async () => {
    const user = await h.createUser({ timezone: TZ });
    await dailyGoal(user, 'Get Fit', ['Walk']);

    // Port 9 is the discard port and nothing listens on it, so this is a real failed
    // fetch through the real code path — not a thrown stub.
    const restoreEnv = configureRealtime('http://127.0.0.1:9');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const result = await runDailyNotifications(log, at('08:00'));

      // The push failed and the notification was still created. That ordering is the
      // entire design: PostgreSQL is the record, Centrifugo is the convenience.
      expect(result.morningSent).toBe(1);
      expect(result.failed).toBe(0);

      const rows = await prisma.notification.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('MORNING_SUMMARY');

      // The client's fallback path — what a browser does when its socket is dead —
      // returns the notification unchanged.
      const fetched = await h.ok<{
        notifications: Array<{ id: string; type: string; title: string }>;
        unread: number;
      }>(user, 'GET', '/api/notifications');
      expect(fetched.unread).toBe(1);
      expect(fetched.notifications).toHaveLength(1);
      expect(fetched.notifications[0]).toMatchObject({
        id: rows[0].id,
        type: 'MORNING_SUMMARY',
        title: '1 task today',
      });

      // And the failure is reported rather than swallowed. publishToUser answers false
      // instead of throwing, which is what kept the tick's `failed` count at zero.
      expect(await publishToUser(user.id, { event: 'ping' })).toBe(false);
      // Depends on this being the first realtime failure in the process: noteFailure
      // logs the first one and then at most one a minute. It is — every earlier test
      // either has realtime unconfigured (so nothing is attempted) or a stub that
      // succeeds — and the suite runs with fileParallelism disabled.
      expect(warnings.some((line) => line.startsWith('[realtime] push failed:'))).toBe(true);
    } finally {
      console.warn = originalWarn;
      restoreEnv();
    }
  });

  // ------------------------------------------------------------------- PART 57
  //
  // Email delivery. Deliberately not implemented and deliberately not faked: email was
  // taken out of this phase, so there is no EmailProvider to exercise and a test that
  // asserted one existed would be the only failing claim in the suite. Left visible as a
  // skip rather than deleted, so the gap is in the report rather than only in the plan.

  it.skip('PART 57 — email delivery (NOT APPLICABLE: email deferred out of this phase)', () => {});

  // ------------------------------------------------------------------- PART 58

  it('PART 58 — the schedule lives in PostgreSQL and survives a restart', async () => {
    // The one test that runs the real job runner. Everything else drives the tick
    // directly, because a test that waits on a fifteen-second poller to prove a
    // counting rule is a slow test about the wrong thing.
    process.env.JOBS_ENABLED = 'true';

    try {
      const first = await startJobs(log);
      expect(first).not.toBeNull();

      const declared = (await first!.getSchedules()).filter(
        (s: { name: string }) => s.name === DAILY_NOTIFICATIONS_QUEUE,
      );
      expect(declared).toHaveLength(1);
      expect(declared[0]).toMatchObject({ cron: '*/5 * * * *', timezone: 'UTC' });

      // The simulated restart. stopJobs closes the pool and forgets the instance, so
      // after this line nothing in this process knows a schedule was ever declared.
      await stopJobs();

      // Which is the point: it is a row, so it is still there. Read straight out of
      // pg-boss's own schema rather than through pg-boss, because "durable" is a claim
      // about the database and this is the only way to check it without the library.
      const persisted = await prisma.$queryRaw<Array<{ name: string; cron: string }>>`
        SELECT name, cron FROM pgboss.schedule WHERE name = ${DAILY_NOTIFICATIONS_QUEUE}
      `;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].cron).toBe('*/5 * * * *');

      const second = await startJobs(log);
      expect(second).not.toBeNull();
      // Re-declaring is an upsert, not an insert. A deploy loop must not leave five
      // cron entries behind, each firing its own tick.
      const afterRestart = (await second!.getSchedules()).filter(
        (s: { name: string }) => s.name === DAILY_NOTIFICATIONS_QUEUE,
      );
      expect(afterRestart).toHaveLength(1);
      expect(afterRestart[0]).toMatchObject({ cron: '*/5 * * * *', timezone: 'UTC' });

      // Finally, prove the queue is wired to something and not just registered. A user
      // whose evening time is the current local minute is inside the window right now,
      // so the worker — running on the real clock — has something to send.
      const user = await h.createUser({
        timezone: TZ,
        profile: {
          notifyMorningSummary: false,
          eveningTime: timeInTimezone(new Date(), TZ),
        },
      });
      await dailyGoal(user, 'Get Fit', ['Walk', 'Stretch']);

      await second!.send(DAILY_NOTIFICATIONS_QUEUE, {});

      const delivered = await waitFor(
        () =>
          prisma.notification.findFirst({
            where: { userId: user.id, type: 'EVENING_INCOMPLETE' },
          }),
        { timeoutMs: 45_000, intervalMs: 1_000, what: 'the worker to run a tick' },
      );
      expect(delivered.title).toBe('2 tasks still open today');
      expect(delivered.dedupeKey).toBe(
        dedupeKeyFor(user.id, 'EVENING_INCOMPLETE', todayIn(TZ)),
      );
    } finally {
      await stopJobs();
      process.env.JOBS_ENABLED = 'false';
    }
  });
});
