import {
  assertsPresence,
  isAuthoritativeRecord,
  valuesEqual,
  type ConditionalGuard,
  type RequirementGroup,
  type RequirementRecord,
  type RequirementState,
} from './types.js';

// Authoritative projection (rev.6): ACTIVE AST evidence only.
//
// A record participates in projection when it is ACTIVE and either stands
// alone or is referenced by at least one ACTIVE group. Records reachable only
// through QUARANTINED / PENDING_RESOLUTION / SUPERSEDED groups are inert —
// they never reach validation, readiness, or a draft check.

export interface ProjectedAtom {
  record: RequirementRecord;
  /** Child of an ACTIVE NOT group — negation semantics, never flattened. */
  negated: boolean;
  /** OR group scope when the atom is an alternative branch. */
  branchScope?: string;
  /** Branch index within that OR group. */
  altIndex?: number;
}

export interface ProjectionView {
  atoms: ProjectedAtom[];
  activeGroups: RequirementGroup[];
  pendingGroups: RequirementGroup[];
  quarantinedGroups: RequirementGroup[];
}

function childrenOf(state: RequirementState): Map<string, RequirementGroup[]> {
  const parents = new Map<string, RequirementGroup[]>();
  for (const group of state.groups) {
    for (const child of group.children) {
      if (child.kind !== 'atom') continue;
      const list = parents.get(child.id) ?? [];
      list.push(group);
      parents.set(child.id, list);
    }
  }
  return parents;
}

function guardSatisfied(guard: ConditionalGuard, authoritative: RequirementRecord[]): boolean {
  // The guard binding is satisfied when an authoritative presence assertion
  // for the same property carries the guard's value.
  return authoritative.some(
    (record) =>
      record.property === guard.property &&
      assertsPresence(record.relation) &&
      valuesEqual(record.value, guard.value),
  );
}

export function projectState(state: RequirementState): ProjectionView {
  const parents = childrenOf(state);
  const activeGroups = state.groups.filter((g) => g.status === 'ACTIVE');
  const pendingGroups = state.groups.filter((g) => g.status === 'PENDING_RESOLUTION');
  const quarantinedGroups = state.groups.filter((g) => g.status === 'QUARANTINED');

  const activeRecords = state.records.filter(isAuthoritativeRecord);
  const atoms: ProjectedAtom[] = [];

  // Pass 1: records whose conditionals can be evaluated — standalone records
  // and records of non-conditional active groups.
  const unconditional: ProjectedAtom[] = [];
  const conditionalCandidates: Array<{ atom: ProjectedAtom; guards: ConditionalGuard[] }> = [];

  for (const record of activeRecords) {
    const parentsOfRecord = (parents.get(record.id) ?? []).filter((g) => g.status === 'ACTIVE');
    if (parentsOfRecord.length === 0) {
      unconditional.push({
        record,
        negated: false,
        branchScope: record.branchScope,
        altIndex: record.altIndex,
      });
      continue;
    }
    const notParents = parentsOfRecord.filter((g) => g.kind === 'not');
    const conditionalParents = parentsOfRecord.filter((g) => g.kind === 'conditional');
    const plainParents = parentsOfRecord.filter((g) => g.kind === 'and' || g.kind === 'or');

    const atom: ProjectedAtom = {
      record,
      negated: notParents.length > 0,
      branchScope: record.branchScope,
      altIndex: record.altIndex,
    };
    if (plainParents.length > 0 || (notParents.length > 0 && conditionalParents.length === 0)) {
      unconditional.push(atom);
    }
    if (conditionalParents.length > 0) {
      conditionalCandidates.push({
        atom,
        guards: conditionalParents.map((g) => g.guard).filter((g): g is ConditionalGuard => !!g),
      });
    }
  }

  const authoritativeForGuards = unconditional.map((a) => a.record);
  for (const candidate of conditionalCandidates) {
    if (candidate.guards.some((guard) => guardSatisfied(guard, authoritativeForGuards))) {
      unconditional.push(candidate.atom);
    }
  }

  // Deterministic order: ingestion order of the records.
  const order = new Map(activeRecords.map((r, i) => [r.id, i]));
  atoms.push(...unconditional.sort((a, b) => (order.get(a.record.id) ?? 0) - (order.get(b.record.id) ?? 0)));

  return { atoms, activeGroups, pendingGroups, quarantinedGroups };
}

/**
 * Effective exclusions implied by the projection: explicit `excludes` atoms,
 * plus negated presence assertions (NOT(A) remains NOT(A) in the AST, and
 * projects as the exclusion of A), minus negated exclusions (NOT(excludes X)
 * restores X).
 */
export interface EffectiveExclusion {
  property: string;
  scope: RequirementRecord['scope'];
  value: RequirementRecord['value'];
  sourceRecordId: string;
  negated: boolean;
}

export function effectiveExclusions(view: ProjectionView): EffectiveExclusion[] {
  const out: EffectiveExclusion[] = [];
  for (const atom of view.atoms) {
    const { record } = atom;
    if (record.relation === 'excludes') {
      out.push({
        property: record.property,
        scope: record.scope,
        value: record.value,
        sourceRecordId: record.id,
        negated: atom.negated, // negated exclusion = presence of the value
      });
    } else if (assertsPresence(record.relation) && atom.negated) {
      out.push({
        property: record.property,
        scope: record.scope,
        value: record.value,
        sourceRecordId: record.id,
        negated: false,
      });
    }
  }
  return out;
}
