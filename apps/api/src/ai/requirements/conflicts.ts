import {
  assertsPresence,
  normalizeQuantity,
  temporalKey,
  valuesEqual,
  type RequirementRecord,
} from './types.js';
import { effectiveExclusions, projectState, type ProjectionView } from './projection.js';

// The conflict engine (rev.6): deterministic, relation-aware, OR-aware.
//
// A conflict between two atoms is REAL unless both are alternatives of the
// SAME OR group on DIFFERENT branches — alternatives never conflict with each
// other ("30 minutes or 60 minutes" is one choice, not a contradiction).

export type ConflictKind = 'REQUIRED_VS_EXCLUDED' | 'RANGE_INVERTED';

export interface RequirementConflict {
  kind: ConflictKind;
  property: string;
  scope: string;
  temporal: string;
  /** For REQUIRED_VS_EXCLUDED: the contested value. */
  value?: string;
  /** For RANGE_INVERTED. */
  min?: string;
  max?: string;
  recordA: string;
  recordB: string;
  description: string;
}

/** Numeric value of a comparable atom value, or null (incomparable). */
function comparableNumber(record: RequirementRecord): number | null {
  if (record.value.kind === 'quantity') {
    const norm = normalizeQuantity(record.value.value, record.value.unit);
    return norm.comparable ? norm.value : null;
  }
  if (record.value.kind === 'count') return record.value.value;
  return null;
}

function inSameGroupDifferentBranch(a: RequirementRecord, b: RequirementRecord): boolean {
  return (
    a.branchScope !== undefined &&
    b.branchScope !== undefined &&
    a.branchScope === b.branchScope &&
    a.altIndex !== b.altIndex
  );
}

export function detectConflicts(state: ProjectionView): RequirementConflict[] {
  const atoms = state.atoms;
  const conflicts: RequirementConflict[] = [];

  const isExclusion = (record: RequirementRecord, negated: boolean): boolean => {
    if (negated) return false; // negated exclusion = presence (handled below)
    return record.relation === 'excludes';
  };
  const isPresence = (record: RequirementRecord, negated: boolean): boolean =>
    !negated ? assertsPresence(record.relation) : record.relation === 'excludes';

  // Presence vs exclusion (incl. NOT(A) projecting as the exclusion of A).
  for (const a of atoms) {
    for (const b of atoms) {
      if (a.record.id >= b.record.id) continue;
      if (a.record.property !== b.record.property || a.record.scope !== b.record.scope) continue;
      if (temporalKey(a.record.temporal) !== temporalKey(b.record.temporal)) continue;
      const aPresence = isPresence(a.record, a.negated);
      const bPresence = isPresence(b.record, b.negated);
      if (aPresence === bPresence) continue;
      const presence = aPresence ? a : b;
      const exclusion = aPresence ? b : a;
      if (inSameGroupDifferentBranch(presence.record, exclusion.record)) continue;
      if (!valuesEqual(presence.record.value, exclusion.record.value)) continue;
      conflicts.push({
        kind: 'REQUIRED_VS_EXCLUDED',
        property: presence.record.property,
        scope: presence.record.scope,
        temporal: temporalKey(presence.record.temporal),
        value: presence.record.value.kind === 'text' ? presence.record.value.value : String(presence.record.value.kind),
        recordA: presence.record.id,
        recordB: exclusion.record.id,
        description: `"${presence.record.property}" is required as "${presence.record.value.kind === 'text' ? presence.record.value.value : presence.record.value.kind}" and excluded at the same time`,
      });
    }
  }

  // Range inversion: min > max within one family.
  for (const a of atoms) {
    if (a.negated || a.record.relation !== 'gte') continue;
    for (const b of atoms) {
      if (b.negated || b.record.relation !== 'lte') continue;
      if (a.record.property !== b.record.property || a.record.scope !== b.record.scope) continue;
      if (temporalKey(a.record.temporal) !== temporalKey(b.record.temporal)) continue;
      if (inSameGroupDifferentBranch(a.record, b.record)) continue;
      const min = comparableNumber(a.record);
      const max = comparableNumber(b.record);
      if (min === null || max === null) continue;
      if (min <= max) continue;
      conflicts.push({
        kind: 'RANGE_INVERTED',
        property: a.record.property,
        scope: a.record.scope,
        temporal: temporalKey(a.record.temporal),
        min: String(comparableNumber(a.record)),
        max: String(comparableNumber(b.record)),
        recordA: a.record.id,
        recordB: b.record.id,
        description: `"${a.record.property}" cannot be at least ${min} and at most ${max} at once`,
      });
    }
  }

  conflicts.sort(
    (x, y) =>
      x.property.localeCompare(y.property) ||
      x.kind.localeCompare(y.kind) ||
      x.recordA.localeCompare(y.recordA),
  );
  return conflicts;
}

/** Convenience: project + detect in one call. */
export function detectStateConflicts(state: Parameters<typeof projectState>[0]): RequirementConflict[] {
  const view = projectState(state);
  // Negated exclusions (NOT(excludes X)) act as presence; effectiveExclusions
  // is used by the draft validator, the pair scan above already covers NOT().
  void effectiveExclusions(view);
  return detectConflicts(view);
}
