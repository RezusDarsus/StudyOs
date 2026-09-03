import type { CopilotQuestion } from '../schemas.js';
import { isDayString, todayIn } from '../../domain/dates.js';
import {
  isAuthoritativeRecord,
  temporalKey,
  normalizedValueRepr,
  type RequirementRecord,
  type RequirementState,
} from './types.js';
import { projectState, type ProjectionView } from './projection.js';
import { detectConflicts, type RequirementConflict } from './conflicts.js';

// Coverage groups + the gap engine (rev.6, Stage-6 canonical readiness).
//
// Coverage is about SHAPE, never domain words: a session satisfies a group
// when authoritative atoms exist on the group's property families. That is
// what makes the pipeline metamorphically safe — an unseen domain flows
// through the same mechanics with zero core modification.
//
// The gate owns three distinct outputs that must never be conflated:
//   ready       — no BLOCKING gap: the plan may be generated
//   shouldAsk   — AST policy: ready AND a HIGH gap AND budget remains
//   forceEligible — force-generation policy: NOT ready, but nothing that
//                 makes an incomplete plan unsafe (no confirmed conflict, no
//                 pending resolution, no load-bearing quarantine); safety and
//                 contract gates always run after the claim and are never
//                 bypassed by force.

export type CoverageGroupKey =
  | 'DESIRED_OUTCOME'
  | 'WEEKLY_CAPACITY'
  | 'TIMEFRAME'
  | 'SESSION_SHAPE'
  | 'BASELINE'
  | 'CONSTRAINTS'
  | 'PREFERENCES';

export type GapSeverity = 'BLOCKING' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface CoverageGroup {
  key: CoverageGroupKey;
  requirement: 'required' | 'high' | 'medium' | 'low';
  /** Presence (or scoping) atoms on these property families satisfy the group. */
  propertyPatterns: RegExp[];
  /** Any effective exclusion satisfies the group (CONSTRAINTS). */
  anyExclusionSatisfies?: boolean;
  question: Omit<CopilotQuestion, 'id'> & { id: string };
}

const COVERAGE_GROUPS: CoverageGroup[] = [
  {
    key: 'DESIRED_OUTCOME',
    requirement: 'required',
    propertyPatterns: [/^goal\.outcome/, /^goal\.target/, /^session\.activity/],
    question: {
      id: 'gap_desired_outcome',
      type: 'FREE_TEXT',
      prompt: 'What concrete result would tell you this goal is done?',
      allowCustomAnswer: true,
      optional: false,
    },
  },
  {
    key: 'WEEKLY_CAPACITY',
    requirement: 'required',
    propertyPatterns: [/^schedule\.frequency/, /^schedule\.days/, /^schedule\.session/],
    question: {
      id: 'gap_weekly_capacity',
      type: 'NUMBER',
      prompt: 'How many days per week can you realistically commit?',
      allowCustomAnswer: true,
      optional: false,
      unit: 'days/week',
    },
  },
  {
    key: 'TIMEFRAME',
    requirement: 'required',
    propertyPatterns: [/^goal\.deadline/],
    question: {
      id: 'gap_timeframe',
      type: 'DATE',
      prompt: 'By when do you want to reach it?',
      allowCustomAnswer: true,
      optional: false,
    },
  },
  {
    key: 'SESSION_SHAPE',
    requirement: 'high',
    propertyPatterns: [/^schedule\.session\.length/, /^schedule\.duration/],
    question: {
      id: 'gap_session_shape',
      type: 'NUMBER',
      prompt: 'How long should a typical session be, in minutes?',
      allowCustomAnswer: true,
      optional: true,
      unit: 'minutes',
    },
  },
  {
    key: 'BASELINE',
    requirement: 'medium',
    propertyPatterns: [/^goal\.baseline/],
    question: {
      id: 'gap_baseline',
      type: 'FREE_TEXT',
      prompt: 'Where are you starting from with this today?',
      allowCustomAnswer: true,
      optional: true,
    },
  },
  {
    key: 'CONSTRAINTS',
    requirement: 'medium',
    propertyPatterns: [],
    anyExclusionSatisfies: true,
    question: {
      id: 'gap_constraints',
      type: 'FREE_TEXT',
      prompt: 'Anything the plan should avoid or work around?',
      allowCustomAnswer: true,
      optional: true,
    },
  },
  {
    key: 'PREFERENCES',
    requirement: 'medium',
    propertyPatterns: [/^preference\./],
    question: {
      id: 'gap_preferences',
      type: 'FREE_TEXT',
      prompt: 'Any preferences for how the sessions should run?',
      allowCustomAnswer: true,
      optional: true,
    },
  },
];

export function coverageGroup(key: CoverageGroupKey): CoverageGroup {
  const group = COVERAGE_GROUPS.find((g) => g.key === key);
  if (!group) throw new Error(`unknown coverage group: ${key}`);
  return group;
}

export interface RequirementGap {
  groupKey: CoverageGroupKey;
  severity: GapSeverity;
  /** The deterministic question that resolves this gap. */
  question: CopilotQuestion;
}

export interface PendingResolution {
  groupKey: string;
  property: string;
  candidates: string[];
}

export interface AstReadiness {
  /** No BLOCKING gaps — the plan may be generated. */
  ready: boolean;
  /** Same gate the generate route enforces. */
  canGenerate: boolean;
  /**
   * ready AND high-value gaps remain AND the question budget has room.
   * Deliberately separate from ready: readiness is about what is KNOWN,
   * shouldAsk is about whether one more question is still worth asking.
   */
  shouldAsk: boolean;
  /**
   * Force-generation policy: NOT ready, but nothing that makes an incomplete
   * plan unsafe (no confirmed conflict, no pending resolution, no
   * load-bearing quarantine). Same predicate for the returned `canForce` and
   * the accepted-force rule in the generate route. Post-claim safety,
   * feasibility and contract gates always run and are never bypassed.
   */
  forceEligible: boolean;
  confidence: number;
  missing: CoverageGroupKey[];
  gaps: RequirementGap[];
  conflicts: RequirementConflict[];
  pending: PendingResolution[];
  /** The single deterministic question for the top-priority open item. */
  nextQuestion: CopilotQuestion | null;
}

/** The readiness shape the API surface carries (Stage-4 consumers unchanged). */
export interface PlanReadiness {
  ready: boolean;
  /** Unsatisfied coverage groups: blocking ones first, then the rest. */
  missing: CoverageGroupKey[];
  /** satisfied/total, rounded to two decimals — a progress signal for the UI. */
  confidence: number;
}

/**
 * Load-bearing quarantine: an ACTIVE record whose only structure is a
 * QUARANTINED group — semantic content the user stated that is currently
 * invisible. Force must not produce a plan while that is unresolved.
 */
export function hasLoadBearingQuarantine(state: RequirementState): boolean {
  const activeParents = new Map<string, number>();
  const quarantinedOnly = new Set<string>();
  for (const group of state.groups) {
    for (const child of group.children) {
      if (child.kind !== 'atom') continue;
      if (group.status === 'QUARANTINED') quarantinedOnly.add(child.id);
      else if (group.status === 'ACTIVE') activeParents.set(child.id, (activeParents.get(child.id) ?? 0) + 1);
    }
  }
  for (const id of quarantinedOnly) {
    if ((activeParents.get(id) ?? 0) === 0) {
      const record = state.records.find((r) => r.id === id);
      if (record && isAuthoritativeRecord(record)) return true;
    }
  }
  return false;
}

function valueLabelOf(record: RequirementRecord): string {
  const repr = normalizedValueRepr(record.value);
  return repr.startsWith('q:') ? repr.slice(2) : repr.replace(/^[a-z]+(:[a-z]+)?:/, '');
}

/**
 * The provenance an atom needs before it may close a coverage group.
 *
 * MODEL_INFERRED is an ungrounded claim — the model asserting something the
 * user never said. It never claims user authority anywhere else (validation
 * lines, contract projection), and coverage is no exception: a fabricated
 * frequency with the model's own question as "evidence" must not close
 * WEEKLY_CAPACITY. STORED_CONTEXT and SYSTEM_ASSUMPTION keep their existing
 * behavior — the demonstrated leak was MODEL_INFERRED only, and reopening
 * their policy is not this fix.
 */
function mayCloseCoverage(record: RequirementRecord): boolean {
  return record.provenance !== 'MODEL_INFERRED';
}

function satisfiesGroup(group: CoverageGroup, view: ProjectionView): boolean {
  for (const atom of view.atoms) {
    const { record } = atom;
    if (atom.negated) continue;
    if (!mayCloseCoverage(record)) continue;
    if (group.propertyPatterns.some((pattern) => pattern.test(record.property))) return true;
  }
  return false;
}

/** Deterministic stable hash for question ids. */
export function stableHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export function conflictQuestion(conflicts: RequirementConflict[]): CopilotQuestion {
  const first = conflicts[0];
  return {
    id: `resolve_requirement_conflict_${stableHash(`${first.kind}|${first.property}|${first.recordA}|${first.recordB}`)}`,
    type: 'FREE_TEXT',
    prompt: `I have both sides of a contradiction: ${first.description}. Which one should the plan follow?`,
    allowCustomAnswer: true,
    optional: false,
  };
}

export function pendingQuestion(pending: PendingResolution[]): CopilotQuestion | null {
  const first = pending[0];
  if (!first) return null;
  if (first.candidates.length < 2) {
    return {
      id: `resolve_requirement_pending_${stableHash(first.groupKey)}`,
      type: 'FREE_TEXT',
      prompt: 'Which of the options you mentioned should the plan use?',
      allowCustomAnswer: true,
      optional: false,
    };
  }
  return {
    id: `resolve_requirement_pending_${stableHash(first.groupKey)}`,
    type: 'SINGLE_SELECT',
    prompt: 'You mentioned more than one option — which one should the plan use?',
    options: first.candidates,
    allowCustomAnswer: true,
    optional: false,
  };
}

/**
 * The AST-driven readiness gate (rev.6).
 *
 * BLOCKING (unresolved conflicts, pending resolutions, missing required
 * coverage) — cannot generate. HIGH gaps with question budget left — should
 * ask (but generation is not blocked). MEDIUM/LOW — advisory only.
 */
export function evaluateAstReadiness(
  state: RequirementState,
  opts: { questionCount: number; maxQuestions: number },
): AstReadiness {
  const view = projectState(state);
  const conflicts = detectConflicts(view);

  const pending: PendingResolution[] = view.pendingGroups.map((group) => {
    const records = group.children
      .map((child) => state.records.find((r) => r.id === child.id))
      .filter((r): r is RequirementRecord => !!r);
    return {
      groupKey: group.groupKey,
      property: records[0]?.property ?? '',
      candidates: records.map((r) => valueLabelOf(r)),
    };
  });

  const gaps: RequirementGap[] = [];
  const missing: CoverageGroupKey[] = [];
  for (const group of COVERAGE_GROUPS) {
    const satisfied = satisfiesGroup(group, view)
      || (group.anyExclusionSatisfies === true && view.atoms.some((a) => a.record.relation === 'excludes' && !a.negated));
    if (satisfied) continue;
    missing.push(group.key);
    const severity: GapSeverity =
      group.requirement === 'required'
        ? 'BLOCKING'
        : group.requirement === 'high'
          ? 'HIGH'
          : group.requirement === 'medium'
            ? 'MEDIUM'
            : 'LOW';
    gaps.push({ groupKey: group.key, severity, question: group.question });
  }

  const blocking =
    conflicts.length > 0 || pending.length > 0 || gaps.some((gap) => gap.severity === 'BLOCKING');
  const ready = !blocking;
  const budgetLeft = opts.questionCount < Math.max(0, opts.maxQuestions);
  const shouldAsk = ready && gaps.some((gap) => gap.severity === 'HIGH') && budgetLeft;
  // Force policy: an unfinished interview may be forced only when nothing
  // makes an incomplete plan unsafe. Confirmed conflicts, pending
  // resolutions and load-bearing quarantines all veto force; safety,
  // feasibility and contract gates run after the claim regardless.
  const forceEligible =
    !ready &&
    conflicts.length === 0 &&
    pending.length === 0 &&
    !hasLoadBearingQuarantine(state);

  const nextQuestion = conflicts.length
    ? conflictQuestion(conflicts)
    : pending.length
      ? pendingQuestion(pending)
      : gaps.find((gap) => gap.severity === 'BLOCKING' || gap.severity === 'HIGH')?.question ?? null;

  const total = COVERAGE_GROUPS.length;
  const known = total - missing.length;
  return {
    ready,
    canGenerate: ready,
    shouldAsk,
    forceEligible,
    confidence: Math.round((known / total) * 100) / 100,
    missing,
    gaps,
    conflicts,
    pending,
    nextQuestion,
  };
}

/** The API-facing readiness view (readiness ≠ question count, by construction). */
export function toPlanReadiness(readiness: AstReadiness): PlanReadiness {
  return { ready: readiness.ready, missing: readiness.missing, confidence: readiness.confidence };
}

/**
 * Rev.4 progress estimation: the number of distinct clarifications the gate
 * would still ask, deduplicated by deterministic question id, clamped to the
 * remaining HARD_MAX budget. Purely presentational — never readiness.
 */
export function estimateRemainingAskable(
  readiness: AstReadiness,
  questionCount: number,
  hardMax: number,
): number {
  const ids = new Set<string>();
  // Conflicts: one clarification per distinct conflict-question id.
  for (const conflict of readiness.conflicts) {
    ids.add(conflictQuestion([conflict]).id);
  }
  for (const pendingGroup of readiness.pending) {
    const question = pendingQuestion([pendingGroup]);
    if (question) ids.add(question.id);
  }
  for (const gap of readiness.gaps) {
    if (gap.severity === 'BLOCKING' || gap.severity === 'HIGH') ids.add(gap.question.id);
  }
  return Math.max(0, Math.min(ids.size, hardMax - questionCount));
}

/** Compact summary for API responses and tests. */
export function summarizeReadiness(state: RequirementState, opts: { questionCount: number; maxQuestions: number }) {
  const readiness = evaluateAstReadiness(state, opts);
  return {
    ready: readiness.ready,
    shouldAsk: readiness.shouldAsk,
    confidence: readiness.confidence,
    missing: readiness.missing,
    conflicts: readiness.conflicts.map((c) => ({ kind: c.kind, description: c.description })),
    pending: readiness.pending,
  };
}

/** The temporal family of a record, for question building. */
export function temporalLabel(state: RequirementState, recordId: string): string {
  const record = state.records.find((r) => r.id === recordId);
  if (!record) return '';
  const key = temporalKey(record.temporal);
  return key === 'always' ? '' : key.replace(/^phase:/, '');
}

// ------------------------------------------------- deterministic gap resolution
//
// Rev.3: model-free ingestion exists ONLY for semantically fixed structured
// answers — the registered gap questions below. The contract of each
// registered question is fixed and mechanical: the answer maps to an atom
// without interpretation, or the question does not resolve (nothing is ever
// fabricated, clamped, or guessed). Conflict/pending clarifications always
// require free-text extraction; on provider failure they take the stale-AST
// containment path instead.
//
// RC-P1-D (2026-09-02): gap_desired_outcome is registered because the live
// production model (nemotron-3.5-lightning-30b-a3b) empirically emits ZERO
// requirement atoms for this turn shape (reproduced across old and new prompt
// wording, opening messages and answer turns) while the AST gate REQUIRES
// DESIRED_OUTCOME to close before generate. The result was a livelock: the
// gate re-asked gap_desired_outcome until the hard cap with no atom ever
// landing. The fixed contract here — the user's trimmed, non-trivial answer
// IS the outcome, verbatim, in their own words — is exactly the mechanical
// shape this mechanism exists for, and it fabricates nothing: the value is
// the user's literal answer text.

export interface GapResolutionCandidate {
  property: string;
  scope: RequirementRecord['scope'];
  relation: RequirementRecord['relation'];
  value: RequirementValue2;
}

type RequirementValue2 = RequirementRecord['value'];

/**
 * The only answer shape a deterministic numeric slot may accept: a BARE
 * integer, with nothing else. (RC-P1-G, the lossless-parsing rule.)
 *
 * parseInt-style prefix parsing collapsed "5-6" into exactly 5 and "30-40"
 * into exactly 30 — silent semantic corruption of a user-stated constraint.
 * A number carrying ANY other semantics (a range, a bound, a hedge, trailing
 * words, a unit) is not deterministically parseable: the parser returns null
 * and the answer takes the extraction/clarification path instead. The parser
 * accepts only what it can preserve exactly.
 */
function bareIntegerOf(answer: unknown): number | null {
  if (typeof answer === 'number' && Number.isInteger(answer)) return answer;
  if (typeof answer !== 'string') return null;
  const text = answer.trim();
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** The minimum length an outcome answer must have to be a real answer. */
const MIN_OUTCOME_LENGTH = 3;

/**
 * Parse a structured answer to one of the registered gap questions.
 * Returns null when the id is not registered or the answer does not satisfy
 * the question's fixed contract.
 *
 * `now`/`timezone` (RC-P1-F): the timeframe answer must satisfy the SAME
 * domain validity the downstream draft validator enforces — a calendar-real
 * date strictly in the future, observed in the user's timezone, the same
 * `todayIn` the draft uses. A date that would be silently deleted at draft
 * time must never close TIMEFRAME at interview time; the gate re-asks with
 * the correction instead. When the caller supplies no clock the resolver
 * degrades to UTC "now" — still calendar-valid and future-checked.
 */
export function deterministicGapResolution(
  questionId: string,
  answer: unknown,
  opts: { now?: Date; timezone?: string } = {},
): GapResolutionCandidate | null {
  if (questionId === 'gap_weekly_capacity') {
    // RC-P1-G: only a bare exact integer is an exact frequency. "5-6",
    // "about 5", "at least 5", "5+" and friends carry semantics this slot
    // cannot represent exactly, so they never ingest deterministically.
    const n = bareIntegerOf(answer);
    if (n === null || n < 1 || n > 7) return null;
    return { property: 'schedule.frequency.count', scope: 'schedule', relation: 'eq', value: { kind: 'count', value: n } };
  }
  if (questionId === 'gap_session_shape') {
    // RC-P1-G: same lossless rule — "30-40" is a range, never exactly 30.
    const n = bareIntegerOf(answer);
    if (n === null || n < 5 || n > 300) return null;
    return { property: 'schedule.session.length', scope: 'schedule', relation: 'eq', value: { kind: 'quantity', value: n, unit: 'minute' } };
  }
  if (questionId === 'gap_timeframe') {
    const text = String(answer ?? '').trim();
    // Calendar-real date first: 2026-02-30 and 2026-13-01 never resolve
    // (isDayString probes the actual calendar, not the regex shape).
    if (!isDayString(text)) return null;
    // RC-P1-F domain validity: the same rule the draft validator applies —
    // a deadline must be strictly in the future, observed in the product
    // timezone. Today itself is INVALID (a "deadline" of today is already
    // over at plan time); the draft deletes `deadline <= today`, so the
    // interview must not accept it as authoritative either.
    const today = todayIn(opts.timezone ?? 'UTC', opts.now ?? new Date());
    if (text <= today) return null;
    return { property: 'goal.deadline', scope: 'goal', relation: 'eq', value: { kind: 'date', value: text } };
  }
  if (questionId === 'gap_desired_outcome') {
    // The user's own words, verbatim and trimmed — the literal answer is the
    // outcome. Never a model summary, never a fabrication: value === answer.
    const text = String(answer ?? '').trim();
    if (text.length < MIN_OUTCOME_LENGTH || text.length > 400) return null;
    return { property: 'goal.outcome', scope: 'goal', relation: 'contains', value: { kind: 'text', value: text.toLowerCase() } };
  }
  return null;
}
