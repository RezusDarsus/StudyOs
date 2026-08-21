import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FriendState } from '../domain/enums.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { notify } from '../services/notifications.js';
import { ensureOccurrences, goalToday } from '../services/occurrences.js';

/** Friendships are stored one row per pair with userAId < userBId, which makes a
 *  duplicate friendship impossible at the database level. */
const pairKey = (a: string, b: string) => (a < b ? { userAId: a, userBId: b } : { userAId: b, userBId: a });

function stateFor(
  friendship: { status: string; requestedById: string; blockedById: string | null } | null,
  viewerId: string,
): FriendState {
  if (!friendship) return 'NONE';
  if (friendship.status === 'BLOCKED') return 'BLOCKED';
  if (friendship.status === 'ACCEPTED') return 'FRIENDS';
  return friendship.requestedById === viewerId ? 'REQUEST_SENT' : 'REQUEST_RECEIVED';
}

export default async function socialRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ friend list

  app.get('/friends', { preHandler: app.requireAuth }, async (req) => {
    const userId = req.user!.id;
    const friendships = await prisma.friendship.findMany({
      where: { status: 'ACCEPTED', OR: [{ userAId: userId }, { userBId: userId }] },
      include: {
        userA: { include: { profile: true } },
        userB: { include: { profile: true } },
      },
    });

    const friends = await Promise.all(
      friendships.map(async (f) => {
        const friend = f.userAId === userId ? f.userB : f.userA;

        // Goals we are both active participants of. Friendship alone grants no
        // access to a private goal — only shared participation shows up here.
        const shared = await prisma.goal.count({
          where: {
            AND: [
              { participants: { some: { userId: friend.id, status: 'ACTIVE' } } },
              { participants: { some: { userId, status: 'ACTIVE' } } },
            ],
          },
        });

        const streak = await prisma.goalParticipant.aggregate({
          where: { userId: friend.id, status: 'ACTIVE' },
          _max: { currentStreak: true },
        });

        return {
          id: friend.id,
          name: friend.name,
          avatarEmoji: friend.profile?.avatarEmoji ?? '🐱',
          level: friend.profile?.level ?? 1,
          totalCoins: friend.profile?.totalCoins ?? 0,
          currentStreak: streak._max.currentStreak ?? 0,
          sharedGoals: shared,
        };
      }),
    );

    friends.sort((a, b) => b.currentStreak - a.currentStreak || a.name.localeCompare(b.name));
    return { friends };
  });

  app.get('/friends/search', { preHandler: app.requireAuth }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(60) }).parse(req.query ?? {});
    const userId = req.user!.id;

    const users = await prisma.user.findMany({
      where: {
        id: { not: userId },
        OR: [{ name: { contains: q } }, { email: { equals: q.toLowerCase() } }],
      },
      include: { profile: true },
      take: 20,
    });

    const friendships = await prisma.friendship.findMany({
      where: {
        OR: [
          { userAId: userId, userBId: { in: users.map((u) => u.id) } },
          { userBId: userId, userAId: { in: users.map((u) => u.id) } },
        ],
      },
    });

    return {
      users: users.map((u) => {
        const f = friendships.find((x) => x.userAId === u.id || x.userBId === u.id) ?? null;
        return {
          id: u.id,
          name: u.name,
          avatarEmoji: u.profile?.avatarEmoji ?? '🐱',
          level: u.profile?.level ?? 1,
          state: stateFor(f, userId),
          friendshipId: f?.id ?? null,
        };
      }),
    };
  });

  // ------------------------------------------------------------ requests

  app.get('/friend-requests', { preHandler: app.requireAuth }, async (req) => {
    const userId = req.user!.id;
    const pending = await prisma.friendship.findMany({
      where: { status: 'PENDING', OR: [{ userAId: userId }, { userBId: userId }] },
      include: {
        userA: { include: { profile: true } },
        userB: { include: { profile: true } },
      },
    });

    const shape = (f: (typeof pending)[number]) => {
      const other = f.userAId === userId ? f.userB : f.userA;
      return {
        id: f.id,
        user: {
          id: other.id,
          name: other.name,
          avatarEmoji: other.profile?.avatarEmoji ?? '🐱',
          level: other.profile?.level ?? 1,
        },
        createdAt: f.createdAt,
      };
    };

    return {
      incoming: pending.filter((f) => f.requestedById !== userId).map(shape),
      outgoing: pending.filter((f) => f.requestedById === userId).map(shape),
    };
  });

  app.post('/friend-requests', { preHandler: app.requireAuth }, async (req) => {
    const { userId: targetId } = z.object({ userId: z.string() }).parse(req.body);
    const userId = req.user!.id;
    if (targetId === userId) throw badRequest('You cannot add yourself', 'SELF_REQUEST');

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    if (!target) throw notFound('That user does not exist');

    const key = pairKey(userId, targetId);
    const existing = await prisma.friendship.findUnique({
      where: { userAId_userBId: key },
    });

    if (existing) {
      if (existing.status === 'ACCEPTED') throw conflict('You are already friends', 'ALREADY_FRIENDS');
      if (existing.status === 'BLOCKED') throw forbidden('You cannot send a request to this user');
      if (existing.requestedById === userId) {
        throw conflict('You already sent a request', 'ALREADY_REQUESTED');
      }
      // They already asked us — accept instead of creating a mirror request.
      await prisma.friendship.update({ where: { id: existing.id }, data: { status: 'ACCEPTED' } });
      await notify({
        userId: targetId,
        type: 'FRIEND',
        title: `${req.user!.name} accepted your friend request`,
      });
      return { ok: true, state: 'FRIENDS' as FriendState };
    }

    await prisma.friendship.create({
      data: { ...key, status: 'PENDING', requestedById: userId },
    });
    await notify({
      userId: targetId,
      type: 'FRIEND',
      title: `${req.user!.name} sent you a friend request`,
    });
    return { ok: true, state: 'REQUEST_SENT' as FriendState };
  });

  app.post('/friend-requests/:id/accept', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.id;

    const friendship = await prisma.friendship.findUnique({ where: { id } });
    if (!friendship) throw notFound('Request not found');
    if (friendship.userAId !== userId && friendship.userBId !== userId) throw forbidden();
    if (friendship.status !== 'PENDING') throw badRequest('That request is no longer pending');
    // Only the recipient can accept.
    if (friendship.requestedById === userId) throw forbidden('You sent this request');

    await prisma.friendship.update({ where: { id }, data: { status: 'ACCEPTED' } });
    await notify({
      userId: friendship.requestedById,
      type: 'FRIEND',
      title: `${req.user!.name} accepted your friend request`,
    });
    return { ok: true };
  });

  app.post('/friend-requests/:id/decline', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.id;

    const friendship = await prisma.friendship.findUnique({ where: { id } });
    if (!friendship) throw notFound('Request not found');
    if (friendship.userAId !== userId && friendship.userBId !== userId) throw forbidden();
    if (friendship.status !== 'PENDING') throw badRequest('That request is no longer pending');

    // Declining removes the row entirely, so it grants no lingering access.
    await prisma.friendship.delete({ where: { id } });
    return { ok: true };
  });

  app.delete('/friends/:userId', { preHandler: app.requireAuth }, async (req) => {
    const { userId: targetId } = z.object({ userId: z.string() }).parse(req.params);
    const key = pairKey(req.user!.id, targetId);
    await prisma.friendship.deleteMany({ where: key });
    return { ok: true };
  });

  app.post('/friends/:userId/block', { preHandler: app.requireAuth }, async (req) => {
    const { userId: targetId } = z.object({ userId: z.string() }).parse(req.params);
    const userId = req.user!.id;
    const key = pairKey(userId, targetId);

    await prisma.friendship.upsert({
      where: { userAId_userBId: key },
      create: { ...key, status: 'BLOCKED', requestedById: userId, blockedById: userId },
      update: { status: 'BLOCKED', blockedById: userId },
    });
    return { ok: true };
  });

  // ------------------------------------------------------ goal invitations

  app.get('/goal-invitations', { preHandler: app.requireAuth }, async (req) => {
    const invitations = await prisma.goalInvitation.findMany({
      where: { inviteeId: req.user!.id, status: 'PENDING' },
      include: {
        goal: { include: { _count: { select: { participants: true } } } },
        inviter: { include: { profile: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      invitations: invitations.map((inv) => ({
        id: inv.id,
        goal: {
          id: inv.goal.id,
          title: inv.goal.title,
          description: inv.goal.description,
          category: inv.goal.category,
          visibility: inv.goal.visibility,
          participantCount: inv.goal._count.participants,
        },
        inviter: {
          id: inv.inviter.id,
          name: inv.inviter.name,
          avatarEmoji: inv.inviter.profile?.avatarEmoji ?? '🐱',
        },
        createdAt: inv.createdAt,
      })),
    };
  });

  app.post('/goal-invitations/:id/accept', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.id;

    const invitation = await prisma.goalInvitation.findUnique({
      where: { id },
      include: { goal: true },
    });
    if (!invitation) throw notFound('Invitation not found');
    if (invitation.inviteeId !== userId) throw forbidden('That invitation is not yours');
    if (invitation.status !== 'PENDING') throw badRequest('That invitation has already been answered');

    const today = goalToday(invitation.goal);
    const existing = await prisma.goalParticipant.findUnique({
      where: { goalId_userId: { goalId: invitation.goalId, userId } },
    });

    // The new participant gets their own occurrences; nobody else is touched.
    const participant = existing
      ? await prisma.goalParticipant.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', leftOn: null, joinedOn: today },
        })
      : await prisma.goalParticipant.create({
          data: { goalId: invitation.goalId, userId, role: 'MEMBER', joinedOn: today },
        });

    await prisma.goalInvitation.update({
      where: { id },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
    });
    await ensureOccurrences(invitation.goalId, [participant.id]);
    await notify({
      userId: invitation.inviterId,
      type: 'FRIEND',
      title: `${req.user!.name} joined ${invitation.goal.title}`,
      data: { goalId: invitation.goalId },
    });

    return { ok: true, goalId: invitation.goalId };
  });

  app.post('/goal-invitations/:id/decline', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const invitation = await prisma.goalInvitation.findUnique({ where: { id } });
    if (!invitation) throw notFound('Invitation not found');
    if (invitation.inviteeId !== req.user!.id) throw forbidden('That invitation is not yours');
    if (invitation.status !== 'PENDING') throw badRequest('That invitation has already been answered');

    // Declining leaves no participation behind, so it grants no access to the goal.
    await prisma.goalInvitation.update({
      where: { id },
      data: { status: 'DECLINED', respondedAt: new Date() },
    });
    return { ok: true };
  });
}
