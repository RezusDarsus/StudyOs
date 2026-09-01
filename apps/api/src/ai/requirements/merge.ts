import {
  assertsPresence,
  effectiveKeyOf,
  newRequirementId,
  normalizeQuantity,
  normalizedValueRepr,
  provenanceRank,
  slotKeyOf,
  temporalKey,
  valuesEqual,
  type Binding,
  type GroupChildRef,
  type GroupKind,
  type GroupStatus,
  type QuarantineReason,
  type RequirementGroup,
  type RequirementRecord,
  type RequirementState,
  type RequirementValue,
} from './types.js';
import {
  buildRecord,
  type GroundingContext,
  type NormalizedCandidate,
  type NormalizedFragment,
} from './extract-schema.js';

// Deterministic merge + supersession (rev.6).
//
// Everything is decided by semantic keys, never by ids: two records with
// different immutable ids but the same effective key cannot both be ACTIVE.
// PENDING_RESOLUTION / QUARANTINED / SUPERSEDED / REJECTED state is inert —
// it never matches, never blocks, never projects.

export interface MergeEvent {
  kind:
    | 'superseded'
    | 'refreshed'
    | 'activated'
    | 'reactivated'
    | 'rejected'
    | 'voided'
    | 'quarantined'
    | 'pending';
  recordId?: string;
  groupId?: string;
  effectiveKey?: string;
  reason?: string;
}

export interface MergeResult {
  state: RequirementState;
  events: MergeEvent[];
}

// ----------------------------------------------------- stored-graph validation

/**
 * Validate the stored group graph BEFORE any new merge. Dangling children and
 * cycles quarantine a group immediately — a dangling ref is found before arity
 * ever looks at the group.
 */
export function validateStoredGroups(state: RequirementState): MergeResult {
  const records = cloneRecords(state.records);
  const groups = state.groups.map((g) => ({ ...g, children: [...g.children] }));
  const events: MergeEvent[] = [];
  const recordIds = new Set(records.map((r) => r.id));
  const groupIds = new Set(groups.map((g) => g.id));

  for (const group of groups) {
    if (group.status !== 'ACTIVE') continue;
    const dangling = group.children.some(
      (child) =>
        (child.kind === 'atom' && !recordIds.has(child.id)) ||
        (child.kind === 'group' && !groupIds.has(child.id)),
    );
    if (dangling) {
      group.status = 'QUARANTINED';
      group.quarantineReason = 'DANGLING_REF';
      events.push({ kind: 'quarantined', groupId: group.id, reason: 'DANGLING_REF' });
    }
  }

  const edges = new Map<string, string[]>();
  for (const group of groups) {
    if (group.status !== 'ACTIVE') continue;
    edges.set(
      group.id,
      group.children.filter((c) => c.kind === 'group').map((c) => c.id),
    );
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    let found = false;
    for (const next of edges.get(id) ?? []) {
      if (visit(next)) {
        cyclic.add(id);
        found = true;
      }
    }
    visiting.delete(id);
    done.add(id);
    return found;
  };
  for (const id of edges.keys()) if (visit(id)) cyclic.add(id);
  for (const group of groups) {
    if (group.status === 'ACTIVE' && cyclic.has(group.id)) {
      group.status = 'QUARANTINED';
      group.quarantineReason = 'CYCLE';
      events.push({ kind: 'quarantined', groupId: group.id, reason: 'CYCLE' });
    }
  }

  return { state: { records, groups }, events };
}

// ------------------------------------------------------------------ clone util

function cloneRecords(records: RequirementRecord[]): RequirementRecord[] {
  return records.map((r) => ({ ...r }));
}

function cloneState(state: RequirementState): RequirementState {
  return {
    records: cloneRecords(state.records),
    groups: state.groups.map((g) => ({ ...g, children: [...g.children] })),
  };
}

// -------------------------------------------------------------- key computation

interface KeyParts {
  property: string;
  scope: RequirementRecord['scope'];
  relation: RequirementRecord['relation'];
  value: RequirementValue;
  binding?: Binding;
  temporal: RequirementRecord['temporal'];
}

function slotKeyOfParts(parts: KeyParts): string {
  return slotKeyOf({
    property: parts.property,
    scope: parts.scope,
    relation: parts.relation,
    value: parts.value,
    binding: parts.binding,
    temporal: parts.temporal,
  });
}

export function effectiveKeyOfRecord(r: RequirementRecord): string {
  return effectiveKeyOf({
    property: r.property,
    scope: r.scope,
    relation: r.relation,
    value: r.value,
    binding: r.binding,
    temporal: r.temporal,
    branchScope: r.branchScope,
  });
}

/** Deterministic OR-group identity: shared property@scope + temporal + binding. */
export function orGroupKeyOf(
  property: string,
  scope: string,
  temporal: RequirementRecord['temporal'],
  binding?: Binding,
): string {
  const bindingPart = binding
    ? `⟨${binding.property}=${normalizedValueRepr(binding.value)}⟩::`
    : '';
  return `or|${bindingPart}${property}@${scope}|${temporalKey(temporal)}`;
}

function notGroupKeyOf(parts: KeyParts): string {
  return `not|${slotKeyOfParts(parts)}`;
}

function conditionalGroupKeyOf(guard: { property: string; value: RequirementValue }): string {
  return `cond|${guard.property}=${normalizedValueRepr(guard.value)}`;
}

function andGroupKeyOf(memberKeys: string[]): string {
  return `and|${[...memberKeys].sort().join('&&')}`;
}

// ------------------------------------------------------------------ merge core

type Placement =
  | { kind: 'standalone' }
  | { kind: 'and' }
  | { kind: 'or'; branchScope: string; altIndex: number }
  | { kind: 'not' }
  | { kind: 'conditional' }
  | { kind: 'quarantined' };

interface BuiltAtom {
  record: RequirementRecord;
  placement: Placement;
  /** Model claims this atom voids the contradicting assertion for its family. */
  resolves: boolean;
  carrierId: string | null;
}

interface MergeCtx {
  records: RequirementRecord[];
  events: MergeEvent[];
  turn: number;
  at: string;
}

function effectiveKeyOfAtom(atom: BuiltAtom): string {
  return effectiveKeyOf({
    property: atom.record.property,
    scope: atom.record.scope,
    relation: atom.record.relation,
    value: atom.record.value,
    binding: atom.record.binding,
    temporal: atom.record.temporal,
    branchScope: atom.placement.kind === 'or' ? atom.placement.branchScope : undefined,
  });
}

/**
 * Merge one built atom by semantic key.
 * Returns the id of the record that now carries the semantics (ACTIVE), or
 * null when the atom was rejected (weaker provenance than what holds).
 */
function mergeAtom(ctx: MergeCtx, atom: BuiltAtom): string | null {
  const record = atom.record;
  const key = effectiveKeyOfAtom(atom);

  const existing = ctx.records.find(
    (r) => r.status === 'ACTIVE' && effectiveKeyOfRecord(r) === key,
  );

  if (existing) {
    const sameSemantics =
      valuesEqual(existing.value, record.value) && existing.strength === record.strength;
    if (sameSemantics) {
      // Re-affirmation: the later statement refreshes evidence and authority.
      existing.updatedAt = ctx.at;
      existing.turn = record.turn;
      if (record.evidence) existing.evidence = record.evidence;
      if (provenanceRank(record.provenance) < provenanceRank(existing.provenance)) {
        existing.provenance = record.provenance;
      }
      ctx.events.push({ kind: 'refreshed', recordId: existing.id, effectiveKey: key });
      return existing.id;
    }
    // Different value/strength on the same effective key: the later statement
    // replaces the earlier one — but never with weaker authority.
    if (provenanceRank(record.provenance) > provenanceRank(existing.provenance)) {
      ctx.events.push({
        kind: 'rejected',
        recordId: record.id,
        effectiveKey: key,
        reason: 'WEAKER_PROVENANCE',
      });
      return null;
    }
    existing.status = 'SUPERSEDED';
    existing.supersededById = record.id;
    existing.updatedAt = ctx.at;
    record.altIndex = atom.placement.kind === 'or' ? atom.placement.altIndex : existing.altIndex;
    ctx.records.push(record);
    ctx.events.push({ kind: 'superseded', recordId: existing.id, effectiveKey: key });
    ctx.events.push({ kind: 'activated', recordId: record.id, effectiveKey: key });
    return record.id;
  }

  // Superseded-value resurrection: the exact semantic key was superseded and
  // nothing ACTIVE claims it now. The user re-asserting the value re-activates
  // the historical record — same immutable id.
  const dormant = ctx.records.find(
    (r) =>
      r.status === 'SUPERSEDED' &&
      effectiveKeyOfRecord(r) === key &&
      !ctx.records.some(
        (other) => other.status === 'ACTIVE' && effectiveKeyOfRecord(other) === key,
      ),
  );
  if (dormant && provenanceRank(record.provenance) <= provenanceRank(dormant.provenance)) {
    dormant.status = 'ACTIVE';
    delete dormant.supersededById;
    dormant.updatedAt = ctx.at;
    dormant.turn = record.turn;
    if (record.evidence) dormant.evidence = record.evidence;
    if (provenanceRank(record.provenance) < provenanceRank(dormant.provenance)) {
      dormant.provenance = record.provenance;
    }
    ctx.events.push({ kind: 'reactivated', recordId: dormant.id, effectiveKey: key });
    return dormant.id;
  }

  // Unsafe assumption policy: a SYSTEM_ASSUMPTION that would contradict an
  // authoritative USER_EXPLICIT / USER_INFERRED record is REJECTED — it is
  // never stored as ACTIVE and never rendered.
  if (record.provenance === 'SYSTEM_ASSUMPTION' && contradictsUserAuthority(ctx, atom)) {
    ctx.events.push({
      kind: 'rejected',
      recordId: record.id,
      effectiveKey: key,
      reason: 'UNSAFE_ASSUMPTION',
    });
    return null;
  }

  // Fresh assertion.
  ctx.records.push(record);
  ctx.events.push({ kind: 'activated', recordId: record.id, effectiveKey: key });
  return record.id;
}

function contradictsUserAuthority(ctx: MergeCtx, atom: BuiltAtom): boolean {
  const record = atom.record;
  for (const other of ctx.records) {
    if (other.status !== 'ACTIVE') continue;
    if (provenanceRank(other.provenance) > 1) continue; // user authority only
    if (other.property !== record.property || other.scope !== record.scope) continue;
    if (temporalKey(other.temporal) !== temporalKey(record.temporal)) continue;
    const presenceVsExclusion =
      (assertsPresence(other.relation) && record.relation === 'excludes' && valuesEqual(other.value, record.value)) ||
      (assertsPresence(record.relation) && other.relation === 'excludes' && valuesEqual(other.value, record.value));
    if (presenceVsExclusion) return true;
    const minN = numberValueOf(other.relation === 'gte' ? other : record.relation === 'gte' ? record : null);
    const maxN = numberValueOf(other.relation === 'lte' ? other : record.relation === 'lte' ? record : null);
    if (minN !== null && maxN !== null && minN > maxN) return true;
  }
  return false;
}

function numberValueOf(record: RequirementRecord | null): number | null {
  if (!record) return null;
  if (record.value.kind === 'quantity') {
    const norm = normalizeQuantity(record.value.value, record.value.unit);
    return norm.comparable ? norm.value : null;
  }
  if (record.value.kind === 'count') return record.value.value;
  return null;
}

// ------------------------------------------------------------------ ingest

export interface IngestInput {
  fragment: NormalizedFragment;
  grounding: GroundingContext;
}

/**
 * Ingest one extraction turn: deterministic merge + supersession + group
 * structure. Pure: the input state is never mutated.
 */
export function ingestFragment(state: RequirementState, input: IngestInput): MergeResult {
  const validated = validateStoredGroups(state);
  const records = cloneRecords(validated.state.records);
  const groups = validated.state.groups.map((g) => ({ ...g, children: [...g.children] }));
  const events: MergeEvent[] = [...validated.events];
  const ctx: MergeCtx = {
    records,
    events,
    turn: input.grounding.turn,
    at: input.grounding.at,
  };

  const built: BuiltAtom[] = [];
  const build = (candidate: NormalizedCandidate, placement: Placement, resolves = false): void => {
    const { record } = buildRecord(candidate, input.grounding, input.grounding.turn);
    // Provenance/status were derived from grounding inside buildRecord — the
    // model has no vote on either. OR placements carry their branch scope and
    // index on the record itself, so supersession keys and conflict scoping
    // work across turns, not just within one ingest.
    if (placement.kind === 'or') {
      record.branchScope = placement.branchScope;
      record.altIndex = placement.altIndex;
    }
    built.push({ record, placement, resolves, carrierId: null });
  };

  // -- placement pass (fragment shape decides structure before any merge)
  for (const candidate of input.fragment.atoms) build(candidate, { kind: 'standalone' });
  for (const and of input.fragment.andGroups) {
    for (const candidate of and.atoms) build(candidate, { kind: 'and' });
  }

  const malformedOrGroupKeys = new Set<string>();
  input.fragment.orGroups.forEach((or, orIndex) => {
    const shapes = or.branches.map((branch) =>
      branch
        .map(
          (a) =>
            `${a.property}@${a.scope}|${temporalKey(a.temporal)}|${
              a.binding ? normalizedValueRepr(a.binding.value) : ''
            }`,
        )
        .sort()
        .join('&&'),
    );
    const coherent = or.branches.length >= 2 && shapes.every((s) => s === shapes[0]);
    if (!coherent) {
      const groupId = newRequirementId('grp');
      const memberIds: string[] = [];
      for (const branch of or.branches) {
        for (const candidate of branch) {
          const { record } = buildRecord(candidate, input.grounding, input.grounding.turn);
          record.status = 'PENDING_RESOLUTION';
          records.push(record);
          memberIds.push(record.id);
          events.push({ kind: 'quarantined', recordId: record.id, reason: 'MALFORMED_OR' });
        }
      }
      groups.push({
        id: groupId,
        groupKey: `or|malformed|${orIndex}|${input.grounding.turn}`,
        kind: 'or',
        children: memberIds.map((id) => ({ kind: 'atom' as const, id })),
        status: 'QUARANTINED',
        quarantineReason: 'ARITY',
        turn: input.grounding.turn,
        createdAt: input.grounding.at,
      });
      malformedOrGroupKeys.add(`or|malformed|${orIndex}|${input.grounding.turn}`);
      events.push({ kind: 'quarantined', groupId, reason: 'ARITY' });
      return;
    }
    const first = or.branches[0][0];
    const groupKey = orGroupKeyOf(first.property, first.scope, first.temporal, first.binding);
    const scopePrefix = `${groupKey}#`;

    // Branch slots are aligned by MEMBER VALUES against the existing state, so
    // mutable value ordering cannot renumber an unchanged branch: "30 or 60"
    // restated as "90 or 60" keeps 60's slot (and its immutable record id)
    // while 90 takes a fresh slot and 30 — no longer asserted — is superseded
    // by the restatement sweep. ACTIVE slots take precedence; a dormant
    // (SUPERSEDED) slot is reused so re-asserting a dropped value resurrects
    // the original record by its exact key.
    interface ExistingSlot { altIndex: number; members: string[]; active: boolean }
    const slots = new Map<string, ExistingSlot>();
    for (const r of records) {
      if (r.status !== 'ACTIVE' && r.status !== 'SUPERSEDED') continue;
      if (!r.branchScope?.startsWith(scopePrefix)) continue;
      const slot = slots.get(r.branchScope) ?? { altIndex: r.altIndex ?? 0, members: [], active: false };
      if (r.status === 'ACTIVE') slot.active = true;
      slot.members.push(normalizedValueRepr(r.value));
      slots.set(r.branchScope, slot);
    }
    const activeByAlignment = new Map<string, { branchScope: string; altIndex: number }>();
    const dormantByAlignment = new Map<string, { branchScope: string; altIndex: number }>();
    for (const [branchScope, slot] of slots) {
      const alignment = [...slot.members].sort().join('&&');
      const target = slot.active ? activeByAlignment : dormantByAlignment;
      if (!target.has(alignment)) target.set(alignment, { branchScope, altIndex: slot.altIndex });
    }
    let maxAlt = -1;
    for (const slot of slots.values()) maxAlt = Math.max(maxAlt, slot.altIndex);

    const alignmentOf = (branch: NormalizedCandidate[]): string =>
      branch.map((a) => normalizedValueRepr(a.value)).sort().join('&&');

    const assigned = new Map<number, { branchScope: string; altIndex: number }>();
    const usedSlots = new Set<string>();
    const fresh: Array<{ index: number; alignment: string }> = [];
    or.branches.forEach((branch, declaredIndex) => {
      const alignment = alignmentOf(branch);
      const slot = activeByAlignment.get(alignment) ?? dormantByAlignment.get(alignment);
      if (slot && !usedSlots.has(slot.branchScope)) {
        assigned.set(declaredIndex, slot);
        usedSlots.add(slot.branchScope);
      } else {
        fresh.push({ index: declaredIndex, alignment });
      }
    });
    // New values take fresh slots above every existing index, in deterministic
    // sorted order — ordering inside the user's sentence is never semantic.
    fresh.sort((a, b) => (a.alignment < b.alignment ? -1 : a.alignment > b.alignment ? 1 : a.index - b.index));
    let nextAlt = maxAlt + 1;
    for (const entry of fresh) {
      assigned.set(entry.index, { branchScope: `${scopePrefix}${nextAlt}`, altIndex: nextAlt });
      nextAlt += 1;
    }
    or.branches.forEach((branch, declaredIndex) => {
      const slot = assigned.get(declaredIndex)!;
      for (const candidate of branch) {
        build(candidate, { kind: 'or', branchScope: slot.branchScope, altIndex: slot.altIndex });
      }
    });
  });

  for (const not of input.fragment.notGroups) build(not.atom, { kind: 'not' });
  for (const cond of input.fragment.conditionalGroups) {
    for (const candidate of cond.atoms) build(candidate, { kind: 'conditional' });
  }

  // -- merge pass
  for (const atom of built) {
    if (atom.placement.kind === 'quarantined') continue;
    atom.carrierId = mergeAtom(ctx, atom);
  }

  // -- conflict resolution channel: a grounded atom may void the contradicting
  // presence assertion for its family (the user answered "which one?" with a
  // retraction). The voided record is REJECTED — inert forever, distinct from
  // SUPERSEDED (which a restatement can resurrect).
  for (const atom of built) {
    if (!atom.resolves || !atom.carrierId) continue;
    const carrier = records.find((r) => r.id === atom.carrierId)!;
    voidConflicts(ctx, carrier, atom.record.provenance);
  }

  // -- OR restatement: ACTIVE records of an OR group whose key no incoming
  // branch re-asserts are dropped from the alternative set. The sweep runs per
  // GROUP prefix, so a slot the restatement no longer fills (its value was
  // replaced) is swept even though no incoming atom was placed there.
  const orGroupPrefixes = new Set(
    built
      .filter((a) => a.placement.kind === 'or')
      .map((a) => {
        const scope = (a.placement as { kind: 'or'; branchScope: string }).branchScope;
        return scope.slice(0, scope.lastIndexOf('#') + 1);
      }),
  );
  for (const prefix of orGroupPrefixes) {
    const asserted = new Set(
      built
        .filter(
          (a) =>
            a.placement.kind === 'or' &&
            (a.placement as { kind: 'or'; branchScope: string }).branchScope.startsWith(prefix) &&
            a.carrierId,
        )
        .map((a) => {
          const carrier = records.find((r) => r.id === a.carrierId)!;
          return effectiveKeyOfRecord(carrier);
        }),
    );
    for (const record of records) {
      if (record.status !== 'ACTIVE' || !record.branchScope?.startsWith(prefix)) continue;
      if (asserted.has(effectiveKeyOfRecord(record))) continue;
      if (built.some((a) => a.carrierId === record.id)) continue;
      record.status = 'SUPERSEDED';
      record.updatedAt = ctx.at;
      events.push({ kind: 'superseded', recordId: record.id, reason: 'OR_RESTATEMENT' });
    }
  }

  // -- group plans (children reference the ACTIVE carriers)
  const plans: GroupPlan[] = [];
  // Children are collected by walking `built` in exactly the order the
  // placement pass created it — one index per atom, no re-matching heuristics.
  const takeIds = (count: number): Array<{ kind: 'atom'; id: string }> => {
    const out: Array<{ kind: 'atom'; id: string }> = [];
    for (let i = 0; i < count; i++) {
      const atom = built[cursor++];
      if (atom?.carrierId) out.push({ kind: 'atom', id: atom.carrierId });
    }
    return out;
  };
  let cursor = input.fragment.atoms.length; // standalone atoms carry no group

  for (const and of input.fragment.andGroups) {
    const childIds = takeIds(and.atoms.length);
    const memberKeys = and.atoms.map((candidate) =>
      slotKeyOfParts({
        property: candidate.property,
        scope: candidate.scope,
        relation: candidate.relation,
        value: candidate.value,
        binding: candidate.binding,
        temporal: candidate.temporal,
      }),
    );
    plans.push({ groupKey: andGroupKeyOf(memberKeys), kind: 'and', children: childIds });
  }
  input.fragment.orGroups.forEach((or, orIndex) => {
    if (malformedOrGroupKeys.has(`or|malformed|${orIndex}|${input.grounding.turn}`)) {
      cursor += or.branches.reduce((sum, branch) => sum + branch.length, 0);
      return;
    }
    const first = or.branches[0][0];
    const groupKey = orGroupKeyOf(first.property, first.scope, first.temporal, first.binding);
    const children = takeIds(or.branches.reduce((sum, branch) => sum + branch.length, 0));
    // The GROUP plan keeps the group-level key; child records carry their own
    // per-branch scopes. Group lookup for refresh uses the group-level key.
    plans.push({
      groupKey,
      kind: 'or',
      children,
    });
  });
  for (const not of input.fragment.notGroups) {
    const children = takeIds(1);
    const parts: KeyParts = {
      property: not.atom.property,
      scope: not.atom.scope,
      relation: not.atom.relation,
      value: not.atom.value,
      binding: not.atom.binding,
      temporal: not.atom.temporal,
    };
    plans.push({ groupKey: notGroupKeyOf(parts), kind: 'not', children });
  }
  for (const cond of input.fragment.conditionalGroups) {
    const children = takeIds(cond.atoms.length);
    plans.push({
      groupKey: conditionalGroupKeyOf(cond.guard),
      kind: 'conditional',
      children,
      guard: cond.guard,
    });
  }

  upsertGroups(groups, events, ctx.at, input.grounding.turn, plans);

  return { state: { records, groups }, events };
}

/**
 * The contradicting presence assertion for the same family is REJECTED
 * (user-retracted, inert forever) when the resolving atom carries at least
 * equal authority.
 */
function voidConflicts(ctx: MergeCtx, carrier: RequirementRecord, provenance: RequirementRecord['provenance']): void {
  for (const other of ctx.records) {
    if (other.status !== 'ACTIVE' || other.id === carrier.id) continue;
    if (other.property !== carrier.property || other.scope !== carrier.scope) continue;
    if (temporalKey(other.temporal) !== temporalKey(carrier.temporal)) continue;
    if ((other.branchScope ?? '') !== (carrier.branchScope ?? '')) continue;
    const contradicts =
      (assertsPresence(other.relation) &&
        carrier.relation === 'excludes' &&
        valuesEqual(other.value, carrier.value)) ||
      (assertsPresence(carrier.relation) &&
        other.relation === 'excludes' &&
        valuesEqual(other.value, carrier.value));
    if (!contradicts) continue;
    if (provenanceRank(provenance) > provenanceRank(other.provenance)) continue;
    other.status = 'REJECTED';
    other.updatedAt = ctx.at;
    ctx.events.push({ kind: 'voided', recordId: other.id, reason: 'CONFLICT_RESOLUTION' });
  }
}

interface GroupPlan {
  groupKey: string;
  kind: GroupKind;
  children: GroupChildRef[];
  guard?: { property: string; value: RequirementValue };
}

/** Create-or-refresh groups by deterministic semantic key; ids stay immutable. */
function upsertGroups(
  groups: RequirementGroup[],
  events: MergeEvent[],
  at: string,
  turn: number,
  plans: GroupPlan[],
): void {
  for (const plan of plans) {
    if (plan.children.length === 0) continue;
    const existing = groups.find(
      (g) => g.groupKey === plan.groupKey && g.kind === plan.kind && g.status !== 'QUARANTINED',
    );
    if (existing) {
      existing.children = plan.children;
      if (plan.guard) existing.guard = plan.guard;
      existing.turn = turn;
      events.push({ kind: 'refreshed', groupId: existing.id });
    } else {
      const group: RequirementGroup = {
        id: newRequirementId('grp'),
        groupKey: plan.groupKey,
        kind: plan.kind,
        children: plan.children,
        status: 'ACTIVE',
        turn,
        createdAt: at,
      };
      if (plan.guard) group.guard = plan.guard;
      groups.push(group);
      events.push({ kind: 'activated', groupId: group.id });
    }
  }
}

// ------------------------------------------------------- ambiguous OR handling

/**
 * An ambiguous restatement ("make one of them 45"): the candidates are stored
 * in PENDING_RESOLUTION and NO authoritative mutation happens. Deterministic,
 * model-independent — the session layer calls this when the user's words
 * target one alternative without saying which.
 */
export function ingestPendingAmbiguity(
  state: RequirementState,
  input: {
    property: string;
    scope: RequirementRecord['scope'];
    temporal: RequirementRecord['temporal'];
    relation: RequirementRecord['relation'];
    candidates: RequirementValue[];
    grounding: GroundingContext;
  },
): MergeResult {
  const validated = validateStoredGroups(state);
  const records = cloneRecords(validated.state.records);
  const groups = validated.state.groups.map((g) => ({ ...g, children: [...g.children] }));
  const events: MergeEvent[] = [...validated.events];

  const groupKey = `${orGroupKeyOf(input.property, input.scope, input.temporal)}|pending|${input.grounding.turn}`;
  const children: Array<{ kind: 'atom'; id: string }> = [];
  for (const value of input.candidates) {
    const record: RequirementRecord = {
      id: newRequirementId('req'),
      property: input.property,
      scope: input.scope,
      relation: input.relation,
      value,
      strength: 'REQUIRED',
      status: 'PENDING_RESOLUTION',
      provenance: 'USER_EXPLICIT',
      temporal: input.temporal,
      evidence: null,
      turn: input.grounding.turn,
      createdAt: input.grounding.at,
      updatedAt: input.grounding.at,
    };
    records.push(record);
    children.push({ kind: 'atom', id: record.id });
    events.push({ kind: 'pending', recordId: record.id });
  }
  groups.push({
    id: newRequirementId('grp'),
    groupKey,
    kind: 'or',
    children,
    status: 'PENDING_RESOLUTION',
    turn: input.grounding.turn,
    createdAt: input.grounding.at,
  });
  events.push({ kind: 'pending', groupId: groupKey });

  return { state: { records, groups }, events };
}

/**
 * Resolve a PENDING group once the user clarified: the chosen value merges
 * into the branch slot of the value it REPLACES (same semantic slot inside
 * that branch scope, so the old record is superseded, never duplicated); the
 * pending group itself is superseded (resolved).
 */
export function resolvePending(
  state: RequirementState,
  input: {
    pendingGroupKey: string;
    /** The old alternative the user is replacing. */
    replacedValue: RequirementValue;
    /** The value that takes its place. */
    chosenValue: RequirementValue;
    property: string;
    scope: RequirementRecord['scope'];
    relation: RequirementRecord['relation'];
    temporal: RequirementRecord['temporal'];
    grounding: GroundingContext;
  },
): MergeResult {
  const pendingGroupKey = input.pendingGroupKey;
  const records = cloneRecords(state.records);
  const groups = state.groups.map((g) => ({ ...g, children: [...g.children] }));
  const events: MergeEvent[] = [];

  // Look the group up in the CLONE — mutating the pre-clone reference would
  // leave the returned state untouched.
  const pendingGroup = groups.find((g) => g.groupKey === pendingGroupKey);
  if (pendingGroup && pendingGroup.status === 'PENDING_RESOLUTION') {
    pendingGroup.status = 'SUPERSEDED';
    events.push({ kind: 'superseded', groupId: pendingGroup.id, reason: 'PENDING_RESOLVED' });
  }

  const groupScope = orGroupKeyOf(input.property, input.scope, input.temporal);
  // Find the branch slot of the replaced value.
  const target = records.find(
    (r) =>
      r.status === 'ACTIVE' &&
      r.property === input.property &&
      r.scope === input.scope &&
      temporalKey(r.temporal) === temporalKey(input.temporal) &&
      r.branchScope?.startsWith(groupScope) &&
      valuesEqual(r.value, input.replacedValue),
  );
  const branchScope = target?.branchScope ?? `${groupScope}#0`;
  const altIndex = target?.altIndex ?? 0;

  const ctx: MergeCtx = {
    records,
    events,
    turn: input.grounding.turn,
    at: input.grounding.at,
  };
  const record: RequirementRecord = {
    id: newRequirementId('req'),
    property: input.property,
    scope: input.scope,
    relation: input.relation,
    value: input.chosenValue,
    strength: 'REQUIRED',
    status: 'ACTIVE',
    provenance: 'USER_EXPLICIT',
    temporal: input.temporal,
    evidence: null,
    turn: input.grounding.turn,
    createdAt: input.grounding.at,
    updatedAt: input.grounding.at,
  };
  mergeAtom(ctx, {
    record,
    placement: { kind: 'or', branchScope, altIndex },
    resolves: false,
    carrierId: null,
  });

  return { state: { records, groups }, events };
}

/** Group status lookup for tests and the gap engine. */
export function groupStatusOf(state: RequirementState, groupKey: string): GroupStatus | undefined {
  return state.groups.find((g) => g.groupKey === groupKey)?.status;
}
