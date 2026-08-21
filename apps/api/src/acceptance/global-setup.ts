// Bring the acceptance database into existence, once per run.
//
// Two steps, and both are the boring version on purpose:
//
//   1. CREATE DATABASE if it is not already there. Never DROP. The database is ours by
//      construction — the name is derived, not supplied — but "the tests clean up after
//      themselves by deleting a database" is one typo away from deleting the wrong one,
//      and the per-test truncate in harness.ts already gives every test a clean slate.
//   2. `prisma migrate deploy`, which is the same command the migrate container runs in
//      production. Not `migrate dev`: that one wants a terminal, and it is allowed to
//      reset a database it finds inconsistent, which is precisely the behaviour a test
//      harness must not have.
//
// Runs in Vitest's main process, before any worker starts.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  acceptanceDatabaseName,
  acceptanceDatabaseUrl,
  apiRoot,
  maintenanceDatabaseUrl,
} from './database.js';

/**
 * The Prisma CLI's entry point, found by walking up from apps/api.
 *
 * npm hoists `prisma` to the workspace root, so the path is not local to this package —
 * and `import.meta.resolve` is not something to depend on inside Vitest's module runner.
 */
function prismaCli(): string {
  let dir = apiRoot;
  for (;;) {
    const candidate = join(dir, 'node_modules', 'prisma', 'build', 'index.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('Could not find the Prisma CLI. Run `npm install` from the repository root.');
    }
    dir = parent;
  }
}

async function createIfMissing(name: string): Promise<boolean> {
  const admin = new PrismaClient({ datasourceUrl: maintenanceDatabaseUrl() });
  try {
    const existing = await admin.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM pg_database WHERE datname = ${name}
    `;
    if (existing.length > 0) return false;
    // CREATE DATABASE takes no parameters, so the name is interpolated — it comes from
    // DATABASE_URL rather than from anything a caller supplies, and the doubled quote
    // keeps an identifier containing one from ending the literal early.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await admin.$disconnect();
  }
}

export default async function setup(): Promise<void> {
  const name = acceptanceDatabaseName();
  const url = acceptanceDatabaseUrl();

  let created: boolean;
  try {
    created = await createIfMissing(name);
  } catch (error) {
    throw new Error(
      `Could not reach PostgreSQL to prepare the acceptance database "${name}". Is the stack up? \`docker compose up -d\`.\n${(error as Error).message}`,
    );
  }

  try {
    execFileSync(process.execPath, [prismaCli(), 'migrate', 'deploy'], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    const output = [err.stdout?.toString(), err.stderr?.toString()].filter(Boolean).join('\n');
    throw new Error(`prisma migrate deploy failed against "${name}":\n${output}`);
  }

  // eslint-disable-next-line no-console -- the one line worth printing: which database ran.
  console.log(`[acceptance] ${created ? 'created' : 'reusing'} database "${name}", migrations applied`);
}
