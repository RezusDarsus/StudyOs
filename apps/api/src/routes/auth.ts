import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isValidTimezone, todayIn } from '../domain/dates.js';
import {
  SESSION_COOKIE,
  consumePasswordResetToken,
  createPasswordResetToken,
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
} from '../lib/auth.js';
import { badRequest, conflict, tooManyRequests, unauthorized } from '../lib/errors.js';
import { AttemptWindow, describeWait } from '../lib/rate-limit.js';
import { prisma } from '../lib/prisma.js';
import { levelProgress } from '../services/engagement.js';

// Throttles. Each limit is chosen so that no real person meets it: a user who mistypes a
// password four times is not stopped, and one who mistypes it twenty times across every
// account they know is not the case being optimised for.
//
// Two keys for login rather than one. IP+email is the tight limit and stops guessing at a
// particular account; IP alone is the loose one and stops the same attacker walking a
// password list across many accounts, which the first limit on its own would allow.
//
// Neither is keyed on the email address by itself, which would let anyone lock a stranger
// out of their own account from anywhere. See lib/rate-limit.ts.
const LOGIN_WINDOW_SECONDS = 15 * 60;
const loginPerAccount = new AttemptWindow(5, LOGIN_WINDOW_SECONDS);
const loginPerAddress = new AttemptWindow(20, LOGIN_WINDOW_SECONDS);

// Signups and reset requests count every attempt, not only the failures: here the abuse is
// success — a thousand junk accounts, or a thousand reset tokens for one address. An hour,
// because both are things a person does once and a script does continuously.
const signupsPerAddress = new AttemptWindow(10, 60 * 60);
const resetRequestsPerAddress = new AttemptWindow(10, 60 * 60);
const resetAttemptsPerAddress = new AttemptWindow(10, 60 * 60);

/**
 * Refuse if any of these windows is full, and say for how long.
 *
 * `Retry-After` is set on the reply before the throw, which survives into the error
 * handler — a client that wants to back off correctly can, without parsing prose.
 *
 * `req.ip` is only the real client when the deployment says so: behind a proxy with
 * TRUST_PROXY unset, every request appears to come from the proxy and the per-address
 * limits become one shared limit. That fails towards refusing traffic rather than allowing
 * it, so it is safe, but see lib/config-audit.ts for getting it right.
 */
function throttle(
  reply: { header: (name: string, value: string) => unknown },
  what: string,
  ...windows: Array<[AttemptWindow, string]>
): void {
  let longest = 0;
  for (const [window, key] of windows) longest = Math.max(longest, window.blockedFor(key));
  if (longest === 0) return;
  reply.header('Retry-After', String(longest));
  throw tooManyRequests(`Too many ${what}. Please try again in ${describeWait(longest)}.`);
}

const passwordRule = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200)
  .regex(/[a-zA-Z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Please enter your name').max(60),
    email: z.string().trim().toLowerCase().email('Please enter a valid email'),
    password: passwordRule,
    confirmPassword: z.string(),
    timezone: z.string().optional(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email'),
  password: z.string().min(1, 'Please enter your password'),
});

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 60 * 60,
} as const;

/**
 * Shape a user for the client.
 *
 * `viewerId` must equal `userId` to receive private fields. Email address,
 * timezone and notification preferences belong to the account owner alone and
 * are never handed to another user looking at a profile.
 */
export async function publicUser(userId: string, viewerId?: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });
  if (!user) return null;

  const coins = user.profile?.totalCoins ?? 0;
  const isSelf = viewerId === undefined || viewerId === userId;

  const base = {
    id: user.id,
    name: user.name,
    avatarEmoji: user.profile?.avatarEmoji ?? '🐱',
    bio: user.profile?.bio ?? '',
    totalCoins: coins,
    bestStreak: user.profile?.bestStreak ?? 0,
    ...levelProgress(coins),
  };

  if (!isSelf) return base;

  return {
    ...base,
    email: user.email,
    timezone: user.profile?.timezone ?? 'UTC',
    notifications: {
      taskReminders: user.profile?.notifyTaskReminders ?? true,
      friendActivity: user.profile?.notifyFriendActivity ?? true,
      leaderboardUpdates: user.profile?.notifyLeaderboardUpdate ?? true,
      achievements: user.profile?.notifyAchievements ?? true,
      morningSummary: user.profile?.notifyMorningSummary ?? true,
      eveningCheck: user.profile?.notifyEveningCheck ?? true,
      // Their own wall-clock times, in their own timezone above.
      morningTime: user.profile?.morningTime ?? '08:00',
      eveningTime: user.profile?.eveningTime ?? '20:30',
    },
  };
}

export default async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', async (req, reply) => {
    throttle(reply, 'sign-up attempts from this address', [signupsPerAddress, req.ip]);
    const body = registerSchema.parse(req.body);
    const timezone = body.timezone && isValidTimezone(body.timezone) ? body.timezone : 'UTC';

    // Counted before the account is created, so that a script cannot get ten accounts and
    // then a rejection — the eleventh attempt is refused whether or not the tenth worked.
    signupsPerAddress.record(req.ip);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw conflict('An account with that email already exists', 'EMAIL_TAKEN');

    const user = await prisma.user.create({
      data: {
        email: body.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        profile: { create: { timezone } },
      },
    });

    const token = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTIONS);
    return { user: await publicUser(user.id), today: todayIn(timezone) };
  });

  app.post('/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const accountKey = `${req.ip}|${body.email}`;
    throttle(
      reply,
      'sign-in attempts',
      [loginPerAccount, accountKey],
      [loginPerAddress, req.ip],
    );

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    // Same message either way, so the endpoint cannot be used to enumerate accounts.
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      // Only failures are counted, so someone signing in correctly a hundred times in an
      // afternoon — a phone reconnecting, a tab reopened — is never throttled.
      loginPerAccount.record(accountKey);
      loginPerAddress.record(req.ip);
      throw unauthorized('Email or password is incorrect');
    }

    // One success clears the account's counter. A user who fumbled four times and then got
    // it right starts from zero, rather than being one mistake from a fifteen-minute wait.
    loginPerAccount.forget(accountKey);

    const token = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTIONS);
    return { user: await publicUser(user.id) };
  });

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    if (!req.user) return { user: null };
    return { user: await publicUser(req.user.id) };
  });

  app.get('/account/export', { preHandler: app.requireAuth }, async (req) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        profile: true,
        ownedGoals: {
          include: {
            tasks: true,
            participants: true,
            invitations: true,
          },
        },
        achievements: true,
        preferences: true,
        notifications: true,
        rewards: true,
      },
    });
    return { exportedAt: new Date().toISOString(), user };
  });

  app.delete('/account', { preHandler: app.requireAuth }, async (req, reply) => {
    const userId = req.user!.id;
    await prisma.$transaction(async (tx) => {
      // Friendship rows point to a user more than once and are intentionally
      // removed explicitly so account deletion works regardless of relation order.
      await tx.friendship.deleteMany({
        where: { OR: [{ requestedById: userId }, { userAId: userId }, { userBId: userId }] },
      });
      await tx.user.delete({ where: { id: userId } });
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /**
   * Password reset, Phase 1 scope: no email provider is wired up, so in
   * development the token is returned to the caller instead of being mailed.
   * The token is single-use, expires in an hour and is NOT a session — holding
   * it does not sign you in. Adding a mailer later changes only delivery.
   */
  app.post('/auth/forgot-password', async (req, reply) => {
    throttle(reply, 'password reset requests from this address', [
      resetRequestsPerAddress,
      req.ip,
    ]);
    resetRequestsPerAddress.record(req.ip);

    const { email } = z
      .object({ email: z.string().trim().toLowerCase().email() })
      .parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    // Always the same response, so this cannot confirm whether an account exists.
    if (!user) return { ok: true };

    const token = await createPasswordResetToken(user.id);
    return process.env.NODE_ENV === 'production' ? { ok: true } : { ok: true, devToken: token };
  });

  app.post('/auth/reset-password', async (req, reply) => {
    throttle(reply, 'reset attempts from this address', [resetAttemptsPerAddress, req.ip]);

    const { token, password } = z
      .object({ token: z.string().min(1), password: passwordRule })
      .parse(req.body);

    const userId = await consumePasswordResetToken(token);
    if (!userId) {
      // A reset token is 32 random bytes, so this is not a limit that stops a realistic
      // attack — it stops the endpoint being a free oracle to hammer, and it costs a real
      // user, who follows a link once, nothing.
      resetAttemptsPerAddress.record(req.ip);
      throw badRequest('That reset link is invalid or has expired', 'BAD_TOKEN');
    }

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(password) },
    });
    // Every existing session is invalidated on a password change.
    await prisma.session.deleteMany({ where: { userId } });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
