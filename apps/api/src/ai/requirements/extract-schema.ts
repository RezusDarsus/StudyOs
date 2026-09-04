import { z } from 'zod';
import {
  canonicalUnit,
  type Binding,
  type Evidence,
  type RequirementProvenance,
  type RequirementRecord,
  type RequirementScope,
  type RequirementStrength,
  type RequirementValue,
  type TemporalScope,
  newRequirementId,
  normalizePhaseLabel,
} from './types.js';

// The structure-aware extraction contract (Stage 5).
//
// The model never returns provenance — there is no field for it. Explicitness is
// computed server-side by grounding the evidence quote against the CURRENT user
// turn (message or answer). Anything ungrounded is a model inference, never a
// user statement, and anything the model calls an assumption is stored as
// SYSTEM_ASSUMPTION with the safety decision made later, deterministically.

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const weekdaySetSchema = z.object({
  kind: z.literal('weekdaySet'),
  days: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
});

const requirementValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), value: z.string().trim().min(1).max(120) }),
  z.object({ kind: z.literal('categorical'), value: z.string().trim().min(1).max(60) }),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }),
  z.object({ kind: z.literal('count'), value: z.coerce.number().min(0).max(1_000_000) }),
  z.object({
    kind: z.literal('quantity'),
    value: z.coerce.number().min(0).max(1_000_000),
    unit: z.string().trim().min(1).max(20),
  }),
  z.object({ kind: z.literal('date'), value: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  weekdaySetSchema,
  z.object({ kind: z.literal('timeOfDay'), minutes: z.coerce.number().int().min(0).max(24 * 60) }),
]);

export type RawRequirementValue = z.infer<typeof requirementValueSchema>;

const temporalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }),
  z.object({
    kind: z.literal('dateRange'),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  z.object({ kind: z.literal('phase'), label: z.string().trim().min(1).max(60) }),
  z.object({
    kind: z.literal('weekdayRecurring'),
    days: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
  }),
]);

export type RawTemporal = z.infer<typeof temporalSchema>;

const atomSchema = z.object({
  property: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/, 'property must be a namespaced lowercase key'),
  scope: z.enum(['goal', 'schedule', 'session']),
  relation: z.enum(['eq', 'ne', 'in', 'contains', 'excludes', 'gte', 'lte']),
  value: requirementValueSchema,
  strength: z.enum(['REQUIRED', 'PREFERRED', 'OPTIONAL', 'EXCLUDED']),
  /** 'stated' claims the user said it; 'inferred' admits it did not. */
  source: z.enum(['stated', 'inferred', 'assumption']).default('inferred'),
  temporal: temporalSchema.nullish(),
  /** Optional branch discriminant: {property,value} this atom hangs off. */
  binding: z
    .object({ property: z.string().trim().min(1).max(60), value: requirementValueSchema })
    .nullish(),
  /** Verbatim span of the CURRENT user turn this atom came from. */
  evidence: z.string().trim().min(1).max(400),
  confidence: z.coerce.number().min(0).max(1).nullish(),
});

export type RawAtom = z.infer<typeof atomSchema>;

/**
 * One alternative branch: the atoms that stand or fall together. A branch with
 * exactly one atom is the normal case; the group schema below wraps branches.
 */
const orBranchSchema = z.object({
  atoms: z.array(atomSchema).min(1).max(6),
});
export type RawOrBranch = z.infer<typeof orBranchSchema>;

const groupSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('and'), atoms: z.array(atomSchema).min(1).max(8) }),
  z.object({ kind: z.literal('or'), branches: z.array(orBranchSchema).min(2).max(4) }),
  z.object({ kind: z.literal('not'), atom: atomSchema }),
  z.object({
    kind: z.literal('conditional'),
    guard: z.object({ property: z.string().trim().min(1).max(60), value: requirementValueSchema }),
    atoms: z.array(atomSchema).min(1).max(6),
  }),
]);

export type RawGroup = z.infer<typeof groupSchema>;

/**
 * What the model may send for one turn. Plain atoms and groups can coexist.
 * The schema is deliberately closed: no id, no status, no provenance, no
 * supersession keys — those are all server-owned.
 */
export const requirementFragmentSchema = z
  .object({
    atoms: z.array(atomSchema).max(8).default([]),
    groups: z.array(groupSchema).max(4).default([]),
    /**
     * Safety-relevant context the model deliberately did NOT model as atoms
     * (health conditions, restrictions, constraints it cannot structure).
     * Each span must be a verbatim span of the CURRENT user turn (grounded on
     * ingest, bounds-checked, FIFO-capped) — visibility data only, never
     * requirement authority.
     */
    unmodeledSpans: z.array(z.string().trim().min(1).max(400)).max(10).default([]),
    /**
     * Ambiguous restatements ("make one of them 45"): the user targeted one
     * alternative without saying which. This channel NEVER mutates
     * authoritative state — it becomes PENDING_RESOLUTION until clarified.
     */
    pendingAmbiguity: z
      .array(
        z.object({
          property: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/),
          scope: z.enum(['goal', 'schedule', 'session']),
          relation: z.enum(['eq', 'ne', 'in', 'contains', 'excludes', 'gte', 'lte']),
          candidates: z.array(requirementValueSchema).min(2).max(4),
          temporal: temporalSchema.nullish(),
          evidence: z.string().trim().min(1).max(400),
        }),
      )
      .max(2)
      .default([]),
  })
    .default({ atoms: [], groups: [], pendingAmbiguity: [], unmodeledSpans: [] });

export type RequirementFragment = z.infer<typeof requirementFragmentSchema>;

// ---------------------------------------------------------------- grounding

/** Casefold + collapse whitespace + strip punctuation, for quote matching. */
export function normalizeForGrounding(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface GroundingContext {
  /** The interview turn this extraction belongs to (0 = opening message). */
  turn: number;
  /** The user's current free-text message, when the turn is message-driven. */
  message?: string;
  /** The user's literal answer to the pending question, with its id. */
  answer?: { questionId: string; text: string };
  at: string;
  /**
   * RC-P1-F2 (2026-09-03): the product timezone the deadline domain-validity
   * check observes — the same wall clock the draft validator applies. Absent
   * degrades to UTC. Threading it here lets the ingest layer reject a past
   * deadline from EITHER channel (model extraction as well as the
   * deterministic parser) with one rule, so the interview can never accept a
   * date the downstream plan validator would silently delete.
   */
  timezone?: string;
}

/**
 * The CURRENT user turn's grounded text surfaces, normalized. Evidence is
 * grounded ONLY against these — never against the historical transcript, the
 * stored goal text, or anything earlier (single source of truth, rev.6).
 */
export function groundingSurfaces(ctx: GroundingContext): Array<{ source: Evidence['source']; text: string }> {
  const surfaces: Array<{ source: Evidence['source']; text: string }> = [];
  if (ctx.message) surfaces.push({ source: 'message', text: ctx.message });
  if (ctx.answer) surfaces.push({ source: 'answer', text: ctx.answer.text });
  return surfaces;
}

export interface GroundingVerdict {
  grounded: boolean;
  source: Evidence['source'] | 'none';
  evidence: Evidence | null;
}

/** Ground one quote against the current turn's surfaces. */
export function groundEvidence(quote: string, ctx: GroundingContext): GroundingVerdict {
  const needle = normalizeForGrounding(quote);
  if (!needle) return { grounded: false, source: 'none', evidence: null };
  for (const surface of groundingSurfaces(ctx)) {
    if (normalizeForGrounding(surface.text).includes(needle)) {
      return {
        grounded: true,
        source: surface.source,
        evidence: { quote, turn: ctx.turn, source: surface.source, at: ctx.at },
      };
    }
  }
  return { grounded: false, source: 'none', evidence: null };
}

// ---------------------------------------------------------------- provenance

/**
 * Provenance is decided HERE, from grounding — the model has no vote.
 *
 *   grounded + 'stated'     -> USER_EXPLICIT   (the user said it, in their words)
 *   grounded + 'inferred'   -> USER_INFERRED   (derived from what they just said)
 *   'assumption'            -> SYSTEM_ASSUMPTION (the model admits it is a guess;
 *                              grounding is irrelevant — it is by definition
 *                              NOT the user's words)
 *   ungrounded              -> MODEL_INFERRED  (never user authority, ever)
 */
export function provenanceFor(
  source: 'stated' | 'inferred' | 'assumption',
  verdict: GroundingVerdict,
): RequirementProvenance {
  if (source === 'assumption') return 'SYSTEM_ASSUMPTION';
  if (!verdict.grounded) return 'MODEL_INFERRED';
  if (source === 'stated') return 'USER_EXPLICIT';
  return 'USER_INFERRED';
}

// ---------------------------------------------------------------- normalization

function normalizeValue(raw: RawRequirementValue): RequirementValue {  switch (raw.kind) {
    case 'text':
    case 'categorical':
      return { kind: raw.kind, value: raw.value.trim().toLowerCase() };
    case 'boolean':
      return { kind: raw.kind, value: raw.value };
    case 'count':
      return { kind: raw.kind, value: raw.value };
    case 'quantity':
      return { kind: raw.kind, value: raw.value, unit: canonicalUnit(raw.unit) };
    case 'date':
      return { kind: raw.kind, value: raw.value };
    case 'weekdaySet':
      return { kind: raw.kind, days: [...new Set(raw.days)].sort((a, b) => a - b) };
    case 'timeOfDay':
      return { kind: raw.kind, minutes: raw.minutes };
  }
}

/** Normalized (canonical) requirement value — also used for ambiguity candidates. */
export function normalizeRequirementValue(raw: RawRequirementValue): RequirementValue {
  return normalizeValue(raw);
}

function normalizeTemporal(raw: RawTemporal | null | undefined): TemporalScope {
  if (!raw || raw.kind === 'always') return { kind: 'always' };
  if (raw.kind === 'dateRange') return { kind: 'dateRange', from: raw.from, until: raw.until };
  if (raw.kind === 'phase') return { kind: 'phase', label: normalizePhaseLabel(raw.label) };
  return { kind: 'weekdayRecurring', days: [...new Set(raw.days)].sort((a, b) => a - b) };
}

export interface NormalizedCandidate {
  property: string;
  scope: RequirementScope;
  relation: RawAtom['relation'];
  value: RequirementValue;
  strength: RequirementStrength;
  binding?: Binding;
  temporal: TemporalScope;
  source: 'stated' | 'inferred' | 'assumption';
  evidenceQuote: string;
  confidence?: number;
}

function normalizeAtom(atom: RawAtom): NormalizedCandidate {
  return {
    property: atom.property,
    scope: atom.scope,
    relation: atom.relation,
    value: normalizeValue(atom.value),
    strength: atom.strength,
    binding: atom.binding
      ? { property: atom.binding.property.trim().toLowerCase(), value: normalizeValue(atom.binding.value) }
      : undefined,
    temporal: normalizeTemporal(atom.temporal),
    source: atom.source,
    evidenceQuote: atom.evidence,
    confidence: atom.confidence ?? undefined,
  };
}

export interface NormalizedFragment {
  atoms: NormalizedCandidate[];
  andGroups: Array<{ atoms: NormalizedCandidate[] }>;
  orGroups: Array<{ branches: NormalizedCandidate[][] }>;
  notGroups: Array<{ atom: NormalizedCandidate }>;
  conditionalGroups: Array<{ guard: { property: string; value: RequirementValue }; atoms: NormalizedCandidate[] }>;
}

/** Fully normalized fragment ready for the deterministic merge. */
export function normalizeFragment(fragment: RequirementFragment): NormalizedFragment {
  return {
    atoms: fragment.atoms.map(normalizeAtom),
    andGroups: fragment.groups
      .filter((g): g is Extract<typeof g, { kind: 'and' }> => g.kind === 'and')
      .map((g) => ({ atoms: g.atoms.map(normalizeAtom) })),
    orGroups: fragment.groups
      .filter((g): g is Extract<typeof g, { kind: 'or' }> => g.kind === 'or')
      .map((g) => ({ branches: g.branches.map((b) => b.atoms.map(normalizeAtom)) })),
    notGroups: fragment.groups
      .filter((g): g is Extract<typeof g, { kind: 'not' }> => g.kind === 'not')
      .map((g) => ({ atom: normalizeAtom(g.atom) })),
    conditionalGroups: fragment.groups
      .filter((g): g is Extract<typeof g, { kind: 'conditional' }> => g.kind === 'conditional')
      .map((g) => ({
        guard: { property: g.guard.property.trim().toLowerCase(), value: normalizeValue(g.guard.value) },
        atoms: g.atoms.map(normalizeAtom),
      })),
  };
}

/**
 * Build the record shell for a normalized candidate. Provenance and status are
 * decided here from grounding — the merge never trusts the model for either.
 */
export function buildRecord(
  candidate: NormalizedCandidate,
  ctx: GroundingContext,
  turn: number,
): { record: RequirementRecord; verdict: GroundingVerdict } {
  const verdict = groundEvidence(candidate.evidenceQuote, ctx);
  const now = ctx.at;
  return {
    record: {
      id: newRequirementId('req'),
      property: candidate.property,
      scope: candidate.scope,
      relation: candidate.relation,
      value: candidate.value,
      strength: candidate.strength,
      status: 'ACTIVE',
      provenance: provenanceFor(candidate.source, verdict),
      temporal: candidate.temporal,
      binding: candidate.binding,
      evidence: verdict.evidence,
      confidence: candidate.confidence,
      turn,
      createdAt: now,
      updatedAt: now,
    },
    verdict,
  };
}
