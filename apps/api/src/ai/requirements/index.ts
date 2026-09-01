import { groundEvidence, normalizeFragment, normalizeRequirementValue, requirementFragmentSchema, type GroundingContext, type RequirementFragment } from './extract-schema.js';
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

  const normalized = normalizeFragment(fragment);
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
