import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import authRoutes from './auth.js';

const captured = vi.hoisted(() => ({ data: null as Record<string, unknown> | null }));
vi.mock('../lib/prisma.js', () => ({ prisma: { user: {
  findUnique: async (args: { where: { email?: string } }) => args.where.email ? null : {
    id: 'u1', name: 'Test User', email: 'new@example.com', registrationIp: '203.0.113.40', profile: null,
  },
  create: async ({ data }: { data: Record<string, unknown> }) => { captured.data = data; return { id: 'u1' }; },
} } }));
vi.mock('../lib/auth.js', () => ({
  SESSION_COOKIE: 'session', hashPassword: async () => 'hash', createSession: async () => 'token',
}));

describe('registration IP recording', () => {
  it('records the connection IP, ignores spoofed headers/body, and keeps it out of the response', async () => {
    const app = Fastify({ trustProxy: false });
    app.decorate('requireAuth', async () => {});
    await app.register(cookie);
    await app.register(authRoutes);
    try {
      const response = await app.inject({ method: 'POST', url: '/auth/register',
        remoteAddress: '::ffff:203.0.113.40', headers: { 'x-forwarded-for': '198.51.100.1' },
        payload: { name: 'Test User', email: 'new@example.com', password: 'password123',
          confirmPassword: 'password123', registrationIp: '198.51.100.2', isAdmin: true },
      });
      expect(response.statusCode).toBe(200);
      expect(captured.data?.registrationIp).toBe('203.0.113.40');
      expect(captured.data).not.toHaveProperty('isAdmin');
      expect(response.json().user).not.toHaveProperty('registrationIp');
    } finally { await app.close(); }
  });
});
