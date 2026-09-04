import { groundEvidence, normalizeFragment, normalizeRequirementValue, requirementFragmentSchema, type GroundingContext, type RequirementFragment } from './extract-schema.js';
import { isDayString, todayIn } from '../../domain/dates.js';
import type { NormalizedFragment } from './extract-schema.js';

/**
 * RC-P1-F2: the goal.deadline slot carries one domain rule everywhere — a
 * deadline must be a calendar-real date strictly in the future, observed in
 * the product timezone (the same `todayIn` the draft validator uses). This is
 * the MODEL-extraction channel's copy of the deterministic parser's RC-P1-F
 * gate: an atom that fails it is dropped before it can become authority, so
 * the interview can never close TIMEFRAME with a date the plan validator
 * would silently delete ("interview accepts X / draft deletes X" is the state
 * incoherence RC-P1-F exists to prevent). Dropping — not fabricating a
 * replacement — leaves the gap open for the honest re-ask.
 */
function domainValidAtoms(
  fragment: NormalizedFragment,
  grounding: GroundingContext,
): { atoms: NormalizedFragment['atoms']; andGroups: NormalizedFragment['andGroups']; orGroups: NormalizedFragment['orGroups']; notGroups: NormalizedFragment['notGroups']; conditionalGroups: NormalizedFragment['conditionalGroups'] } {
  const today = todayIn(grounding.timezone ?? 'UTC', new Date(grounding.at));
  const deadlineOk = (atom: { property: string; value: { kind: string; value?: unknown } }): boolean => {
    if (atom.property !== 'goal.deadline') return true;
    if (atom.value.kind !== 'date') return true;
    const value = String(atom.value.value ?? '');
    if (!isDayString(value)) return false;
    return value > today;
  };
  const mapAtoms = (atoms: NormalizedFragment['atoms']) => atoms.filter(deadlineOk);
  return {
    atoms: mapAtoms(fragment.atoms),
    andGroups: fragment.andGroups.map((g) => ({ atoms: mapAtoms(g.atoms) })).filter((g) => g.atoms.length > 0),
    orGroups: fragment.orGroups.map((g) => ({ branches: g.branches.map(mapAtoms) })).filter((g) => g.branches.length > 0),
    notGroups: fragment.notGroups.filter((g) => deadlineOk(g.atom)),
    conditionalGroups: fragment.conditionalGroups
      .map((g) => ({ guard: g.guard, atoms: mapAtoms(g.atoms) }))
      .filter((g) => g.atoms.length > 0),
  };
}
import { ingestFragment, ingestPendingAmbiguity, type MergeEvent, type MergeResult } from './merge.js';
import { emptyRequirementState, type RequirementState } from './types.js';

export * from './types.js';
export {
  groundEvidence,
  groundingSurfaces,
  normalizeForGrounding,
  normalizeFragment,
  normalizeRequirementValue,
  provenanceFor,
  requirementFragmentSchema,
  type GroundingContext,
  type NormalizedCandidate,
  type NormalizedFragment,
  type RawAtom,
  type RequirementFragment,
} from './extract-schema.js';
export {
  ingestFragment,
  ingestPendingAmbiguity,
  resolvePending,
  validateStoredGroups,
  effectiveKeyOfRecord,
  orGroupKeyOf,
  type MergeEvent,
  type MergeResult,
} from './merge.js';
export { detectConflicts, type RequirementConflict } from './conflicts.js';
export { projectState, effectiveExclusions, type ProjectedAtom, type ProjectionView } from './projection.js';
export {
  contractsFromState,
  buildValidationSource,
  projectedValueLabels,
  advisoryLinesFromState,
} from './contract-projection.js';
export {
  coverageGroup,
  evaluateAstReadiness,
  summarizeReadiness,
  toPlanReadiness,
  estimateRemainingAskable,
  hasLoadBearingQuarantine,
  deterministicGapResolution,
  conflictQuestion,
  pendingQuestion,
  stableHash,
  type AstReadiness,
  type CoverageGroupKey,
  type GapSeverity,
  type PendingResolution,
  type RequirementGap,
  type PlanReadiness,
} from './coverage.js';
export { collectAssumptions, renderAssumptionLines, type StructuredAssumption } from './assumptions.js';

// The zod schema lives in extract-schema; re-exported above. This index owns
// the one orchestration entry point the session service calls.

export interface TurnIngestResult {
  state: RequirementState;
  events: MergeEvent[];
}

interface PendingAmbiguityItem {
  property: string;
  scope: 'goal' | 'schedule' | 'session';
  relation: 'eq' | 'ne' | 'in' | 'contains' | 'excludes' | 'gte' | 'lte';
  candidates: RequirementFragment['pendingAmbiguity'][number]['candidates'];
  temporal?: RequirementFragment['pendingAmbiguity'][number]['temporal'];
}

/**
 * Ingest one model extraction turn.
 *
 * A pendingAmbiguity channel is processed BEFORE any merge: ambiguous
 * restatements ("make one of them 45") become PENDING_RESOLUTION state and no
 * authoritative record is touched until the user clarifies. Everything else
 * goes through the deterministic merge + supersession. Grounded
 * unmodeledSpans are appended to the bounded evidence store (visibility
 * data only — never requirement authority).
 */
export function ingestExtraction(
  state: RequirementState,
  fragment: RequirementFragment,
  grounding: GroundingContext,
): TurnIngestResult {
  let current: RequirementState = state;
  const events: MergeEvent[] = [];

  for (const pending of (fragment.pendingAmbiguity ?? []) as PendingAmbiguityItem[]) {
    const result: MergeResult = ingestPendingAmbiguity(current, {
      property: pending.property,
      scope: pending.scope,
      temporal: pending.temporal ?? { kind: 'always' },
      relation: pending.relation,
      candidates: pending.candidates.map(normalizeRequirementValue),
      grounding,
    });
    current = result.state;
    events.push(...result.events);
  }

  const normalized = domainValidAtoms(normalizeFragment(fragment), grounding);
  const merged = ingestFragment(current, { fragment: normalized, grounding });

  // Unmodeled evidence: keep only spans that ground against the CURRENT turn,
  // bounded (≤10 entries, FIFO). Strictly visibility data downstream.
  const groundedSpans = (fragment.unmodeledSpans ?? [])
    .map((span) => groundEvidence(span, grounding))
    .filter((v): v is { grounded: true; source: 'message' | 'answer'; evidence: NonNullable<ReturnType<typeof groundEvidence>['evidence']> } => v.grounded && v.evidence !== null)
    .map((v) => ({
      quote: v.evidence!.quote,
      turn: v.evidence!.turn,
      source: v.evidence!.source,
      at: v.evidence!.at,
    }));
  const prior = current.unmodeledEvidence ?? [];
  const bounded = [...prior, ...groundedSpans].slice(-10);

  return {
    state: {
      ...merged.state,
      unmodeledEvidence: bounded,
      meta: { ...(merged.state.meta ?? {}), lastTurnExtraction: 'ok' },
    },
    events: [...events, ...merged.events],
  };
}

/**
 * Mark the current turn's extraction as failed (provider/repair budget
 * exhausted): the state is STALE for generation until the next successful
 * ingest. No records, groups or evidence are touched.
 */
export function markExtractionFailed(state: RequirementState): RequirementState {
  return { ...state, meta: { ...(state.meta ?? {}), lastTurnExtraction: 'failed' } };
}

export { emptyRequirementState };
export type { RequirementState };
