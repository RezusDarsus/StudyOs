import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import miscRoutes from './misc.js';
import { isAdminEmail } from '../lib/admin.js';
import { unauthorized } from '../lib/errors.js';

const db = vi.hoisted(() => ({
  groupBy: vi.fn(async () => [{ registrationIp: '203.0.113.1', _count: { _all: 4 } }]),
  count: vi.fn(async (args?: unknown) => args ? 2 : 6),
}));
vi.mock('../lib/prisma.js', () => ({ prisma: {
  user: db, $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
} }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

async function requestAs(email: string | null) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => { req.user = email ? { id: 'u1', name: 'Test', email } : null; });
  app.decorate('requireAuth', async (req) => { if (!req.user) throw unauthorized(); });
  await app.register(miscRoutes);
  try { return await app.inject({ url: '/admin/registration-ips' }); }
  finally { await app.close(); }
}

describe('registration IP administration', () => {
  it('defaults to no administrators', () => {
    vi.stubEnv('ADMIN_EMAILS', '');
    expect(isAdminEmail('someone@example.com')).toBe(false);
  });
  it('denies signed-out and ordinary users before reading IP data', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    expect((await requestAs(null)).statusCode).toBe(401);
    expect((await requestAs('member@example.com')).statusCode).toBe(403);
    expect(db.groupBy).not.toHaveBeenCalled();
  });
  it('returns counts and unrecorded accounts only to configured administrators', async () => {
    vi.stubEnv('ADMIN_EMAILS', ' Admin@Example.com ');
    const response = await requestAs('admin@example.com');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ totalAccounts: 6, unknownAccounts: 2,
      groups: [{ ip: '203.0.113.1', accounts: 4 }], hasMore: false });
  });
});
