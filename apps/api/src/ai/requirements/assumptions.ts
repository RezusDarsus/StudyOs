import { normalizedValueRepr, type RequirementRecord, type RequirementState } from './types.js';

// Structured assumption policy (rev.6).
//
// The only source of an assumption is a record with provenance
// SYSTEM_ASSUMPTION. The merge engine already rejects unsafe assumptions —
// one that would contradict an authoritative USER_EXPLICIT/USER_INFERRED
// record is REJECTED (reason UNSAFE_ASSUMPTION) and never reaches here. So
// everything this module renders is safe by construction, and the safety
// proof is a property of the state, not of the rendering.

export interface StructuredAssumption {
  recordId: string;
  property: string;
  value: string;
  temporal: string;
  /** Always true for anything returned here — unsafe ones were rejected. */
  safe: boolean;
}

function labelOf(record: RequirementRecord): string {
  const repr = normalizedValueRepr(record.value);
  return repr.startsWith('q:') ? repr.slice(2) : repr.replace(/^[a-z]+(:[a-z]+)?:/, '');
}

export function collectAssumptions(state: RequirementState): StructuredAssumption[] {
  return state.records
    .filter((record) => record.status === 'ACTIVE' && record.provenance === 'SYSTEM_ASSUMPTION')
    .map((record) => ({
      recordId: record.id,
      property: record.property,
      value: labelOf(record),
      temporal: record.temporal.kind === 'phase' ? record.temporal.label : '',
      safe: true,
    }));
}

/** The rendered assumption lines for the review screen (cap 6, like legacy). */
export function renderAssumptionLines(state: RequirementState, cap = 6): string[] {
  return collectAssumptions(state)
    .slice(0, cap)
    .map((a) =>
      a.temporal
        ? `${a.property}: ${a.value} during ${a.temporal} (assumed — tell me if wrong)`
        : `${a.property}: ${a.value} (assumed — tell me if wrong)`,
    );
}
