import { z } from 'zod';

/**
 * Stage 5 — the Requirement AST and its state model (rev.6).
 *
 * Two layers, one store:
 *   ATOMS (RequirementRecord) are the only semantic state — property/scope/
 *   relation/value plus full metadata. Logical structure (AND/OR/NOT/
 *   Conditional) is a separate graph of GROUPS that reference atoms by id.
 *
 * Identity is four-layered (rev.6):
 *   L1 immutable record/group ids (cuid-ish, never derived);
 *   L2 semantic slot key (property@scope:relation-aware-slot, incl. binding
 *      and temporal components) — the supersession key;
 *   L3 optional semantic binding {property, value} — branch discriminant;
 *   L4 optional logical branch scope ('or:<groupId>') — OR-membership scope.
 *
 * PENDING_RESOLUTION / QUARANTINED / SUPERSEDED / REJECTED state never
 * influences authoritative projection, validation, or readiness.
 */

// ------------------------------------------------------------------ values

export const UNIT_TABLE = {
  minute: { dimension: 'time', toBase: 1 },
  hour: { dimension: 'time', toBase: 60 },
  day: { dimension: 'time', toBase: 1440 },
  week: { dimension: 'time', toBase: 10080 },
  km: { dimension: 'distance', toBase: 1 },
  mi: { dimension: 'distance', toBase: 1 },
  page: { dimension: 'pages', toBase: 1 },
  rep: { dimension: 'reps', toBase: 1 },
  session: { dimension: 'sessions', toBase: 1 },
  eur: { dimension: 'money', toBase: 1 },
  usd: { dimension: 'money', toBase: 1 },
  gbp: { dimension: 'money', toBase: 1 },
} as const;

export type UnitId = keyof typeof UNIT_TABLE | `unknown:${string}`;

export function canonicalUnit(raw: string): UnitId {
  const key = raw.trim().toLowerCase() as UnitId;
  if (key in UNIT_TABLE) return key;
  return `unknown:${raw.trim().toLowerCase()}`;
}

/** Normalize a quantity to its dimension's base unit when the unit is known;
 *  unknown units are preserved but flagged non-comparable. */
export function normalizeQuantity(value: number, unit: UnitId): { value: number; unit: UnitId; comparable: boolean } {
  const entry = UNIT_TABLE[unit as keyof typeof UNIT_TABLE];
  if (!entry) return { value, unit, comparable: false };
  return { value: value * entry.toBase, unit: entry.dimension as UnitId, comparable: true };
}

export type RequirementValue =
  | { kind: 'text'; value: string }
  | { kind: 'categorical'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'count'; value: number }
  | { kind: 'quantity'; value: number; unit: UnitId }
  | { kind: 'date'; value: string }
  | { kind: 'weekdaySet'; days: readonly number[] }
  | { kind: 'timeOfDay'; minutes: number }
  | { kind: 'set'; items: readonly RequirementValue[] }
  | { kind: 'unknown'; raw: string };

export type NormalizedValue = string; // canonical comparable representation ('' when not comparable)

/** Canonical comparable representation. Non-comparable values get a unique
 *  representation that still equals itself (used for exact matching only). */
export function normalizedValueRepr(v: RequirementValue): NormalizedValue {
  switch (v.kind) {
    case 'text':
    case 'categorical':
      return `t:${v.value.trim().toLowerCase()}`;
    case 'boolean':
      return `b:${v.value}`;
    case 'count':
      return `n:${v.value}`;
    case 'quantity': {
      const norm = normalizeQuantity(v.value, v.unit);
      return `q:${norm.unit}:${norm.value}`;
    }
    case 'date':
      return `d:${v.value}`;
    case 'weekdaySet':
      return `w:${[...v.days].sort((a, b) => a - b).join(',')}`;
    case 'timeOfDay':
      return `tod:${v.minutes}`;
    case 'set':
      return `s:[${v.items.map(normalizedValueRepr).sort().join(',')}]`;
    case 'unknown':
      return `u:${v.raw.trim().toLowerCase()}`;
  }
}

/** Cross-kind equality: quantities compare after base-unit normalization
 *  (2 hours ≡ 120 minutes); non-comparable quantities fall back to their own
 *  representation (equal to itself, never to a different unknown unit); all
 *  other kinds compare within-kind only. */
export function valuesEqual(a: RequirementValue, b: RequirementValue): boolean {
  if (a.kind === 'quantity' && b.kind === 'quantity') {
    const na = normalizeQuantity(a.value, a.unit);
    const nb = normalizeQuantity(b.value, b.unit);
    if (na.comparable && nb.comparable) return na.unit === nb.unit && na.value === nb.value;
    return normalizedValueRepr(a) === normalizedValueRepr(b);
  }
  return a.kind === b.kind && normalizedValueRepr(a) === normalizedValueRepr(b);
}

// ------------------------------------------------------------------ temporal

export type TemporalScope =
  | { readonly kind: 'always' }
  | { readonly kind: 'dateRange'; readonly from?: string; readonly until?: string }
  | { readonly kind: 'phase'; readonly label: string }
  | { readonly kind: 'weekdayRecurring'; readonly days: readonly number[] };

/** Deterministic normalized temporal key (rev.6 fix 1). */
export function temporalKey(t: TemporalScope): string {
  switch (t.kind) {
    case 'always':
      return 'always';
    case 'dateRange':
      return `date:${t.from ?? ''}..${t.until ?? ''}`;
    case 'phase':
      return `phase:${normalizePhaseLabel(t.label)}`;
    case 'weekdayRecurring':
      return `days:${[...t.days].sort((a, b) => a - b).join(',')}`;
  }
}

/** Casefold, collapse whitespace, strip punctuation, number-words → digits. */
export function normalizePhaseLabel(label: string): string {
  const wordNumbers: Record<string, string> = {
    one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
    eight: '8', nine: '9', ten: '10',
  };
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => wordNumbers[w] ?? w)
    .filter(Boolean)
    .join(' ')
    .trim();
}

// ------------------------------------------------------------------ identity

export type RequirementScope = 'goal' | 'schedule' | 'session';
export type RequirementRelation = 'eq' | 'ne' | 'in' | 'contains' | 'excludes' | 'gte' | 'lte';
export type RequirementStrength = 'REQUIRED' | 'PREFERRED' | 'OPTIONAL' | 'EXCLUDED';
export type RequirementProvenance =
  | 'USER_EXPLICIT'
  | 'USER_INFERRED'
  | 'SYSTEM_ASSUMPTION'
  | 'MODEL_INFERRED'
  | 'STORED_CONTEXT';
export type RequirementStatus = 'ACTIVE' | 'SUPERSEDED' | 'REJECTED' | 'PENDING_RESOLUTION';
export type GroupStatus = 'ACTIVE' | 'QUARANTINED' | 'PENDING_RESOLUTION' | 'SUPERSEDED';
export type GroupKind = 'and' | 'or' | 'not' | 'conditional';
export type QuarantineReason = 'CYCLE' | 'ARITY' | 'DANGLING_REF' | 'INVALID_GUARD';

export interface PropertyRef {
  readonly key: string;   // open namespaced key: /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/
  readonly scope: RequirementScope;
}

export interface Binding {
  readonly property: string;
  readonly value: RequirementValue;
}

export function isValidPropertyKey(key: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/.test(key);
}

/** Relation-aware slot (rev.6 fix 2). Value-scoped slots (ne/contains/excludes)
 *  coexist; eq/in are single-valued replacement slots; min/max coexist. */
export function slotFor(relation: RequirementRelation, value: RequirementValue): string {
  switch (relation) {
    case 'eq': return 'eq';
    case 'in': return 'in';
    case 'gte': return 'min';
    case 'lte': return 'max';
    case 'ne': return `ne:${normalizedValueRepr(value)}`;
    case 'contains': return `contains:${normalizedValueRepr(value)}`;
    case 'excludes': return `excludes:${normalizedValueRepr(value)}`;
  }
}

/** L2 semantic slot key: binding + property@scope:slot + temporal. */
export function slotKeyOf(parts: {
  property: string;
  scope: RequirementScope;
  relation: RequirementRelation;
  value: RequirementValue;
  binding?: Binding;
  temporal: TemporalScope;
}): string {
  const slot = slotFor(parts.relation, parts.value);
  const bindingPart = parts.binding
    ? `⟨${parts.binding.property}=${normalizedValueRepr(parts.binding.value)}⟩::`
    : '';
  return `${bindingPart}${parts.property}@${parts.scope}:${slot}|${temporalKey(parts.temporal)}`;
}

/** L4 effective supersession key: branch scope (when assigned) + slot key. */
export function effectiveKeyOf(record: {
  property: string;
  scope: RequirementScope;
  relation: RequirementRelation;
  value: RequirementValue;
  binding?: Binding;
  temporal: TemporalScope;
  branchScope?: string;
}): string {
  const slotKey = slotKeyOf(record);
  return record.branchScope ? `${record.branchScope}::${slotKey}` : slotKey;
}

// ------------------------------------------------------------------ evidence

/** Where a record's grounding points. Only the CURRENT user turn can ground. */
export interface Evidence {
  /** The user's own words the extraction cites (verbatim span). */
  quote: string;
  /** The interview turn that produced the statement (0 = opening message). */
  turn: number;
  /** Which current-turn surface grounded it. */
  source: 'message' | 'answer';
  at: string;
}

// ------------------------------------------------------------------ records

/** One atomic requirement — the only carrier of semantic state (rev.6). */
export interface RequirementRecord {
  /** L1 immutable id — never derived from content, never reused. */
  readonly id: string;
  property: string;
  scope: RequirementScope;
  relation: RequirementRelation;
  value: RequirementValue;
  strength: RequirementStrength;
  status: RequirementStatus;
  provenance: RequirementProvenance;
  temporal: TemporalScope;
  /** L3 optional branch discriminant. */
  binding?: Binding;
  /** L4 'or:<groupKey>#<index>' when the atom lives inside an OR group. */
  branchScope?: string;
  /** Branch index inside its OR group — conflict scoping only, not identity. */
  altIndex?: number;
  evidence: Evidence | null;
  /** Set when SUPERSEDED: the id of the record that replaced it. */
  supersededById?: string;
  confidence?: number;
  /** The interview turn that last asserted this record. */
  turn: number;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ groups

export interface GroupChildRef {
  readonly kind: 'atom' | 'group';
  readonly id: string;
}

/** A conditional's IF part: the binding that activates the THEN children. */
export interface ConditionalGuard {
  readonly property: string;
  readonly value: RequirementValue;
}

export interface RequirementGroup {
  /** L1 immutable id. */
  readonly id: string;
  /**
   * Deterministic semantic identity shared by restatements of the same
   * alternative set ("30 or 60" this turn, "45 or 60" the next). Derived from
   * the members' property@scope:slot + temporal — never from the group id.
   */
  readonly groupKey: string;
  kind: GroupKind;
  children: GroupChildRef[];
  status: GroupStatus;
  quarantineReason?: QuarantineReason;
  guard?: ConditionalGuard;
  turn: number;
  createdAt: string;
}

// ------------------------------------------------------------------ state

/**
 * Safety-relevant user context the extractor deliberately did NOT model as a
 * requirement (e.g. health conditions, restrictions). Strictly visibility
 * data for the compatibility/safety/advisory validators: never requirement
 * authority, never coverage, conflict, supersession or contract input, never
 * capability authorization.
 */
export interface UnmodeledEvidence {
  /** The user's own grounded words (verbatim span of the current turn). */
  quote: string;
  /** The interview turn that produced it. */
  turn: number;
  source: Evidence['source'];
  at: string;
}

export interface RequirementStateMeta {
  /** Whether the CURRENT turn's extraction was successfully ingested. A
   * 'failed' value makes the whole state stale for generation (R1). */
  lastTurnExtraction: 'ok' | 'failed';
}

/** The full AST payload stored inside structuredContext v3. */
export interface RequirementState {
  records: RequirementRecord[];
  groups: RequirementGroup[];
  unmodeledEvidence?: UnmodeledEvidence[];
  meta?: RequirementStateMeta;
}

export function emptyRequirementState(): RequirementState {
  return { records: [], groups: [], unmodeledEvidence: [], meta: { lastTurnExtraction: 'ok' } };
}

/** Deterministic immutable-ish id: prefix + randomness. Never content-derived. */
export function newRequirementId(prefix: string): string {
  const rnd =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${rnd}`;
}

/** Non-ACTIVE state never influences authoritative generation. */
export function isAuthoritativeRecord(record: RequirementRecord): boolean {
  return record.status === 'ACTIVE';
}

export function isAuthoritativeGroup(group: RequirementGroup): boolean {
  return group.status === 'ACTIVE';
}

/** Provenance authority: lower wins, like context.ts ranks. */
const PROVENANCE_RANK: Record<RequirementProvenance, number> = {
  USER_EXPLICIT: 0,
  USER_INFERRED: 1,
  STORED_CONTEXT: 2,
  SYSTEM_ASSUMPTION: 3,
  MODEL_INFERRED: 4,
};

export function provenanceRank(provenance: RequirementProvenance): number {
  return PROVENANCE_RANK[provenance];
}

/** Relations whose value asserts the presence of the thing (vs scoping it). */
export function assertsPresence(relation: RequirementRelation): boolean {
  return relation === 'eq' || relation === 'in' || relation === 'contains';
}
