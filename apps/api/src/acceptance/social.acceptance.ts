import { describe, expect, it } from 'vitest';
import { useHarness } from './harness.js';

const h = useHarness();

describe('friend search', () => {
  it('finds a newly registered user by a case-insensitive partial name', async () => {
    const viewer = await h.createUser({ name: 'Searching Friend' });

    const registration = await h.call<{ user: { id: string; name: string } }>(
      null,
      'POST',
      '/api/auth/register',
      {
        name: 'Jane Doe',
        email: 'jane.doe@goalify.test',
        password: 'goalify123',
        confirmPassword: 'goalify123',
      },
    );
    expect(registration.status).toBe(200);

    const result = await h.ok<{
      users: Array<{ id: string; name: string; state: string }>;
    }>(viewer, 'GET', '/api/friends/search?q=jane');

    expect(result.users).toEqual([
      expect.objectContaining({
        id: registration.body.user.id,
        name: 'Jane Doe',
        state: 'NONE',
      }),
    ]);
  });

  it('finds an account by email regardless of letter case', async () => {
    const viewer = await h.createUser();
    const target = await h.createUser({ name: 'Email Friend' });

    const result = await h.ok<{ users: Array<{ id: string }> }>(
      viewer,
      'GET',
      `/api/friends/search?q=${encodeURIComponent(target.email.toUpperCase())}`,
    );

    expect(result.users.map((user) => user.id)).toContain(target.id);
  });
});
