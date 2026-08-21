// Which database the acceptance suite is allowed to touch.
//
// One rule, and everything here exists to enforce it: never the development database.
// These tests truncate every table between cases, so pointing them at the database that
// holds the seeded accounts would delete them — and the whole point of Part 29.1 was that
// this project does not silently destroy useful data.
//
// The URL is derived from DATABASE_URL by swapping the database name for one ending in
// `_acceptance`: same server, same credentials, different database. That keeps the
// arrangement to a secret that already exists rather than a second one to configure and
// forget. The suffix is also the tripwire — harness.ts refuses to run against a database
// whose name does not end in it, so a misconfigured URL fails loudly instead of quietly
// truncating something real.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** apps/api, resolved from this file rather than from cwd, which Vitest does not pin. */
export const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ACCEPTANCE_SUFFIX = '_acceptance';

/**
 * Read one key out of apps/api/.env.
 *
 * A fallback, not the main path: normally DATABASE_URL is already in the environment by
 * the time anything here runs, because importing @prisma/client loads that file. This
 * covers the global setup, which may run before that import.
 */
function fromEnvFile(key: string): string | undefined {
  const path = join(apiRoot, '.env');
  if (!existsSync(path)) return undefined;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;

    const raw = match[2].trim();
    const quote = raw[0];
    if (quote === '"' || quote === "'") {
      const end = raw.indexOf(quote, 1);
      return end === -1 ? raw.slice(1) : raw.slice(1, end);
    }
    // Unquoted: a trailing `# comment` is not part of the value.
    return raw.split(' #')[0].trim();
  }
  return undefined;
}

export function baseDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim() || fromEnvFile('DATABASE_URL')?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The acceptance suite needs a PostgreSQL server to derive its own database from — copy apps/api/.env.example to apps/api/.env, or bring the stack up with `docker compose up -d`.',
    );
  }
  return url;
}

/**
 * The same server, the same credentials, and a database name ending in `_acceptance`.
 *
 * Idempotent: a URL that already names the acceptance database comes back unchanged, so a
 * worker that inherited the redirected value from its parent derives the same thing.
 */
export function acceptanceDatabaseUrl(): string {
  const url = new URL(baseDatabaseUrl());
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) {
    throw new Error(`DATABASE_URL names no database, so there is nothing to derive from: ${url.host}`);
  }
  const target = name.endsWith(ACCEPTANCE_SUFFIX) ? name : `${name}${ACCEPTANCE_SUFFIX}`;
  url.pathname = `/${encodeURIComponent(target)}`;
  return url.toString();
}

export function acceptanceDatabaseName(): string {
  return decodeURIComponent(new URL(acceptanceDatabaseUrl()).pathname.replace(/^\//, ''));
}

/**
 * A connection to the server's own `postgres` database, which is the only way to issue
 * CREATE DATABASE — you cannot create a database from inside it.
 */
export function maintenanceDatabaseUrl(): string {
  const url = new URL(acceptanceDatabaseUrl());
  url.pathname = '/postgres';
  url.search = '';
  return url.toString();
}
