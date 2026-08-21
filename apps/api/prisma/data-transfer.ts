// Shared vocabulary for the SQLite → PostgreSQL data move: which tables, in which
// order, and how a JSON round-trip is undone.
//
// Both halves import this so the export and the import cannot disagree about the
// table list — the failure mode being guarded against is a table that is exported
// and never imported, which looks exactly like success.

import { Prisma } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Written next to the schema, and gitignored — it contains real user rows. */
export const EXPORT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'data-export.json');

export interface DataExport {
  exportedAt: string;
  source: string;
  tables: Record<string, unknown[]>;
}

/**
 * Every table, parents before children.
 *
 * Written out by hand rather than taken from the schema's declaration order,
 * because "the order they happen to be declared in" is not a promise that foreign
 * keys resolve — it is only true today. Inserting a TaskOccurrence before its
 * TaskDefinition fails on Postgres, where foreign keys are enforced by default.
 *
 * assertCoversSchema() below checks this list against the schema itself, so adding a
 * model and forgetting to place it here fails loudly instead of quietly leaving its
 * rows behind.
 */
export const EXPORT_ORDER = [
  'User',
  'Profile',
  'PasswordResetToken',
  'Session',
  'Goal',
  'GoalParticipant',
  'TaskDefinition',
  'TaskOccurrence',
  'TaskFeedback',
  'ProgressionPlan',
  'ProgressionStage',
  'ProgressionDecision',
  'Friendship',
  'GoalInvitation',
  'Notification',
  'Achievement',
  'UserAchievement',
  'RewardTransaction',
  'CopilotSession',
  'CopilotMessage',
  'GoalDraft',
  'GoalDraftTask',
  'UserPreference',
  'AiCallLog',
  'CopilotEvent',
] as const;

export type ExportModel = (typeof EXPORT_ORDER)[number];

/**
 * Which columns of a model hold timestamps, read from the schema at runtime.
 *
 * Deriving this beats a hand-kept list: JSON has no date type, so every DateTime
 * comes back as a string and has to be turned back before Prisma will accept it.
 * A missed field would be a runtime type error on import, and a hand-kept list is
 * exactly the kind of thing that goes stale the first time someone adds a column.
 */
const DATE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    model.fields.filter((field) => field.type === 'DateTime').map((field) => field.name),
  ]),
);

export function dateFieldsOf(model: string): readonly string[] {
  return DATE_FIELDS.get(model) ?? [];
}

/**
 * Undo the JSON round-trip for one row.
 *
 * Only the declared DateTime columns are touched. A blanket "does this look like a
 * date?" sweep would eventually catch a string that merely resembles one — day keys
 * are 'YYYY-MM-DD' strings all over this schema — and silently change its type.
 */
export function reviveRow(model: string, row: Record<string, unknown>): Record<string, unknown> {
  const revived: Record<string, unknown> = { ...row };
  for (const field of dateFieldsOf(model)) {
    const value = revived[field];
    if (typeof value === 'string') revived[field] = new Date(value);
  }
  return revived;
}

/** The Prisma delegate for a model name, e.g. 'TaskOccurrence' -> client.taskOccurrence. */
export function delegateFor(
  client: unknown,
  model: string,
): { findMany(): Promise<unknown[]>; createMany?(args: unknown): Promise<{ count: number }>; count(): Promise<number>; create(args: unknown): Promise<unknown> } {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  const delegate = (client as Record<string, never>)[key];
  if (!delegate) throw new Error(`No Prisma delegate for model "${model}" (looked for .${key})`);
  return delegate as never;
}

/** Fail loudly if the schema has grown a model this transfer would skip. */
export function assertCoversSchema(): void {
  const listed = new Set<string>(EXPORT_ORDER);
  const inSchema = Prisma.dmmf.datamodel.models.map((model) => model.name);
  const missing = inSchema.filter((name) => !listed.has(name));
  const stale = [...listed].filter((name) => !inSchema.includes(name));
  if (missing.length) {
    throw new Error(
      `EXPORT_ORDER is missing ${missing.join(', ')}. Add each one after its parent tables, ` +
        'or its rows will be silently left behind.',
    );
  }
  if (stale.length) {
    throw new Error(`EXPORT_ORDER lists models that no longer exist: ${stale.join(', ')}`);
  }
}

export interface OrphanGroup {
  model: string;
  field: string;
  parent: string;
  /** Rows whose foreign key points at a parent that is not in the export. */
  rows: Array<Record<string, unknown>>;
  missingParentIds: unknown[];
}

/**
 * Rows whose foreign keys point at something that is not there.
 *
 * SQLite let this happen; PostgreSQL will not. The real export contained ten
 * CopilotMessages belonging to two CopilotSessions that had been deleted out from
 * under them, and the first the import knew of it was "Foreign key constraint
 * violated" partway through — a true message that names one constraint and tells you
 * nothing about the scale of the problem.
 *
 * Finding them all up front turns that into a decision the operator makes with the
 * whole picture in front of them.
 */
export function findOrphans(tables: Record<string, unknown[]>): OrphanGroup[] {
  const idsByModel = new Map<string, Set<unknown>>(
    EXPORT_ORDER.map((model) => [
      model,
      new Set(((tables[model] ?? []) as Array<Record<string, unknown>>).map((row) => row.id)),
    ]),
  );

  const groups: OrphanGroup[] = [];
  for (const model of Prisma.dmmf.datamodel.models) {
    const rows = (tables[model.name] ?? []) as Array<Record<string, unknown>>;
    if (!rows.length) continue;
    for (const field of model.fields) {
      // Only the side that actually holds the foreign key column, and only when it
      // references a primary key we have indexed by id.
      if (field.kind !== 'object' || field.relationFromFields?.length !== 1) continue;
      const [from] = field.relationFromFields;
      const [to] = field.relationToFields ?? ['id'];
      if (to !== 'id') continue;
      const parents = idsByModel.get(field.type);
      if (!parents) continue;

      // A null foreign key is an optional relation, not an orphan.
      const orphans = rows.filter((row) => row[from] != null && !parents.has(row[from]));
      if (orphans.length) {
        groups.push({
          model: model.name,
          field: from,
          parent: field.type,
          rows: orphans,
          missingParentIds: [...new Set(orphans.map((row) => row[from]))],
        });
      }
    }
  }
  return groups;
}

export function describeOrphans(groups: OrphanGroup[]): string {
  return groups
    .map((group) => {
      const shown = group.missingParentIds.slice(0, 5).join(', ');
      const rest = group.missingParentIds.length - 5;
      return (
        `  ${group.model}.${group.field} -> ${group.parent}: ${group.rows.length} row(s) ` +
        `pointing at ${group.missingParentIds.length} missing ${group.parent}(s): ` +
        `${shown}${rest > 0 ? ` (+${rest} more)` : ''}`
      );
    })
    .join('\n');
}
