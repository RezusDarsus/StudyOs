import { describe, expect, it } from 'vitest';
import {
  emptyRequirementState,
  ingestExtraction,
  markExtractionFailed,
  projectState,
  requirementFragmentSchema,
  evaluateAstReadiness,
  estimateRemainingAskable,
  deterministicGapResolution,
  detectConflicts,
  buildValidationSource,
  type GroundingContext,
  type RequirementState,
} from './index.js';
import { canForceGenerate, HARD_MAX_QUESTIONS } from '../../services/copilot-session.js';

// Stage 6 completion proofs: the deterministic gap parser, no-fabrication on
// the desired outcome, the stale-extraction containment pins (R1), the force
// policy matrix, the progress estimator, and the open-value metamorphics.
// Every claim here was pinned by Rev.1-Rev.4; these tests are the evidence
// the exit report quotes.

const G = (over: Partial<GroundingContext> = {}): GroundingContext => ({
  turn: 1,
  message: 'the current turn',
  at: '2026-08-31T00:00:00.000Z',
  ...over,
});

const frag = (atoms: unknown[], groups: unknown[] = [], pendingAmbiguity: unknown[] = [], unmodeledSpans: unknown[] = []) =>
  requirementFragmentSchema.parse({ atoms, groups, pendingAmbiguity, unmodeledSpans });

function ingest(state: RequirementState, fragment: ReturnType<typeof frag>, grounding = G()) {
  return ingestExtraction(state, fragment, grounding);
}

const outcomeAtom = (value: string, evidence: string) => ({
  property: 'goal.outcome', scope: 'goal' as const, relation: 'contains' as const,
  value: { kind: 'text' as const, value }, strength: 'REQUIRED' as const,
  source: 'stated' as const, evidence,
});
const freqAtom = (n: number, evidence: string) => ({
  property: 'schedule.frequency.count', scope: 'schedule' as const, relation: 'eq' as const,
  value: { kind: 'count' as const, value: n }, strength: 'REQUIRED' as const,
  source: 'stated' as const, evidence,
});
const deadlineAtom = (date: string, evidence: string) => ({
  property: 'goal.deadline', scope: 'goal' as const, relation: 'eq' as const,
  value: { kind: 'date' as const, value: date }, strength: 'REQUIRED' as const,
  source: 'stated' as const, evidence,
});

// ------------------------------------------------------------- gap parser (Rev.3)

describe('Stage 6: deterministic gap parser — the three registered questions', () => {
  it('gap_weekly_capacity parses an integer 1-7 into an eq frequency atom', () => {
    expect(deterministicGapResolution('gap_weekly_capacity', 3)).toEqual({
      property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq',
      value: { kind: 'count', value: 3 },
    });
    expect(deterministicGapResolution('gap_weekly_capacity', '4 days')).toEqual({
      property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq',
      value: { kind: 'count', value: 4 },
    });
    // Out of contract: never a partial or clamped ingest.
    expect(deterministicGapResolution('gap_weekly_capacity', 0)).toBeNull();
    expect(deterministicGapResolution('gap_weekly_capacity', 8)).toBeNull();
    expect(deterministicGapResolution('gap_weekly_capacity', 'three-ish')).toBeNull();
  });

  it('gap_session_shape parses minutes 5-300; gap_timeframe parses an ISO date', () => {
    expect(deterministicGapResolution('gap_session_shape', 45)).toEqual({
      property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
      value: { kind: 'quantity', value: 45, unit: 'minute' },
    });
    expect(deterministicGapResolution('gap_session_shape', 4)).toBeNull();
    expect(deterministicGapResolution('gap_session_shape', 301)).toBeNull();
    expect(deterministicGapResolution('gap_timeframe', '2026-10-30')).toEqual({
      property: 'goal.deadline', scope: 'goal', relation: 'eq',
      value: { kind: 'date', value: '2026-10-30' },
    });
    // A prose timeframe never fabricates a date.
    expect(deterministicGapResolution('gap_timeframe', 'in two months')).toBeNull();
    expect(deterministicGapResolution('gap_timeframe', '30/02/2026')).toBeNull();
  });

  it('gap_desired_outcome resolves the user\'s literal answer as the outcome (RC-P1-D)', () => {
    // The live defect this pins: the production model emitted ZERO atoms for
    // outcome turns, so the required DESIRED_OUTCOME group could never close
    // and the gate re-asked the same question to the hard cap. The registered
    // contract: the answer IS the outcome, verbatim, in the user's own words.
    expect(deterministicGapResolution('gap_desired_outcome', 'A noticeable improvement in ten weeks')).toEqual({
      property: 'goal.outcome', scope: 'goal', relation: 'contains',
      value: { kind: 'text', value: 'a noticeable improvement in ten weeks' },
    });
    // Out of contract: no fabrication from empty, trivial, or oversized input.
    expect(deterministicGapResolution('gap_desired_outcome', 'ok')).toBeNull();
    expect(deterministicGapResolution('gap_desired_outcome', '   ')).toBeNull();
    expect(deterministicGapResolution('gap_desired_outcome', null)).toBeNull();
    expect(deterministicGapResolution('gap_desired_outcome', 'x'.repeat(401))).toBeNull();
  });

  it('unregistered question ids never resolve — model-free ingestion stays closed', () => {
    // RC-P1-D note: gap_desired_outcome moved from this list to the block
    // above — a documented architecture change, not a silent weakening. It is
    // the ONLY free-text gap question the deterministic gate itself asks as a
    // BLOCKING gap, and its contract (value === the user's answer) is fixed
    // and mechanical. Everything else here stays closed.
    expect(deterministicGapResolution('gap_baseline', 'anything')).toBeNull();
    expect(deterministicGapResolution('gap_preferences', 'anything')).toBeNull();
    expect(deterministicGapResolution('days_per_week', 3)).toBeNull();
    expect(deterministicGapResolution('gap_timeframe', '')).toBeNull();
  });
});

// ------------------------------------------------- desired outcome (no fabrication)

describe('Stage 6: the desired outcome is never fabricated', () => {
  it('no extraction, no answer: readiness reports DESIRED_OUTCOME missing and the gap question asks for it', () => {
    const state = emptyRequirementState();
    const readiness = evaluateAstReadiness(state, { questionCount: 0, maxQuestions: HARD_MAX_QUESTIONS });
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain('DESIRED_OUTCOME');
    expect(readiness.nextQuestion?.id).toBe('gap_desired_outcome');
  });

  it('an ungrounded outcome claim is MODEL_INFERRED and never claims user authority', () => {
    // The model claims an outcome the user never said: the evidence quote is
    // not in the current turn, so it degrades and can never claim user
    // authority — the no-fabrication invariant.
    let state = emptyRequirementState();
    state = ingest(state, frag([{
      property: 'goal.outcome', scope: 'goal', relation: 'contains',
      value: { kind: 'text', value: 'lose weight' }, strength: 'REQUIRED',
      source: 'stated', evidence: 'a quote the user never said',
    }]), G({ turn: 0, message: 'I want to get fitter' })).state;
    const record = state.records.find((r) => r.property === 'goal.outcome')!;
    expect(record.provenance).toBe('MODEL_INFERRED');
    expect(record.evidence).toBeNull();
    // The user-authority set is untouched by the fabrication.
    expect(state.records.some((r) => r.provenance === 'USER_EXPLICIT' && r.property === 'goal.outcome')).toBe(false);
    // And the canonical validator source never renders it as user authority:
    // MODEL_INFERRED atoms are excluded from the authoritative lines.
    expect(buildValidationSource(state)).not.toContain('The goal is');
  });

  it('a grounded outcome claim is USER_EXPLICIT and closes the gap at user authority', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([outcomeAtom('lose weight', 'lose weight')]), G({
      turn: 0, message: 'I want to lose weight',
    })).state;
    const record = state.records.find((r) => r.property === 'goal.outcome')!;
    expect(record.provenance).toBe('USER_EXPLICIT');
    const readiness = evaluateAstReadiness(state, { questionCount: 0, maxQuestions: HARD_MAX_QUESTIONS });
    expect(readiness.missing).not.toContain('DESIRED_OUTCOME');
  });
});

// --------------------------------------------- provenance coverage authority (RC-P1-B)

describe('Stage 6: MODEL_INFERRED cannot satisfy authoritative coverage', () => {
  // The exact live defect: the model "repairs" a placeholder frequency atom by
  // fabricating a number, with its own question as the evidence quote. Ungrounded
  // → MODEL_INFERRED. The provenance hierarchy says that is never user
  // authority; the coverage gate must agree or the hierarchy is cosmetic.
  const fabricatedFrequency = {
    property: 'schedule.frequency.count', scope: 'schedule' as const, relation: 'eq' as const,
    value: { kind: 'count' as const, value: 3 }, strength: 'REQUIRED' as const,
    source: 'stated' as const, evidence: 'How many days per week would you like to read?',
  };

  it('a MODEL_INFERRED atom stays ACTIVE as context but never closes its coverage group', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([fabricatedFrequency]), G({
      turn: 0, message: 'I want to read more',
    })).state;
    const record = state.records.find((r) => r.property === 'schedule.frequency.count')!;
    // The record exists, is ACTIVE, and is honestly labeled — useful context.
    expect(record.status).toBe('ACTIVE');
    expect(record.provenance).toBe('MODEL_INFERRED');
    // But the required WEEKLY_CAPACITY group is still missing: the gate asks.
    const readiness = evaluateAstReadiness(state, { questionCount: 0, maxQuestions: HARD_MAX_QUESTIONS });
    expect(readiness.missing).toContain('WEEKLY_CAPACITY');
    expect(readiness.ready).toBe(false);
    expect(readiness.nextQuestion?.id).toBe('gap_desired_outcome');
  });

  it('control: the SAME atom grounded in the user\'s words is USER_EXPLICIT and DOES close coverage', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([freqAtom(3, 'three days a week')]), G({
      turn: 1, message: 'three days a week suits me',
    })).state;
    const record = state.records.find((r) => r.property === 'schedule.frequency.count')!;
    expect(record.provenance).toBe('USER_EXPLICIT');
    const readiness = evaluateAstReadiness(state, { questionCount: 1, maxQuestions: HARD_MAX_QUESTIONS });
    expect(readiness.missing).not.toContain('WEEKLY_CAPACITY');
  });

  it('no user-authority frequency anywhere + a later genuine answer: the gate still opens exactly then', () => {
    // The fabricated atom first, then the user actually answers the gap
    // question — the grounded answer closes coverage the ungrounded one could not.
    let state = emptyRequirementState();
    state = ingest(state, frag([fabricatedFrequency]), G({
      turn: 0, message: 'I want to read more',
    })).state;
    state = ingest(state, frag([freqAtom(4, '4')]), G({
      turn: 1, answer: { questionId: 'gap_weekly_capacity', text: '4' },
    })).state;
    const readiness = evaluateAstReadiness(state, { questionCount: 1, maxQuestions: HARD_MAX_QUESTIONS });
    expect(readiness.missing).not.toContain('WEEKLY_CAPACITY');
    // The grounded record outranked the fabricated one on the same slot.
    const freq = state.records.filter((r) => r.status === 'ACTIVE' && r.property === 'schedule.frequency.count');
    expect(freq.every((r) => r.provenance === 'USER_EXPLICIT')).toBe(true);
  });

  it('a placeholder value object (kind only) cannot even enter the state — the schema refuses it', () => {
    const result = requirementFragmentSchema.safeParse({
      atoms: [{
        property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq',
        value: { kind: 'count' }, strength: 'REQUIRED', source: 'stated',
        evidence: 'How many days per week would you like to read?',
      }],
    });
    expect(result.success).toBe(false);
  });

  it('asking for a frequency emits no frequency atom: the question itself represents the gap', () => {
    // The post-fix model contract: a valid turn that asks the gap question and
    // extracts only what the user stated (the outcome). No frequency atom.
    let state = emptyRequirementState();
    state = ingest(state, frag([outcomeAtom('read more', 'read more')]), G({
      turn: 0, message: 'I want to read more',
    })).state;
    expect(state.records.some((r) => r.property === 'schedule.frequency.count')).toBe(false);
    const readiness = evaluateAstReadiness(state, { questionCount: 0, maxQuestions: HARD_MAX_QUESTIONS });
    expect(readiness.missing).toContain('WEEKLY_CAPACITY');
    // The stated outcome closed its own group; capacity is the next gap.
    expect(readiness.missing).not.toContain('DESIRED_OUTCOME');
    expect(readiness.nextQuestion?.id).toBe('gap_weekly_capacity');
  });
});

// --------------------------------------------------- stale extraction pins (R1)

describe('Stage 6: stale-extraction containment (R1) — Pin A/B', () => {
  it('Pin A: a failed extraction marks the state stale and generation is refused on it', () => {
    let state = emptyRequirementState();
    state = ingest(state, frag([outcomeAtom('move more', 'move more')]), G({
      turn: 0, message: 'I just want to move more',
    })).state;
    // The next turn's extraction fails provider-side: markExtractionFailed.
    const stale = markExtractionFailed(state);
    expect(stale.meta?.lastTurnExtraction).toBe('failed');
    // Force is unavailable on a stale state, even with the floor met.
    const session = { questionCount: 2, status: 'INTERVIEWING' };
    expect(canForceGenerate(session, stale)).toBe(false);
  });

  it('Pin B: a successful re-ingest clears the stale mark and restores the gate', () => {
    let state: RequirementState = { records: [], groups: [], meta: { lastTurnExtraction: 'failed' } };
    state = ingest(state, frag([freqAtom(3, '3')]), G({
      turn: 1, answer: { questionId: 'gap_weekly_capacity', text: '3' },
    })).state;
    expect(state.meta?.lastTurnExtraction).toBe('ok');
    // The AST gate now sees the fresh answer.
    const readiness = evaluateAstReadiness(state, { questionCount: 1, maxQuestions: HARD_MAX_QUESTIONS });
    expect(readiness.missing).not.toContain('WEEKLY_CAPACITY');
  });
});

// ------------------------------------------------------- force policy (Rev.3/Rev.4)

describe('Stage 6: canForceGenerate policy matrix', () => {
  const baseSession = { questionCount: 3, status: 'INTERVIEWING' };

  const stateWith = (atoms: unknown[], groups: unknown[] = []) => {
    let state = emptyRequirementState();
    state = ingest(state, frag(atoms, groups), G({ turn: 0, message: 'the opening message states everything' })).state;
    return state;
  };

  it('forceEligible: safely incomplete — required coverage missing, nothing unsafe', () => {
    const state = stateWith([]); // nothing extracted
    expect(canForceGenerate(baseSession, state)).toBe(true);
  });

  it('not forceEligible: session already concluded', () => {
    const state = stateWith([]);
    expect(canForceGenerate({ ...baseSession, status: 'READY_TO_GENERATE' }, state)).toBe(false);
  });

  it('not forceEligible: anti-impulse floor (below two questions)', () => {
    const state = stateWith([]);
    expect(canForceGenerate({ questionCount: 1, status: 'INTERVIEWING' }, state)).toBe(false);
    expect(canForceGenerate({ questionCount: 0, status: 'INTERVIEWING' }, state)).toBe(false);
  });

  it('not forceEligible: unresolved conflict — a crafted force request cannot bypass it', () => {
    // A real inverted range (gte 5 + lte 2 on one property): the engine's
    // pinned conflict shape.
    const state = stateWith([
      { property: 'schedule.frequency.count', scope: 'schedule', relation: 'gte',
        value: { kind: 'count', value: 5 }, strength: 'REQUIRED', source: 'stated', evidence: 'at least 5' },
      { property: 'schedule.frequency.count', scope: 'schedule', relation: 'lte',
        value: { kind: 'count', value: 2 }, strength: 'REQUIRED', source: 'stated', evidence: 'at most 2' },
    ]);
    const readiness = evaluateAstReadiness(state, { questionCount: 3, maxQuestions: HARD_MAX_QUESTIONS });
    expect(readiness.conflicts.length).toBeGreaterThan(0);
    expect(canForceGenerate(baseSession, state)).toBe(false);
  });

  it('not forceEligible: pending ambiguity resolution', () => {
    const state = stateWith([], [
      { kind: 'or', branches: [
        { atoms: [{ property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
          value: { kind: 'quantity', value: 30, unit: 'minute' }, strength: 'REQUIRED', source: 'stated', evidence: '30 minutes' }] },
        { atoms: [{ property: 'schedule.session.length', scope: 'schedule', relation: 'eq',
          value: { kind: 'quantity', value: 60, unit: 'minute' }, strength: 'REQUIRED', source: 'stated', evidence: '60 minutes' }] },
      ] },
    ]);
    // An ambiguous restatement turns the group pending.
    const pending = ingestExtraction(state, requirementFragmentSchema.parse({
      atoms: [], groups: [],
      pendingAmbiguity: [{
        property: 'schedule.session.length', scope: 'session', relation: 'eq',
        candidates: [{ kind: 'quantity', value: 45, unit: 'minute' }, { kind: 'quantity', value: 60, unit: 'minute' }],
        evidence: 'make one of them 45',
      }],
    }), G({ turn: 2, message: 'make one of them 45' })).state;
    const readiness = evaluateAstReadiness(pending, { questionCount: 3, maxQuestions: HARD_MAX_QUESTIONS });
    expect(readiness.pending.length).toBeGreaterThan(0);
    expect(canForceGenerate(baseSession, pending)).toBe(false);
  });

  it('not forceEligible: stale state (R1) — repeated from Pin A as the bypass guard', () => {
    const state: RequirementState = {
      records: [], groups: [], meta: { lastTurnExtraction: 'failed' },
    };
    expect(canForceGenerate(baseSession, state)).toBe(false);
  });
});

// --------------------------------------------------- progress estimation (Rev.4)

describe('Stage 6: progress estimation — dedupe, clamp, readiness-independence', () => {
  it('counts DISTINCT askable clarifications by question id, never raw blockers', () => {
    const state = emptyRequirementState(); // nothing known
    const readiness = evaluateAstReadiness(state, { questionCount: 0, maxQuestions: HARD_MAX_QUESTIONS });
    // Raw blockers: 3 required gaps — but distinct question ids are exactly
    // the 3 BLOCKING ones (conflicts/pending are empty here).
    expect(readiness.gaps.filter((g) => g.severity === 'BLOCKING')).toHaveLength(3);
    const ids = new Set(readiness.gaps.filter((g) => g.severity === 'BLOCKING' || g.severity === 'HIGH').map((g) => g.question.id));
    expect(estimateRemainingAskable(readiness, 0, HARD_MAX_QUESTIONS)).toBe(Math.min(ids.size, HARD_MAX_QUESTIONS));
  });

  it('clamps to the remaining HARD_MAX budget', () => {
    const state = emptyRequirementState();
    const readiness = evaluateAstReadiness(state, { questionCount: 0, maxQuestions: HARD_MAX_QUESTIONS });
    // 9 questions already spent: at most 1 more may be asked.
    expect(estimateRemainingAskable(readiness, 9, HARD_MAX_QUESTIONS)).toBe(1);
    expect(estimateRemainingAskable(readiness, 10, HARD_MAX_QUESTIONS)).toBe(0);
    expect(estimateRemainingAskable(readiness, 12, HARD_MAX_QUESTIONS)).toBe(0); // never negative
  });

  it('is purely presentational: it never flips readiness or force', () => {
    const state = emptyRequirementState();
    const before = evaluateAstReadiness(state, { questionCount: 2, maxQuestions: HARD_MAX_QUESTIONS });
    const remaining = estimateRemainingAskable(before, 2, HARD_MAX_QUESTIONS);
    expect(remaining).toBeGreaterThan(0);
    // The estimate did not touch the gate's own verdicts.
    const after = evaluateAstReadiness(state, { questionCount: 2, maxQuestions: HARD_MAX_QUESTIONS });
    expect(after.ready).toBe(before.ready);
    expect(after.missing).toEqual(before.missing);
    expect(after.conflicts).toEqual(before.conflicts);
    expect(canForceGenerate({ questionCount: 2, status: 'INTERVIEWING' }, state)).toBe(true);
  });
});

// ------------------------------------------- open-value metamorphics (11 domains)

describe('Stage 6: open-value metamorphic robustness across 11 domains', () => {
  const DOMAINS = [
    'fitness.planning', 'education.language', 'finance.saving', 'health.nutrition',
    'craft.pottery', 'career.interview', 'travel.japan', 'music.guitar',
    'home.garden', 'tech.opensource', 'art.painting',
  ] as const;

  it('the same mechanic on 11 unseen domain properties: eq values supersede, coverage closes, conflicts fire — zero core changes', () => {
    for (const [index, domain] of DOMAINS.entries()) {
      let state = emptyRequirementState();
      const evidence = `${domain} target`;
      state = ingest(state, frag([
        { property: `${domain}.target`, scope: 'goal', relation: 'eq',
          value: { kind: 'text', value: 'first target' }, strength: 'REQUIRED',
          source: 'stated', evidence },
        { property: `${domain}.target`, scope: 'goal', relation: 'contains',
          value: { kind: 'text', value: 'and a second facet' }, strength: 'REQUIRED',
          source: 'stated', evidence: 'and a second facet' },
      ]), G({ turn: 0, message: `I want a first target and a second facet (${evidence})` })).state;

      // Metamorphic rule 1: eq is a replacement slot — a new eq value on the
      // same property supersedes; contains is value-scoped and coexists.
      state = ingest(state, frag([
        { property: `${domain}.target`, scope: 'goal', relation: 'eq',
          value: { kind: 'text', value: 'corrected target' }, strength: 'REQUIRED',
          source: 'stated', evidence: 'corrected target' },
      ]), G({ turn: 1, message: 'actually, corrected target' })).state;
      const eqActive = state.records.filter(
        (r) => r.status === 'ACTIVE' && r.property === `${domain}.target` && r.relation === 'eq',
      );
      expect(eqActive, domain).toHaveLength(1);
      expect((eqActive[0].value as { value: string }).value, domain).toBe('corrected target');

      // Metamorphic rule 2: the supersession keyed correctly on the unseen
      // property — the projection carries exactly one eq atom and the
      // contains atom coexists (value-scoped slot).
      const view = projectState(state);
      const eqAtoms = view.atoms.filter(
        (a) => a.record.property === `${domain}.target` && a.record.relation === 'eq',
      );
      expect(eqAtoms, domain).toHaveLength(1);
      expect((eqAtoms[0].record.value as { value: string }).value, domain).toBe('corrected target');
      const containsAtoms = view.atoms.filter(
        (a) => a.record.property === `${domain}.target` && a.record.relation === 'contains',
      );
      expect(containsAtoms, domain).toHaveLength(1);

      // Metamorphic rule 3: a min/max contradiction on the unseen property is
      // a deterministic conflict (gte/lte slots coexist, then conflict).
      const contradictionState = ingest(state, frag([
        { property: `${domain}.load`, scope: 'session', relation: 'gte',
          value: { kind: 'count', value: 5 }, strength: 'REQUIRED',
          source: 'stated', evidence: 'at least 5' },
        { property: `${domain}.load`, scope: 'session', relation: 'lte',
          value: { kind: 'count', value: 2 }, strength: 'REQUIRED',
          source: 'stated', evidence: 'at most 2' },
      ]), G({ turn: 3, message: 'at least 5 but at most 2' })).state;
      const minActive = contradictionState.records.find(
        (r) => r.status === 'ACTIVE' && r.property === `${domain}.load` && r.relation === 'gte',
      );
      const maxActive = contradictionState.records.find(
        (r) => r.status === 'ACTIVE' && r.property === `${domain}.load` && r.relation === 'lte',
      );
      expect(minActive && maxActive, domain).toBeTruthy();
      const conflictView = {
        atoms: [
          { record: minActive!, negated: false },
          { record: maxActive!, negated: false },
        ],
      } as Parameters<typeof detectConflicts>[0];
      expect(detectConflicts(conflictView), domain).toHaveLength(1);
    }
  });
});
