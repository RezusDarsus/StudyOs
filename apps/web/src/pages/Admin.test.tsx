import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Admin from './Admin';

const auth = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { isAdmin: auth.isAdmin } }) }));

beforeEach(() => {
  auth.isAdmin = true;
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      totalAccounts: 6,
      unknownAccounts: 2,
      hasMore: false,
      groups: [{ ip: '203.0.113.1', accounts: 4 }],
    }),
  })));
});

afterEach(() => vi.unstubAllGlobals());

function show() {
  render(
    <MemoryRouter initialEntries={['/app/admin']}>
      <Routes>
        <Route path="/app/admin" element={<Admin />} />
        <Route path="/app" element={<p>Home opened</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('admin page', () => {
  it('loads registration data for an administrator', async () => {
    show();
    expect(screen.getByRole('heading', { name: 'Admin' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Registrations by IP' })).toBeVisible();
    expect(await screen.findByText('203.0.113.1')).toBeVisible();
    expect(fetch).toHaveBeenCalledWith('/api/admin/registration-ips?page=1', expect.any(Object));
  });

  it('redirects an ordinary user without requesting admin data', async () => {
    auth.isAdmin = false;
    show();
    expect(await screen.findByText('Home opened')).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
});
