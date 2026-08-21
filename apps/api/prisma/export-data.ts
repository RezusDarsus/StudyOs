// Half one of the SQLite → PostgreSQL move: read everything out of the old database
// and write it to a single JSON file.
//
// Two halves rather than one script because a Prisma client can only speak to the
// provider its schema names. Export runs while `datasource db` still says sqlite;
// import runs after it says postgresql. The JSON file is the handoff between them,
// and it is also the reason this is safe to attempt more than once: nothing is
// written to the old database and nothing is deleted from it, so a failed import can
// be retried against the same export.
//
//   npm run db:export --workspace=apps/api    (on sqlite)
//   ...switch the provider, create the schema...
//   npm run db:import --workspace=apps/api    (on postgres)

import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  EXPORT_FILE,
  EXPORT_ORDER,
  assertCoversSchema,
  delegateFor,
  type DataExport,
} from './data-transfer.js';

const prisma = new PrismaClient();

async function main() {
  assertCoversSchema();

  const url = process.env.DATABASE_URL ?? '(unset)';
  if (!url.startsWith('file:')) {
    throw new Error(
      `Export expects the SQLite database, but DATABASE_URL is "${url}". ` +
        'Run this BEFORE switching the Prisma provider.',
    );
  }

  const tables: Record<string, unknown[]> = {};
  let total = 0;

  for (const model of EXPORT_ORDER) {
    const rows = await delegateFor(prisma, model).findMany();
    tables[model] = rows;
    total += rows.length;
    console.log(`  ${String(rows.length).padStart(6)}  ${model}`);
  }

  const payload: DataExport = {
    exportedAt: new Date().toISOString(),
    source: url,
    tables,
  };

  // Dates serialise to ISO strings here and are revived on import — see
  // data-transfer.ts, which owns the list of fields that have to be turned back.
  writeFileSync(EXPORT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n${total} row(s) across ${EXPORT_ORDER.length} tables -> ${EXPORT_FILE}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
