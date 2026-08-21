// Half two of the SQLite → PostgreSQL move: load the exported JSON into Postgres.
//
// Runs after `datasource db` says postgresql and the schema has been created. Reads
// only from the JSON file, so it never needs to talk to the old database.
//
//   npm run db:import --workspace=apps/api
//
// Refuses to touch a database that already has rows unless --reset is passed. The
// point of this script is to carry existing data forward; quietly writing on top of
// somebody else's data would defeat it.

import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  EXPORT_FILE,
  EXPORT_ORDER,
  assertCoversSchema,
  delegateFor,
  describeOrphans,
  findOrphans,
  reviveRow,
  type DataExport,
} from './data-transfer.js';

const prisma = new PrismaClient();

/** Postgres has a parameter ceiling per statement; batching keeps wide tables under it. */
const BATCH_SIZE = 500;

async function main() {
  assertCoversSchema();

  const url = process.env.DATABASE_URL ?? '(unset)';
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      `Import expects PostgreSQL, but DATABASE_URL is "${url}". ` +
        'Switch the provider and point DATABASE_URL at Postgres first.',
    );
  }
  if (!existsSync(EXPORT_FILE)) {
    throw new Error(`No export found at ${EXPORT_FILE}. Run db:export on SQLite first.`);
  }

  const payload = JSON.parse(readFileSync(EXPORT_FILE, 'utf8')) as DataExport;
  console.log(`Export taken ${payload.exportedAt} from ${payload.source}\n`);

  // SQLite tolerated rows whose parent had been deleted; Postgres will not, and it
  // would report only the first constraint it hit. Decide about all of them up front.
  const orphans = findOrphans(payload.tables);
  const dropOrphans = process.argv.includes('--drop-orphans');
  if (orphans.length) {
    const count = orphans.reduce((sum, group) => sum + group.rows.length, 0);
    console.log(`${count} orphaned row(s) in the export:\n${describeOrphans(orphans)}\n`);
    if (!dropOrphans) {
      throw new Error(
        'These rows reference parents that no longer exist, so PostgreSQL will reject them.\n' +
          'They are unreachable — every read path starts from the parent — but dropping data is\n' +
          'your call, not this script\'s. Re-run with --drop-orphans to leave them behind.',
      );
    }
    console.log('--drop-orphans given: they will be left behind.\n');
  }
  const drop = new Map<string, Set<Record<string, unknown>>>();
  for (const group of orphans) {
    const set = drop.get(group.model) ?? new Set<Record<string, unknown>>();
    for (const row of group.rows) set.add(row);
    drop.set(group.model, set);
  }

  // Anything already here has to be dealt with deliberately. Children are cleared
  // before parents, which is EXPORT_ORDER backwards.
  const reset = process.argv.includes('--reset');
  const existing: Array<{ model: string; count: number }> = [];
  for (const model of EXPORT_ORDER) {
    const count = await delegateFor(prisma, model).count();
    if (count > 0) existing.push({ model, count });
  }
  if (existing.length && !reset) {
    throw new Error(
      'Target database is not empty: ' +
        existing.map(({ model, count }) => `${model}=${count}`).join(', ') +
        '\nRe-run with --reset to replace its contents, or point at an empty database.',
    );
  }

  await prisma.$transaction(
    async (tx) => {
      if (reset && existing.length) {
        console.log('Clearing existing rows (children first)...');
        for (const model of [...EXPORT_ORDER].reverse()) {
          await (
            delegateFor(tx, model) as unknown as { deleteMany(): Promise<{ count: number }> }
          ).deleteMany();
        }
      }

      let total = 0;
      let dropped = 0;
      for (const model of EXPORT_ORDER) {
        const all = (payload.tables[model] ?? []) as Array<Record<string, unknown>>;
        const doomed = drop.get(model);
        const rows = doomed ? all.filter((row) => !doomed.has(row)) : all;
        dropped += all.length - rows.length;
        if (!rows.length) {
          console.log(`  ${'0'.padStart(6)}  ${model}`);
          continue;
        }
        const revived = rows.map((row) => reviveRow(model, row));
        const delegate = delegateFor(tx, model) as unknown as {
          createMany(args: { data: unknown[] }): Promise<{ count: number }>;
        };
        // No skipDuplicates: a duplicate here means the export and the target
        // disagree about what already exists, and that is worth stopping for.
        for (let i = 0; i < revived.length; i += BATCH_SIZE) {
          await delegate.createMany({ data: revived.slice(i, i + BATCH_SIZE) });
        }
        total += revived.length;
        const note = all.length !== rows.length ? `  (${all.length - rows.length} orphan skipped)` : '';
        console.log(`  ${String(revived.length).padStart(6)}  ${model}${note}`);
      }
      console.log(`\n${total} row(s) written${dropped ? `, ${dropped} orphan(s) left behind` : ''}.`);
    },
    // One transaction for the whole import: a half-loaded database would be worse
    // than a failed one, because its foreign keys would look intact.
    { timeout: 180_000, maxWait: 10_000 },
  );

  // Read the counts back from Postgres rather than trusting what we just wrote.
  console.log('\nVerifying...');
  const mismatches: string[] = [];
  for (const model of EXPORT_ORDER) {
    const expected = (payload.tables[model] ?? []).length - (drop.get(model)?.size ?? 0);
    const actual = await delegateFor(prisma, model).count();
    if (expected !== actual) mismatches.push(`${model}: expected ${expected}, found ${actual}`);
  }
  if (mismatches.length) {
    throw new Error(`Row counts do not match:\n  ${mismatches.join('\n  ')}`);
  }
  console.log(`All ${EXPORT_ORDER.length} tables match the export.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
