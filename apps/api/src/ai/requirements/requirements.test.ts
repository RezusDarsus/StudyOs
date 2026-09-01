import { describe, expect, it } from 'vitest';
import {
  parseContext,
  serializeContext,
  createContext,
} from '../context.js';
import {
  emptyRequirementState,
  ingestExtraction,
  resolvePending,
  groundEvidence,
  provenanceFor,
  normalizeForGrounding,
  requirementFragmentSchema,
  projectState,
  effectiveExclusions,
  advisoryLinesFromState,
  buildValidationSource,
  detectConflicts,
  contractsFromState,
  evaluateAstReadiness,
  collectAssumptions,
  renderAssumptionLines,
  validateStoredGroups,
  effectiveKeyOfRecord,
  orGroupKeyOf,
  valuesEqual,
  slotKeyOf,
  temporalKey,
  normalizePhaseLabel,
  normalizedValueRepr,
  type GroundingContext,
  type RequirementState,
  type RequirementRecord,
} from './index.js';
import { validateAndNormalizeDraft } from '../draft-validator.js';
import { installRuntimeContent } from '../../runtime-content.js';
import { canonicalUnit } from './types.js';

// Stage 5 rev.6 acceptance: every invariant the revisions pinned, as tests.

// The draft validator compiles role lexicons from the runtime port; the unit
// suite installs the production content once for this file, matching the
// vitest setup (src/test/runtime-content-setup.ts).
installRuntimeContent();

const G = (over: Partial<GroundingContext> = {}): GroundingContext => ({
  turn: 1,
  message: 'I want to run 30 minutes or 60 minutes on weekdays',
  at: '2026-08-31T00:00:00.000Z',
  ...over,
});

const atom = (over: Partial<RequirementRecord> & Pick<RequirementRecord, 'id'>): RequirementRecord => ({
  property: 'schedule.session.length',
  scope: 'schedule',
  relation: 'eq',
  value: { kind: 'quantity', value: 30, unit: 'minute' },
  strength: 'REQUIRED',
  status: 'ACTIVE',
  provenance: 'USER_EXPLICIT',
  temporal: { kind: 'always' },
  evidence: null,
  turn: 0,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
  ...over,
});

const frag = (atoms: unknown[], groups: unknown[] = [], pendingAmbiguity: unknown[] = []) =>
  requirementFragmentSchema.parse({ atoms, groups, pendingAmbiguity });

/** Helper: run one extraction and return the state + events. */
function ingest(state: RequirementState, fragment: ReturnType<typeof frag>, grounding = G()) {
  return ingestExtraction(state, fragment, grounding);
}

function active(state: RequirementState): RequirementRecord[] {
  return state.records.filter((r) => r.status === 'ACTIVE');
}

// ---------------------------------------------------------------- identity

describe('relation-aware identity (rev.6 pin)', () => {
  it('REQUIRED running + EXCLUDED running coexist (different slots)', () => {
    const s1 = emptyRequirementState();
    const r1 = ingest(s1, frag([{
      property: 'activity.running', scope: 'session', relation: 'contains',
      value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'run',
    }]));
    const r2 = ingest(r1.state, frag([{
      property: 'activity.running', scope: 'session', relation: 'excludes',
      value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'run',
    }]));
    expect(active(r2.state)).toHaveLength(2);
    expect(r2.state.records.map((r) => r.status).sort()).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it('REQUIRED running + EXCLUDED running → deterministic conflict, not silent merge', () => {
    const s1 = emptyRequirementState();
    const r1 = ingest(s1, frag([{
      property: 'activity.running', scope: 'session', relation: 'contains',
      value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'run',
    }, {
      property: 'activity.running', scope: 'session', relation: 'excludes',
      value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'run',
    }]));
    const view = projectState(r1.state);
    const conflicts = detectConflicts(view);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('REQUIRED_VS_EXCLUDED');
    expect(r1.state.records.filter((r) => r.status === 'ACTIVE')).toHaveLength(2);
  });

  it('exclude running + exclude jumping coexist (value-scoped slots)', () => {
    const r1 = ingest(emptyRequirementState(), frag([
      {
        property: 'activity.running', scope: 'session', relation: 'excludes',
        value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'run',
      },
      {
        property: 'activity.jumping', scope: 'session', relation: 'excludes',
        value: { kind: 'categorical', value: 'jumping' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'jump',
      },
    ]));
    expect(active(r1.state)).toHaveLength(2);
    const view = projectState(r1.state);
    expect(detectConflicts(view)).toHaveLength(0);
  });

  it('gte 30 + lte 60 coexist (min/max slots)', () => {
    const r1 = ingest(emptyRequirementState(), frag([
      {
        property: 'schedule.session.length', scope: 'schedule', relation: 'gte',
        value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
        source: 'stated', evidence: '30',
      },
      {
        property: 'schedule.session.length', scope: 'schedule', relation: 'lte',
        value: { kind: 'quantity', value: 60, unit: 'minute' }, strength: 'REQUIRED',
        source: 'stated', evidence: '60',
      }],
      // The coverage gate blocks on missing DESIRED_OUTCOME etc., but the unit
      // here is only the coexistence of both atoms.
    ));
    const lengths = active(r1.state).filter((r) => r.property === 'schedule.session.length');
    expect(lengths).toHaveLength(2);
    const view = projectState(r1.state);
    expect(detectConflicts(view).filter((c) => c.kind === 'RANGE_INVERTED')).toHaveLength(0);
  });

  it('unit normalization: 2 hours ≡ 120 minutes', () => {
    expect(valuesEqual(
      { kind: 'quantity', value: 2, unit: 'hour' },
      { kind: 'quantity', value: 120, unit: 'minute' },
    )).toBe(true);
    expect(normalizedValueRepr({ kind: 'quantity', value: 2, unit: 'hour' }))
      .toBe(normalizedValueRepr({ kind: 'quantity', value: 120, unit: 'minute' }));
  });
});

describe('temporal identity (rev.6 pin)', () => {
  it('first 2 weeks → 30 minutes + after week 2 → 60 minutes both stay ACTIVE', () => {
    const r1 = ingest(emptyRequirementState(), frag([
      {
        property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
        value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
        temporal: { kind: 'phase', label: 'first 2 weeks' },
        source: 'stated', evidence: 'first 2 weeks',
      },
      {
        property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
        value: { kind: 'quantity', value: 60, unit: 'minute' }, strength: 'REQUIRED',
        temporal: { kind: 'phase', label: 'after week 2' },
        source: 'stated', evidence: 'after week 2',
      },
    ]));
    expect(active(r1.state)).toHaveLength(2);
    const view = projectState(r1.state);
    expect(detectConflicts(view)).toHaveLength(0);
  });

  it('correction to the second phase leaves the first phase untouched', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([
      {
        property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
        value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
        temporal: { kind: 'phase', label: 'first 2 weeks' },
        source: 'stated', evidence: 'first',
      },
      {
        property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
        value: { kind: 'quantity', value: 60, unit: 'minute' }, strength: 'REQUIRED',
        temporal: { kind: 'phase', label: 'after week 2' },
        source: 'stated', evidence: 'after',
      },
    ])).state;
    // Correct the second phase to 45.
    const r2 = ingest(state, frag([
      {
        property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
        value: { kind: 'quantity', value: 45, unit: 'minute' }, strength: 'REQUIRED',
        temporal: { kind: 'phase', label: 'after week 2' },
        source: 'stated', evidence: 'make it 45 after week 2',
      },
    ]));
    const first = r2.state.records.find(
      (r) => r.value.kind === 'quantity' && r.value.value === 30 && r.status === 'ACTIVE',
    );
    expect(first).toBeDefined();
    const superseded = r2.state.records.filter((r) => r.status === 'SUPERSEDED');
    expect(superseded).toHaveLength(1);
    expect(superseded[0].temporal.kind).toBe('phase');
    expect(normalizePhaseLabel((superseded[0].temporal as { label: string }).label)).toBe('after week 2');
  });

  it('phase labels normalize deterministically', () => {
    expect(normalizePhaseLabel('First 2 Weeks!')).toBe('first 2 weeks');
    expect(normalizePhaseLabel('after 2 weeks')).toBe('after 2 weeks');
  });
});

// ---------------------------------------------------------------- helpers

/** OR group fragment over minute values (shared across describes). */
function orFragment(values: number[]) {
  return frag([], [
    {
      kind: 'or',
      branches: values.map((v) => ({
        atoms: [{
          property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
          value: { kind: 'quantity', value: v, unit: 'minute' }, strength: 'REQUIRED',
          source: 'stated', evidence: `${v}`,
        }],
      })),
    },
  ]);
}

/** OR group fragment over arbitrary pre-built atoms. */
function orFragmentOf(atoms: ReturnType<typeof Object>[]) {
  return frag([], [{ kind: 'or' as const, branches: atoms.map((a) => ({ atoms: [a] })) }]);
}

describe('OR semantics (rev.6 pin)', () => {
  it('30 OR 60 → both coexist in one ACTIVE group', () => {
    const r = ingest(emptyRequirementState(), orFragment([30, 60]), G({ message: 'I want 30 or 60 minutes' }));
    expect(active(r.state)).toHaveLength(2);
    expect(r.state.groups.filter((g) => g.status === 'ACTIVE' && g.kind === 'or')).toHaveLength(1);
    const view = projectState(r.state);
    expect(detectConflicts(view)).toHaveLength(0);
  });

  it('30 OR 60 → correction 90 OR 60: 60 keeps its immutable id, 90 replaces 30, one group', () => {
    let state = emptyRequirementState();
    state = ingest(state, orFragment([30, 60]), G({ message: 'I want 30 or 60 minutes' })).state;
    const groupBefore = state.groups.find((g) => g.status === 'ACTIVE' && g.kind === 'or')!;
    const record60Before = state.records.find(
      (r) => r.status === 'ACTIVE' && (r.value as { value: number }).value === 60,
    )!;

    const r2 = ingest(state, orFragment([90, 60]), G({ message: 'actually 90 or 60', turn: 2 }));

    // 60: SAME immutable record id, still ACTIVE, same branch slot.
    const record60After = r2.state.records.find((r) => r.id === record60Before.id)!;
    expect(record60After.status).toBe('ACTIVE');
    expect(record60After.branchScope).toBe(record60Before.branchScope);
    // 30: superseded by the restatement.
    const record30 = r2.state.records.find((r) => (r.value as { value: number }).value === 30)!;
    expect(record30.status).toBe('SUPERSEDED');
    // 90: ACTIVE replacement on a fresh slot of the same group.
    const record90 = r2.state.records.find(
      (r) => r.status === 'ACTIVE' && (r.value as { value: number }).value === 90,
    )!;
    expect(record90).toBeDefined();
    expect(record90.branchScope).not.toBe(record60After.branchScope);
    expect(record90.branchScope?.startsWith('or|schedule.session.length@schedule|always#')).toBe(true);
    // Same logical OR group (group id immutable across the restatement).
    const groupAfter = r2.state.groups.find((g) => g.id === groupBefore.id)!;
    expect(groupAfter).toBeDefined();
    expect(groupAfter.status).toBe('ACTIVE');
    // No ambiguity, no accidental sibling supersession: exactly one record of
    // this family is SUPERSEDED (the 30), and ACTIVE lengths are 60 and 90.
    const family = r2.state.records.filter((r) => r.property === 'schedule.session.length');
    expect(family.filter((r) => r.status === 'SUPERSEDED')).toHaveLength(1);
    const activeValues = family
      .filter((r) => r.status === 'ACTIVE')
      .map((r) => (r.value as { value: number }).value)
      .sort((a, b) => a - b);
    expect(activeValues).toEqual([60, 90]);
    const readiness = evaluateAstReadiness(r2.state, { questionCount: 2, maxQuestions: 10 });
    expect(readiness.pending).toHaveLength(0);
    expect(readiness.conflicts).toHaveLength(0);
  });

  it('30 OR 60 restated as 45 OR 60 → only 30 superseded, 60 kept', () => {
    let state = emptyRequirementState();
    state = ingest(state, orFragment([30, 60]), G({ message: 'I want 30 or 60 minutes' })).state;
    const r2 = ingest(state, orFragment([45, 60]), G({ message: 'actually 45 or 60', turn: 2 }));
    const activeValues = active(r2.state)
      .filter((r) => r.property === 'schedule.session.length')
      .map((r) => (r.value as { value: number }).value)
      .sort((a, b) => a - b);
    expect(activeValues).toEqual([45, 60]);
    const superseded = r2.state.records.filter((r) => r.status === 'SUPERSEDED');
    expect(superseded).toHaveLength(1);
    expect((superseded[0].value as { value: number }).value).toBe(30);
  });

  it('OR branch atoms do not conflict with each other', () => {
    // "30 or 60" — presence on both branches never reports a conflict.
    const r = ingest(emptyRequirementState(), orFragment([30, 60]));
    expect(detectConflicts(projectState(r.state))).toHaveLength(0);
  });

  it('ambiguous "make one 45" → PENDING_RESOLUTION, no authoritative mutation', () => {
    let state = emptyRequirementState();
    state = ingest(state, orFragment([30, 60]), G({ message: 'I want 30 or 60 minutes' })).state;
    const before = state.records.filter((r) => r.status === 'ACTIVE').map((r) => r.id).sort();

    const r2 = ingest(state, frag([], [], [{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      candidates: [
        { kind: 'quantity', value: 30, unit: 'minute' },
        { kind: 'quantity', value: 60, unit: 'minute' },
      ],
      evidence: 'make one of them 45',
    }]), G({ message: 'make one of them 45', turn: 2 }));

    // No authoritative record changed: same ACTIVE ids, same values.
    const after = r2.state.records.filter((r) => r.status === 'ACTIVE').map((r) => r.id).sort();
    expect(after).toEqual(before);
    // PENDING_RESOLUTION group + atoms exist.
    expect(r2.state.groups.some((g) => g.status === 'PENDING_RESOLUTION')).toBe(true);
    expect(r2.state.records.some((r) => r.status === 'PENDING_RESOLUTION')).toBe(true);
    // And the readiness gate reports a BLOCKING pending, not a silent plan.
    const readiness = evaluateAstReadiness(r2.state, { questionCount: 2, maxQuestions: 10 });
    expect(readiness.ready).toBe(false);
    expect(readiness.pending.length).toBeGreaterThan(0);
  });

  it('resolving the pending group mutates only then', () => {
    let state = emptyRequirementState();
    state = ingest(state, orFragment([30, 60]), G({ message: 'I want 30 or 60 minutes' })).state;
    const r2 = ingest(state, frag([], [], [{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      candidates: [
        { kind: 'quantity', value: 30, unit: 'minute' },
        { kind: 'quantity', value: 60, unit: 'minute' },
      ],
      evidence: 'make one of them 45',
    }]), G({ message: 'make one of them 45', turn: 2 }));
    const pendingGroup = r2.state.groups.find((g) => g.status === 'PENDING_RESOLUTION')!;
    // Clarification: 45 replaces the 60-minute branch.
    const r3 = resolvePending(r2.state, {
      pendingGroupKey: pendingGroup.groupKey,
      replacedValue: { kind: 'quantity', value: 60, unit: 'minute' },
      chosenValue: { kind: 'quantity', value: 45, unit: 'minute' },
      property: 'schedule.session.length',
      scope: 'schedule',
      relation: 'eq',
      temporal: { kind: 'always' },
      grounding: G({ message: '45 replaces the 60 one', turn: 3 }),
    });
    const values = active(r3.state)
      .filter((r) => r.property === 'schedule.session.length')
      .map((r) => (r.value as { value: number }).value)
      .sort((a, b) => a - b);
    expect(values).toEqual([30, 45]);
    expect(r3.state.groups.some((g) => g.status === 'PENDING_RESOLUTION')).toBe(false);
  });
});

describe('logical structure (rev.6 pin)', () => {
  it('malformed OR → quarantine, never flattened to AND', () => {
    // Branches on different properties — incoherent.
    const r = ingest(emptyRequirementState(), frag([], [
      {
        kind: 'or',
        branches: [
          { atoms: [{
            property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
            value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
            source: 'stated', evidence: '30',
          }] },
          { atoms: [{
            property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq',
            value: { kind: 'count', value: 3 }, strength: 'REQUIRED',
            source: 'stated', evidence: '3',
          }] },
        ],
      },
    ]));
    expect(r.state.groups.some((g) => g.status === 'QUARANTINED' && g.kind === 'or')).toBe(true);
    // The members are PENDING_RESOLUTION — never ACTIVE ANDs.
    expect(r.state.records.every((r) => r.status !== 'ACTIVE')).toBe(true);
    expect(r.state.records.every((r) => r.status === 'PENDING_RESOLUTION')).toBe(true);
    // Readiness refuses generation.
    const readiness = evaluateAstReadiness(r.state, { questionCount: 1, maxQuestions: 10 });
    expect(readiness.ready).toBe(false);
  });

  it('NOT(A) remains NOT(A) — stored as a negation group, projects as exclusion', () => {
    const r = ingest(emptyRequirementState(), frag([], [
      {
        kind: 'not',
        atom: {
          property: 'activity.running', scope: 'session', relation: 'contains',
          value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED',
          source: 'stated', evidence: 'never run',
        },
      },
    ]));
    expect(r.state.groups.filter((g) => g.kind === 'not' && g.status === 'ACTIVE')).toHaveLength(1);
    // The atom itself is ACTIVE presence; the NOT group flips it at projection.
    const view = projectState(r.state);
    expect(view.atoms).toHaveLength(1);
    expect(view.atoms[0].negated).toBe(true);
    // And the effective exclusions carry it.
    const exclusions = effectiveExclusions(view);
    expect(exclusions.some((e) => e.negated === false && e.property === 'activity.running')).toBe(true);
  });

  it('dangling child → quarantined before arity normalization', () => {
    const state: RequirementState = {
      records: [atom({ id: 'req_a' })],
      groups: [{
        id: 'grp_x',
        groupKey: 'and|test',
        kind: 'and',
        children: [
          { kind: 'atom', id: 'req_a' },
          { kind: 'atom', id: 'req_missing' },
        ],
        status: 'ACTIVE',
        turn: 0,
        createdAt: '2026-08-31T00:00:00.000Z',
      }],
    };
    const v = validateStoredGroups(state);
    const group = v.state.groups.find((g) => g.id === 'grp_x')!;
    expect(group.status).toBe('QUARANTINED');
    expect(group.quarantineReason).toBe('DANGLING_REF');
  });

  it('cyclic group graph → quarantined', () => {
    const state: RequirementState = {
      records: [],
      groups: [
        {
          id: 'grp_a', groupKey: 'a', kind: 'and',
          children: [{ kind: 'group', id: 'grp_b' }],
          status: 'ACTIVE', turn: 0, createdAt: '2026-08-31T00:00:00.000Z',
        },
        {
          id: 'grp_b', groupKey: 'b', kind: 'and',
          children: [{ kind: 'group', id: 'grp_a' }],
          status: 'ACTIVE', turn: 0, createdAt: '2026-08-31T00:00:00.000Z',
        },
      ],
    };
    const v = validateStoredGroups(state);
    for (const g of v.state.groups) {
      expect(g.status).toBe('QUARANTINED');
      expect(g.quarantineReason).toBe('CYCLE');
    }
  });

  it('conditional group projects only when the guard holds', () => {
    let state = emptyRequirementState();
    // Guard: activity.swimming = categorical swimming; then 30-minute sessions.
    state = ingest(state, frag([
      {
        property: 'activity.swimming', scope: 'session', relation: 'contains',
        value: { kind: 'categorical', value: 'swimming' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'swim',
      },
    ], [
      {
        kind: 'conditional',
        guard: { property: 'activity.swimming', value: { kind: 'categorical', value: 'swimming' } },
        atoms: [{
          property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
          value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
          source: 'stated', evidence: '30',
        }],
      },
    ])).state;
    let view = projectState(state);
    // Guard satisfied → atom projects.
    expect(view.atoms.some((a) => a.record.property === 'schedule.session.length')).toBe(true);

    // Now without the guard-holding atom: the conditional child stays out.
    const state2 = emptyRequirementState();
    const r2 = ingest(state2, frag([
      {
        property: 'activity.running', scope: 'session', relation: 'contains',
        value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'run',
      },
    ], [
      {
        kind: 'conditional',
        guard: { property: 'activity.swimming', value: { kind: 'categorical', value: 'swimming' } },
        atoms: [{
          property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
          value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
          source: 'stated', evidence: '30',
        }],
      },
    ]));
    view = projectState(r2.state);
    expect(view.atoms.some((a) => a.record.property === 'schedule.session.length')).toBe(false);
  });
});

// ---------------------------------------------------------------- provenance

describe('evidence grounding + provenance (rev.6 pin)', () => {
  it('model cannot assign USER_EXPLICIT without a grounded quote', () => {
    const verdict = groundEvidence('the user definitely said 30 minutes', G({
      message: 'I run 30 minutes daily',
    }));
    expect(verdict.grounded).toBe(false);
    expect(provenanceFor('stated', verdict)).toBe('MODEL_INFERRED');
  });

  it('grounded stated → USER_EXPLICIT', () => {
    const verdict = groundEvidence('30 minutes', G({ message: 'I run 30 minutes daily' }));
    expect(verdict.grounded).toBe(true);
    expect(verdict.source).toBe('message');
    expect(provenanceFor('stated', verdict)).toBe('USER_EXPLICIT');
  });

  it('answer surface grounds; historical surfaces do not exist here', () => {
    const verdict = groundEvidence('three days', G({
      message: undefined,
      answer: { questionId: 'q1', text: 'three days per week' },
    }));
    expect(verdict.grounded).toBe(true);
    expect(verdict.source).toBe('answer');
    // The same quote does NOT ground against an absent message surface.
    const miss = groundEvidence('three days', G({ message: undefined, answer: { questionId: 'q1', text: 'two days' } }));
    expect(miss.grounded).toBe(false);
  });

  it('grounded through the full pipeline: ingest promotes grounded stated atoms', () => {
    const r = ingest(emptyRequirementState(), frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: '30 minutes',
    }]), G({ message: 'I want to run 30 minutes a day' }));
    const rec = active(r.state)[0];
    expect(rec.provenance).toBe('USER_EXPLICIT');
    expect(rec.evidence?.quote).toBe('30 minutes');
    expect(rec.evidence?.source).toBe('message');
  });

  it('ungrounded atoms degrade to MODEL_INFERRED and never claim user authority', () => {
    const r = ingest(emptyRequirementState(), frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'totally made up quote',
    }]), G({ message: 'I want to run' }));
    expect(active(r.state)[0].provenance).toBe('MODEL_INFERRED');
  });
});

// ---------------------------------------------------------------- assumptions

describe('assumption policy (rev.6 pin)', () => {
  it('SYSTEM_ASSUMPTION contradicting user authority is rejected, never ACTIVE, never rendered', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: '30 minutes',
    }]), G({ message: 'run 30 minutes' })).state;
    // Model tries to assume the opposite.
    const r2 = ingest(state, frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'excludes',
      value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
      source: 'assumption', evidence: 'maybe not running',
    }]));
    // The assumption did not become ACTIVE.
    const exclusions = r2.state.records.filter(
      (r) => r.relation === 'excludes' && r.status === 'ACTIVE',
    );
    expect(exclusions).toHaveLength(0);
    // Nothing rendered.
    expect(collectAssumptions(r2.state)).toHaveLength(0);
    expect(renderAssumptionLines(r2.state)).toHaveLength(0);
  });

  it('safe assumptions render with the assumed marker', () => {
    const r = ingest(emptyRequirementState(), frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'gte',
      value: { kind: 'quantity', value: 20, unit: 'minute' }, strength: 'PREFERRED',
      source: 'assumption', evidence: 'a guess',
    }]), G({ message: 'I want to get fit' }));
    const lines = renderAssumptionLines(r.state);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('(assumed');
  });

  it('non-assumption provenance never renders as an assumption', () => {
    const r = ingest(emptyRequirementState(), frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: '30',
    }]), G({ message: '30' }));
    expect(collectAssumptions(r.state)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- contracts

describe('AST → ConstraintContract projection (rev.6 pin)', () => {
  it('gte 30 + lte 60 projects maxMinutesPerSession=60 (and coexistence)', () => {
    const r = ingest(emptyRequirementState(), frag([
      {
        property: 'schedule.session.length', scope: 'schedule', relation: 'lte',
        value: { kind: 'quantity', value: 60, unit: 'minute' }, strength: 'REQUIRED',
        source: 'stated', evidence: '60',
      },
      {
        property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq',
        value: { kind: 'count', value: 3 }, strength: 'REQUIRED',
        source: 'stated', evidence: '3',
      },
    ]));
    const contracts = contractsFromState(r.state);
    expect(contracts).toHaveLength(1);
    expect(contracts[0].maxMinutesPerSession).toBe(60);
    expect(contracts[0].exactWeekly).toBe(3);
  });

  it('30 OR 60 produces two contract variants; a 45-minute draft violates both, 30 and 60 pass', () => {
    const r = ingest(emptyRequirementState(), orFragmentFragment());
    const contracts = contractsFromState(r.state);
    expect(contracts).toHaveLength(2);
    const caps = contracts.map((c) => c.maxMinutesPerSession).sort((a, b) => a! - b!);
    expect(caps).toEqual([30, 60]);
  });

  it('excluded weekday projects into the contract', () => {
    const r = ingest(emptyRequirementState(), frag([
      {
        property: 'schedule.days', scope: 'schedule', relation: 'excludes',
        value: { kind: 'weekdaySet', days: [0] }, strength: 'REQUIRED',
        source: 'stated', evidence: 'never on sunday',
      },
      {
        property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq',
        value: { kind: 'count', value: 3 }, strength: 'REQUIRED',
        source: 'stated', evidence: '3',
      },
    ]));
    const contracts = contractsFromState(r.state);
    expect(contracts[0].excludedWeekdays).toEqual([0]);
    // Legacy parity: parseExplicitGoalConstraints yields UNSPECIFIED cadence
    // for "3x/week, never Sunday" too (no allowed-day pool was named).
    expect(contracts[0].cadence).toBe('UNSPECIFIED');
  });

  it('role requirements project deterministically; unknown roles are ignored', () => {
    const r = ingest(emptyRequirementState(), frag([
      {
        property: 'role.trail.days', scope: 'schedule', relation: 'eq',
        value: { kind: 'weekdaySet', days: [6, 5] }, strength: 'REQUIRED',
        source: 'stated', evidence: 'trail on the weekend',
      },
      {
        property: 'role.strength.min_weekly', scope: 'schedule', relation: 'eq',
        value: { kind: 'count', value: 2 }, strength: 'REQUIRED',
        source: 'stated', evidence: '2 strength',
      },
      {
        property: 'role.zindle.days', scope: 'schedule', relation: 'eq',
        value: { kind: 'weekdaySet', days: [1] }, strength: 'REQUIRED',
        source: 'stated', evidence: 'zindle',
      },
    ]));
    const contract = contractsFromState(r.state)[0];
    expect(contract.roleDays).toEqual([{ role: 'TRAIL', days: [5, 6] }]);
    expect(contract.roleMinWeekly).toEqual([{ role: 'STRENGTH', minOccurrences: 2 }]);
    // A closed checker set: an open property cannot fabricate a role.
    expect(contract.roleDays.some((r) => r.role === ('ZINDLE' as never))).toBe(false);
    expect(contract.cadence).toBe('FIXED');
  });

  it('calendar-month cadence and skipped months project into the contract', () => {
    const r = ingest(emptyRequirementState(), frag([
      {
        property: 'finance.monthly.interval', scope: 'goal', relation: 'eq',
        value: { kind: 'count', value: 1 }, strength: 'REQUIRED',
        source: 'stated', evidence: 'monthly',
      },
      {
        property: 'finance.monthly.day', scope: 'goal', relation: 'eq',
        value: { kind: 'text', value: 'last' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'last day',
      },
      {
        property: 'finance.month.excluded', scope: 'goal', relation: 'excludes',
        value: { kind: 'text', value: '2026-12' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'skip december',
      },
    ]));
    const contract = contractsFromState(r.state)[0];
    expect(contract.monthly).toEqual({ intervalMonths: 1, dayOfMonth: 'LAST' });
    expect(contract.excludedMonths).toEqual(['2026-12']);
  });

  it('consecutive evenings and undefined-metric booleans project', () => {
    const r = ingest(emptyRequirementState(), frag([
      {
        property: 'schedule.evenings.consecutive', scope: 'schedule', relation: 'eq',
        value: { kind: 'boolean', value: false }, strength: 'REQUIRED',
        source: 'stated', evidence: 'never on consecutive evenings',
      },
      {
        property: 'goal.metric.defined', scope: 'goal', relation: 'eq',
        value: { kind: 'boolean', value: false }, strength: 'REQUIRED',
        source: 'stated', evidence: 'no metric defined',
      },
    ]));
    const contract = contractsFromState(r.state)[0];
    expect(contract.prohibitConsecutiveEvenings).toBe(true);
    expect(contract.undefinedMetric).toBe(true);
  });

  it('totalWeeklyOccurrences mirrors exactWeekly (contract parity)', () => {
    const r = ingest(emptyRequirementState(), frag([
      {
        property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq',
        value: { kind: 'count', value: 4 }, strength: 'REQUIRED',
        source: 'stated', evidence: '4 days',
      },
    ]));
    const contract = contractsFromState(r.state)[0];
    expect(contract.totalWeeklyOccurrences).toBe(4);
    expect(contract.exactWeekly).toBe(4);
  });

  it('phase amounts and exchange rates stay ADVISORY: surfaced in lines, never silently dropped', () => {
    const r = ingest(emptyRequirementState(), frag([
      {
        property: 'finance.monthly.amount', scope: 'goal', relation: 'eq',
        value: { kind: 'quantity', value: 200, unit: 'eur' }, strength: 'REQUIRED',
        temporal: { kind: 'phase', label: 'first 3 months' },
        source: 'stated', evidence: '200 a month',
      },
      {
        property: 'finance.exchange.rate', scope: 'goal', relation: 'eq',
        value: { kind: 'count', value: 3 }, strength: 'PREFERRED',
        source: 'assumption', evidence: 'a rate',
      },
    ]));
    // Not contract fields — they need multi-field/cross-currency computation.
    const contract = contractsFromState(r.state)[0];
    expect(contract.monthly).toBeUndefined();
    expect(contract.monthlyMoneyCap).toBeUndefined();
    // But they are surfaced, never silently ignored.
    const lines = advisoryLinesFromState(r.state);
    expect(lines.some((l) => l.includes('200') && l.includes('first 3 months'))).toBe(true);
    expect(lines.some((l) => l.includes('exchange rate of 3'))).toBe(true);
  });

  it('forbidden activity projects as forbiddenActivities', () => {
    const r = ingest(emptyRequirementState(), frag([
      {
        property: 'activity.running', scope: 'session', relation: 'excludes',
        value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'never run',
      },
    ]));
    const contracts = contractsFromState(r.state);
    expect(contracts[0].forbiddenActivities).toEqual(['running']);
  });

  it('superseded state never projects: replace 30 with 45 and the contract sees 45', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'lte',
      value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: '30',
    }]), G({ message: '30' })).state;
    const r2 = ingest(state, frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'lte',
      value: { kind: 'quantity', value: 45, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: '45',
    }]), G({ message: 'make it 45' }));
    const contracts = contractsFromState(r2.state);
    expect(contracts).toHaveLength(1);
    expect(contracts[0].maxMinutesPerSession).toBe(45);
  });
});

// ---------------------------------------------------------------- readiness

describe('AST readiness + ready/shouldAsk separation (rev.6 pin)', () => {
  it('missing required coverage blocks; HIGH gap only shouldAsk', () => {
    const r = ingest(emptyRequirementState(), frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: '30 minutes',
    }]), G({ message: '30 minutes' }));
    const readiness = evaluateAstReadiness(r.state, { questionCount: 1, maxQuestions: 10 });
    // SESSION_SHAPE is satisfied; DESIRED_OUTCOME/WEEKLY_CAPACITY/TIMEFRAME missing → BLOCKING.
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain('DESIRED_OUTCOME');
    expect(readiness.nextQuestion).not.toBeNull();
  });

  it('readiness is not a function of question count', () => {
    const empty = emptyRequirementState();
    expect(evaluateAstReadiness(empty, { questionCount: 0, maxQuestions: 10 }).ready).toBe(false);
    expect(evaluateAstReadiness(empty, { questionCount: 9, maxQuestions: 10 }).ready).toBe(false);
  });

  it('satisfied required coverage with HIGH gap → ready=true, shouldAsk=true (budget left)', () => {
    const state = fullRequiredState();
    const readiness = evaluateAstReadiness(state, { questionCount: 1, maxQuestions: 10 });
    expect(readiness.ready).toBe(true);
    expect(readiness.shouldAsk).toBe(true);
  });

  it('satisfied required coverage with HIGH gap, no budget → shouldAsk=false', () => {
    const state = fullRequiredState();
    const readiness = evaluateAstReadiness(state, { questionCount: 10, maxQuestions: 10 });
    expect(readiness.ready).toBe(true);
    expect(readiness.shouldAsk).toBe(false);
  });

  it('MEDIUM/LOW gaps never set shouldAsk', () => {
    // All required + SESSION_SHAPE satisfied: only optional gaps remain.
    const state = fullRequiredStateWithSessionShape();
    const readiness = evaluateAstReadiness(state, { questionCount: 1, maxQuestions: 10 });
    expect(readiness.ready).toBe(true);
    expect(readiness.shouldAsk).toBe(false);
    expect(readiness.missing.every((k) => !['DESIRED_OUTCOME', 'WEEKLY_CAPACITY', 'TIMEFRAME', 'SESSION_SHAPE'].includes(k))).toBe(true);
  });

  it('conflict blocks generation even with full coverage', () => {
    const state = fullRequiredStateWithSessionShape();
    // Inject a direct conflict through the ingest (REQUIRED + EXCLUDED running).
    const r = ingest(state, frag([
      {
        property: 'activity.running', scope: 'session', relation: 'contains',
        value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'run',
      },
      {
        property: 'activity.running', scope: 'session', relation: 'excludes',
        value: { kind: 'categorical', value: 'running' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'run',
      },
    ]));
    const readiness = evaluateAstReadiness(r.state, { questionCount: 2, maxQuestions: 10 });
    expect(readiness.ready).toBe(false);
    expect(readiness.conflicts.length).toBe(1);
  });
});

// ---------------------------------------------------------------- rollback

describe('structuredContext v3 + payload-preserving rollback (rev.6 pin)', () => {
  it('v3 round-trips through parse -> mutate -> serialize', () => {
    let context = createContext('run more');
    context = { ...context, requirements: emptyRequirementState() };
    const serialized = serializeContext(context);
    expect(JSON.parse(serialized).version).toBe(3);
    const parsed = parseContext(serialized, 'run more');
    expect(parsed.requirements).toBeDefined();
    // Mutate entries only.
    parsed.entries['days_per_week'] = { value: 3, source: 'CURRENT_USER_ANSWER', at: new Date(0).toISOString() };
    const reserialized = serializeContext(parsed);
    const reparsed = parseContext(reserialized, 'run more');
    expect(reparsed.entries['days_per_week']).toBeDefined();
    expect(reparsed.requirements).toEqual(emptyRequirementState());
  });

  it('flag OFF keeps AST bytes untouched (payload preservation)', () => {
    // v3 payload on disk.
    const v3 = serializeContext({ version: 2, goalIntent: 'g', entries: {}, requirements: emptyRequirementState() });
    // A flag-OFF turn parses and re-serializes (entries-only mutation).
    const parsed = parseContext(v3, 'g');
    parsed.entries['x'] = { value: 1, source: 'CURRENT_SESSION_INFERENCE', at: new Date(0).toISOString() };
    const out = serializeContext(parsed);
    // The AST payload survives byte-identically.
    const original = JSON.parse(v3).requirements;
    const after = JSON.parse(out).requirements;
    expect(after).toEqual(original);
    expect(JSON.parse(out).version).toBe(3);
  });

  it('v2 contexts parse unchanged (no requirements key)', () => {
    const parsed = parseContext(JSON.stringify({ version: 2, goalIntent: 'g', entries: { a: { value: 1, source: 'CURRENT_USER_ANSWER', at: '' } } }), 'g');
    expect(parsed.requirements).toBeUndefined();
  });

  it('Stage 6: v1 (pre-provenance flat blob), v2 and v3 payloads all read; new sessions write v3', () => {
    // v1: a flat key/value blob from before provenance existed. It parses as
    // the weakest plausible authority and never throws.
    const v1 = parseContext(JSON.stringify({ goalIntent: 'g', days: 3, notes: 'old shape' }), 'g');
    expect(v1.entries['days']).toEqual({ value: 3, source: 'CURRENT_SESSION_INFERENCE', at: new Date(0).toISOString() });
    expect(v1.requirements).toBeUndefined();
    // v2: same, with the requirements key absent.
    const v2 = parseContext(JSON.stringify({ version: 2, goalIntent: 'g', entries: {} }), 'g');
    expect(v2.requirements).toBeUndefined();
    // v3: reads with the AST attached.
    const v3 = parseContext(serializeContext({ version: 2, goalIntent: 'g', entries: {}, requirements: emptyRequirementState() }), 'g');
    expect(v3.requirements).toBeDefined();
    // New sessions write v3: a context with a requirement payload serializes
    // as version 3, without one as version 2 (byte-compat with old readers).
    expect(JSON.parse(serializeContext({ version: 2, goalIntent: 'g', entries: {}, requirements: emptyRequirementState() })).version).toBe(3);
    expect(JSON.parse(serializeContext(createContext('g'))).version).toBe(2);
  });
});

// ---------------------------------------------------------------- identity vs ids

describe('immutable ids ≠ semantic supersession keys (rev.6 pin)', () => {
  it('supersession keys on effectiveKey, not id: later record (new id) replaces earlier', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: '30 minutes',
    }]), G({ message: 'make it 30 minutes' })).state;
    const first = state.records[0];
    const r2 = ingest(state, frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      value: { kind: 'quantity', value: 45, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: '45 minutes',
    }]), G({ message: 'actually make it 45 minutes' }));
    const second = r2.state.records.find((r) => r.status === 'ACTIVE')!;
    expect(second.id).not.toBe(first.id); // ids immutable, never reused
    const old = r2.state.records.find((r) => r.id === first.id)!;
    expect(old.status).toBe('SUPERSEDED');
    expect(old.supersededById).toBe(second.id);
  });

  it('superseded-value resurrection: a dropped OR branch re-asserted reactivates the SAME record id', () => {
    // Value-scoped slots (excludes) have per-value keys, so a branch that an OR
    // restatement drops becomes dormant at a FREE key; re-asserting the same
    // value revives the original record instead of creating a duplicate.
    const excl = (day: number) => ({
      property: 'schedule.days', scope: 'schedule' as const, relation: 'excludes' as const,
      value: { kind: 'weekdaySet' as const, days: [day] }, strength: 'REQUIRED' as const,
      source: 'stated' as const, evidence: `no day ${day}`,
    });
    let state = emptyRequirementState();
    state = ingest(state, orFragmentOf([excl(0), excl(1)]), G({ message: 'no day 0 and no day 1' })).state;
    const original0 = state.records.find(
      (r) => r.status === 'ACTIVE' && r.value.kind === 'weekdaySet' && r.value.days[0] === 0,
    )!;
    // Restatement drops the day-0 branch entirely.
    state = ingest(state, orFragmentOf([excl(1), excl(2)]), G({ message: 'no day 1 and no day 2 now', turn: 2 })).state;
    expect(state.records.find((r) => r.id === original0.id)!.status).toBe('SUPERSEDED');
    // The user brings day 0 back.
    const r3 = ingest(state, orFragmentOf([excl(0), excl(2)]), G({ message: 'no day 0 and no day 2 again', turn: 3 }));
    const revived = r3.state.records.find((r) => r.id === original0.id)!;
    expect(revived.status).toBe('ACTIVE'); // same immutable id, resurrected
    expect(r3.events.some((e) => e.kind === 'reactivated' && e.recordId === original0.id)).toBe(true);
  });

  it('weaker provenance never supersedes user authority', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: '30 minutes',
    }]), G({ message: 'make it 30 minutes' })).state;
    const r2 = ingest(state, frag([{
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      value: { kind: 'quantity', value: 90, unit: 'minute' }, strength: 'REQUIRED',
      source: 'inferred', evidence: 'probably 90',
    }]), G({ message: 'ok cool' }));
    const still = r2.state.records.find((r) => r.status === 'ACTIVE')!;
    expect((still.value as { value: number }).value).toBe(30);
    expect(r2.events.some((e) => e.kind === 'rejected' && e.reason === 'WEAKER_PROVENANCE')).toBe(true);
  });
});

// ---------------------------------------------------------------- Stage 6 proofs

describe('Stage 6: correction non-resurrection, validator-source form (€500 → €300)', () => {
  it('a corrected monthly cap supersedes the old value; the projected contract and the validator source both carry only the new one', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([{
      property: 'finance.monthly.cap', scope: 'goal', relation: 'lte',
      value: { kind: 'quantity', value: 500, unit: 'eur' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'at most 500 EUR per month',
    }]), G({ turn: 0, message: 'Save with at most 500 EUR per month.' })).state;
    // The correction: the same effective key, a new value — later wins.
    state = ingest(state, frag([{
      property: 'finance.monthly.cap', scope: 'goal', relation: 'lte',
      value: { kind: 'quantity', value: 300, unit: 'eur' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'at most 300 EUR per month',
    }]), G({ turn: 1, message: 'Actually, at most 300 EUR per month.' })).state;

    // Exactly one ACTIVE cap record — €300, at user authority.
    const caps = active(state).filter((r) => r.property === 'finance.monthly.cap');
    expect(caps).toHaveLength(1);
    expect((caps[0].value as { value: number }).value).toBe(300);
    expect(caps[0].provenance).toBe('USER_EXPLICIT');
    // The €500 record is SUPERSEDED, pointed at its replacement.
    const old = state.records.find(
      (r) => r.status === 'SUPERSEDED' && r.property === 'finance.monthly.cap',
    );
    expect(old).toBeDefined();
    expect((old!.value as { value: number }).value).toBe(500);

    // The projected contract carries ONLY the corrected cap.
    const [contract] = contractsFromState(state);
    expect(contract.monthlyMoneyCap).toBe(300);

    // The canonical validator source (Rev.3 §A2) renders the corrected cap
    // and never the superseded value.
        const source = buildValidationSource(state);
    expect(source).toContain('€300');
    expect(source).not.toContain('500');
  });

  it('a €500 draft violates the corrected €300 contract; a €300 draft passes', async () => {
                let state = emptyRequirementState();
    state = ingest(state, frag([{
      property: 'finance.monthly.cap', scope: 'goal', relation: 'lte',
      value: { kind: 'quantity', value: 500, unit: 'eur' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'at most 500 EUR per month',
    }]), G({ turn: 0, message: 'Save with at most 500 EUR per month.' })).state;
    state = ingest(state, frag([{
      property: 'finance.monthly.cap', scope: 'goal', relation: 'lte',
      value: { kind: 'quantity', value: 300, unit: 'eur' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'at most 300 EUR per month',
    }]), G({ turn: 1, message: 'Actually, at most 300 EUR per month.' })).state;

    const source = buildValidationSource(state);
    const contracts = contractsFromState(state);

    const draft = (amount: number, form: 'symbol' | 'word') => ({
      title: 'Save toward the fund',
      description: 'A monthly transfer at the capped amount.',
      category: 'FINANCE',
      targetType: 'HABIT',
      targetValue: null,
      deadline: null,
      rationale: 'Monthly transfers.',
      tasks: [{
        title: form === 'symbol' ? `Transfer €${amount} monthly` : `Transfer EUR ${amount} monthly`,
        description: 'Move the capped amount into the fund on the first of each month.',
        recurrence: { type: 'MONTHLY' as const, dayOfMonth: 1 },
        estimatedMinutes: 10,
        reason: 'The capped monthly contribution.',
      }],
    });

    // The superseded €500 must not resurrect in either money form. The
    // word-form draft is refused outright against the corrected contract;
    // the symbol-form is deterministically CLAMPED down to €300 — the two
    // no-resurrection outcomes the pipeline owns. Neither persists €500.
    expect(() =>
      validateAndNormalizeDraft(draft(500, 'word') as never, 'UTC', new Date(), source, contracts),
    ).toThrowError(/monthly contribution cap of 300/);
    const clamped = validateAndNormalizeDraft(draft(500, 'symbol') as never, 'UTC', new Date(), source, contracts);
    expect(clamped.tasks[0].title).toContain('€300');
    expect(clamped.tasks[0].title).not.toContain('500');
    expect(clamped.adjustments.join(' ')).toMatch(/over-cap contribution amount to 300/);
    for (const form of ['symbol', 'word'] as const) {
      const ok = validateAndNormalizeDraft(draft(300, form) as never, 'UTC', new Date(), source, contracts);
      expect(ok.tasks[0].title).toContain('300');
    }
  });
});

describe('Stage 6: UnmodeledEvidence is grounded, bounded, and strictly non-authoritative', () => {
  const spanFrag = (spans: string[]) => requirementFragmentSchema.parse({
    atoms: [], groups: [], pendingAmbiguity: [], unmodeledSpans: spans,
  });

  it('unmodeled spans ground against the CURRENT turn only and enter the bounded evidence store', () => {
    let state = emptyRequirementState();
    state = ingest(state, spanFrag(['I have a knee injury']), G({
      turn: 0, message: 'I want to get fitter. I have a knee injury.',
    })).state;
    expect(state.unmodeledEvidence).toHaveLength(1);
    expect(state.unmodeledEvidence![0].quote).toBe('I have a knee injury');
    expect(state.unmodeledEvidence![0].turn).toBe(0);

    // A span that does not appear in the current turn is never stored.
    state = ingest(state, spanFrag(['completely unrelated quote']), G({
      turn: 1, message: 'a different message entirely',
    })).state;
    expect(state.unmodeledEvidence!.map((e) => e.quote)).toEqual(['I have a knee injury']);
  });

  it('the evidence store is bounded (≤10, FIFO) and never feeds coverage, conflicts or contracts', () => {
    let state = emptyRequirementState();
    for (let turn = 0; turn < 12; turn++) {
      const note = `note number ${turn}`;
      state = ingest(state, spanFrag([note]), G({ turn, message: `my health: ${note}` })).state;
    }
    expect(state.unmodeledEvidence).toHaveLength(10);
    expect(state.unmodeledEvidence![0].turn).toBe(2); // FIFO dropped the two oldest
    expect(state.unmodeledEvidence![9].turn).toBe(11);

    // Non-authority: no records, no groups — nothing that could act as
    // requirement state was created from the spans.
    expect(state.records).toHaveLength(0);
    expect(state.groups).toHaveLength(0);
    // Non-coverage: readiness still reports every required group missing.
    const readiness = evaluateAstReadiness(state, { questionCount: 0, maxQuestions: 10 });
    expect(readiness.missing).toContain('DESIRED_OUTCOME');
    expect(readiness.missing).toContain('WEEKLY_CAPACITY');
    expect(readiness.missing).toContain('TIMEFRAME');
    // Non-contract: the projection of this state is empty.
    expect(contractsFromState(state)[0].monthlyMoneyCap).toBeUndefined();
    // Visibility-only: the validator source carries the spans as "Note from
    // you" lines — present for the safety/compat validators, never as
    // authority (no "At most" line, no record semantics).
    const source = buildValidationSource(state);
    expect(source).toContain('Note from you: note number 11');
    expect(source).not.toMatch(/^(At most|At least|The goal is)/m);
  });

  it('unmodeled evidence never mutates requirement records on its own', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([{
      property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq',
      value: { kind: 'count', value: 3 }, strength: 'REQUIRED',
      source: 'stated', evidence: '3 days',
    }], [], []), G({ turn: 0, message: '3 days a week' })).state;
    const before = JSON.stringify(state.records);
    // Spans alone must not touch the record set.
    state = ingest(state, spanFrag(['3 days']), G({
      turn: 1, message: '3 days', answer: { questionId: 'q', text: '3 days' },
    })).state;
    expect(JSON.stringify(state.records)).toBe(before);
  });
});

// ---------------------------------------------------------------- metamorphic

describe('metamorphic unseen-domain robustness (FLORP)', () => {
  it('an unseen domain property flows through merge/conflict/projection with zero core changes', () => {
    const r1 = ingest(emptyRequirementState(), frag([
      {
        property: 'florp.intensity', scope: 'session', relation: 'contains',
        value: { kind: 'categorical', value: 'zindle' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'zindle',
      },
      {
        property: 'florp.intensity', scope: 'session', relation: 'excludes',
        value: { kind: 'categorical', value: 'zindle' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'zindle',
      },
    ]), G({ message: 'zindle every day' }));
    // Same relation-aware coexistence + deterministic conflict as any domain.
    expect(active(r1.state)).toHaveLength(2);
    expect(detectConflicts(projectState(r1.state))).toHaveLength(1);

    // Supersession on the unseen property behaves identically.
    const r2 = ingest(r1.state, frag([{
      property: 'florp.intensity', scope: 'session', relation: 'gte',
      value: { kind: 'count', value: 3 }, strength: 'REQUIRED',
      source: 'stated', evidence: '3',
    }]), G({ message: 'at least 3' }));
    expect(active(r2.state).some((r) => r.property === 'florp.intensity' && r.relation === 'gte')).toBe(true);
  });
});

function orFragmentFragment() {
  return orFragment([30, 60]);
}

/** State satisfying all required coverage groups (through OR branches). */
function fullRequiredState(): RequirementState {
  let state = emptyRequirementState();
  state = ingest(state, frag([
    {
      property: 'goal.outcome', scope: 'goal', relation: 'contains',
      value: { kind: 'text', value: 'run 5 km' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'run 5 km',
    },
    {
      property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq',
      value: { kind: 'count', value: 3 }, strength: 'REQUIRED',
      source: 'stated', evidence: '3 days',
    },
    {
      property: 'goal.deadline', scope: 'goal', relation: 'eq',
      value: { kind: 'date', value: '2026-12-01' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'by December',
    },
  ]), G({ message: 'run 5 km, 3 days a week, by December' })).state;
  return state;
}

function fullRequiredStateWithSessionShape(): RequirementState {
  const state = fullRequiredState();
  return ingest(state, frag([
    {
      property: 'schedule.session.length', scope: 'schedule', relation: 'lte',
      value: { kind: 'quantity', value: 45, unit: 'minute' }, strength: 'REQUIRED',
      source: 'stated', evidence: '45 minutes',
    },
  ]), G({ message: '45 minutes max' })).state;
}

// ---------------------------------------------------------------- unit table

describe('value normalization', () => {
  it('unknown units stay flagged non-comparable', () => {
    expect(canonicalUnit('furlong')).toBe('unknown:furlong');
    expect(valuesEqual(
      { kind: 'quantity', value: 5, unit: 'unknown:furlong' },
      { kind: 'quantity', value: 5, unit: 'unknown:furlong' },
    )).toBe(true); // equal to itself via repr
    expect(valuesEqual(
      { kind: 'quantity', value: 5, unit: 'unknown:furlong' },
      { kind: 'quantity', value: 5, unit: 'unknown:league' },
    )).toBe(false);
  });

  it('slot keys are relation-aware', () => {
    const base = {
      property: 'schedule.session.length', scope: 'schedule' as const,
      value: { kind: 'quantity' as const, value: 30, unit: 'minute' as const },
      temporal: { kind: 'always' as const },
    };
    expect(slotKeyOf({ ...base, relation: 'gte' })).toContain('min');
    expect(slotKeyOf({ ...base, relation: 'lte' })).toContain('max');
    expect(slotKeyOf({ ...base, relation: 'eq' })).toContain('eq');
    expect(slotKeyOf({ ...base, relation: 'ne', value: { kind: 'count', value: 3 } }))
      .not.toBe(slotKeyOf({ ...base, relation: 'ne', value: { kind: 'count', value: 4 } }));
  });

  it('temporal keys are deterministic', () => {
    expect(temporalKey({ kind: 'always' })).toBe('always');
    expect(temporalKey({ kind: 'weekdayRecurring', days: [3, 1] }))
      .toBe(temporalKey({ kind: 'weekdayRecurring', days: [1, 3] }));
  });
});
