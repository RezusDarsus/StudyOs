import type { ConstraintContract } from '../constraint-contract.js';
import { canonicalWeekdayOrder, type SemanticTaskRole } from '../goal-constraints.js';
import { projectState, type ProjectedAtom } from './projection.js';
import { normalizeQuantity, normalizedValueRepr, type RequirementRecord, type RequirementState } from './types.js';

// AST -> ConstraintContract projection (rev.6).
//
// The contract is built from ACTIVE AST evidence only — never by re-parsing
// the goal text or the transcript. OR groups become contract VARIANTS: a draft
// satisfies the projection when it satisfies the base contract together with
// ONE branch of every OR group ("30 or 60 minutes" accepts either).
//
// Field inventory (verification pass):
//   PROJECTED_FROM_AST: exactWeekly, maxWeekly, requiredWeekdays,
//     excludedWeekdays, allowedWeekdays, cadence (derived), roleMinWeekly,
//     roleDays, monthly.intervalMonths/dayOfMonth, excludedMonths, deadline,
//     monthlyMoneyCap, maxMinutesPerSession, maxWeeklyMinutes,
//     totalWeeklyOccurrences, prohibitConsecutiveEvenings, undefinedMetric,
//     forbiddenActivities.
//   INTENTIONALLY_ADVISORY (surfaced via advisoryLinesFromState, never
//     silently dropped): monthlyPhases (a bounded phase binds a date range,
//     an amount AND a currency — no single-atom deterministic form), and the
//     exchange-rate assumption (requires the cross-currency financial
//     computation the AST does not perform).
//   LEGACY_ONLY: none. Every deterministic planning constraint is either
//     projected or surfaced.

/** Cap on OR-variant combinations — a mechanic, not a semantic limit. */
const MAX_OR_COMBINATIONS = 8;

/** The checker's closed role set — an open AST property cannot invent one. */
const ROLE_KEYS: Record<string, SemanticTaskRole> = {
  strength: 'STRENGTH',
  trail: 'TRAIL',
  long_run: 'LONG_RUN',
  finance_transfer: 'FINANCE_TRANSFER',
  interview_prep: 'INTERVIEW_PREP',
};

const MONTH_TEXT_RE = /^\d{4}-\d{2}$/;

function minutesOf(record: RequirementRecord): number | null {
  if (record.value.kind === 'quantity') {
    const norm = normalizeQuantity(record.value.value, record.value.unit);
    return norm.comparable && (norm.unit as string) === 'time' ? norm.value : null;
  }
  if (record.value.kind === 'count') return record.value.value;
  return null;
}

function moneyOf(record: RequirementRecord): number | null {
  if (record.value.kind === 'quantity') {
    const norm = normalizeQuantity(record.value.value, record.value.unit);
    return norm.comparable && (norm.unit as string) === 'money' ? norm.value : null;
  }
  return null;
}

function daysOf(record: RequirementRecord): number[] | null {
  if (record.value.kind === 'weekdaySet') return [...record.value.days];
  return null;
}

function textOf(record: RequirementRecord): string | null {
  if (record.value.kind === 'text' || record.value.kind === 'categorical') return record.value.value;
  return null;
}

function countOf(record: RequirementRecord): number | null {
  if (record.value.kind === 'count') return record.value.value;
  return null;
}

/** Canonical role for a `role.<name>.*` property, or null when unknown. */
function roleOf(property: string): SemanticTaskRole | null {
  const match = property.match(/^role\.([a-z_]+)\./);
  if (!match) return null;
  return ROLE_KEYS[match[1]] ?? null;
}

/** Build one contract from a chosen set of projected atoms (one per OR branch slot). */
function buildOneContract(atoms: ProjectedAtom[]): ConstraintContract {
  let exactWeekly: number | undefined;
  let maxWeekly: number | undefined;
  const requiredWeekdays: number[] = [];
  const excludedWeekdays: number[] = [];
  let allowedWeekdays: number[] | undefined;
  let maxMinutesPerSession: number | undefined;
  let maxWeeklyMinutes: number | undefined;
  let deadline: string | undefined;
  let monthlyMoneyCap: number | undefined;
  const forbiddenActivities: string[] = [];
  const roleMinWeekly: ConstraintContract['roleMinWeekly'] = [];
  const roleDays: ConstraintContract['roleDays'] = [];
  const excludedMonths: string[] = [];
  let intervalMonths: number | undefined;
  let dayOfMonth: number | 'LAST' | undefined;
  let prohibitConsecutiveEvenings = false;
  let undefinedMetric = false;

  for (const atom of atoms) {
    const record = atom.record;
    if (atom.negated) continue;
    switch (true) {
      case record.property === 'schedule.frequency.count' && record.relation === 'eq':
        exactWeekly = minutesOf(record) ?? undefined;
        break;
      case record.property === 'schedule.frequency.count' && record.relation === 'lte':
        maxWeekly = minutesOf(record) ?? undefined;
        break;
      case record.property === 'schedule.days' && record.relation === 'eq': {
        const days = daysOf(record);
        if (days) requiredWeekdays.push(...days);
        break;
      }
      case record.property === 'schedule.days' && record.relation === 'in': {
        const days = daysOf(record);
        if (days) allowedWeekdays = canonicalWeekdayOrder([...(allowedWeekdays ?? []), ...days]);
        break;
      }
      case record.property === 'schedule.days' && record.relation === 'excludes': {
        const days = daysOf(record);
        if (days) excludedWeekdays.push(...days);
        break;
      }
      case /^schedule\.session\.length/.test(record.property) &&
        (record.relation === 'lte' || record.relation === 'eq'): {
        const minutes = minutesOf(record);
        if (minutes !== null) maxMinutesPerSession = minutes;
        break;
      }
      case /^schedule\.week\.minutes/.test(record.property) && record.relation === 'lte': {
        const minutes = minutesOf(record);
        if (minutes !== null) maxWeeklyMinutes = minutes;
        break;
      }
      case record.property === 'goal.deadline' && record.relation === 'eq' && record.value.kind === 'date':
        deadline = record.value.value;
        break;
      case /^finance\.monthly\.cap/.test(record.property) && record.relation === 'lte': {
        const money = moneyOf(record);
        if (money !== null) monthlyMoneyCap = money;
        break;
      }
      case record.property === 'finance.monthly.interval' && record.relation === 'eq': {
        const count = countOf(record);
        if (count !== null && count >= 1) intervalMonths = count;
        break;
      }
      case record.property === 'finance.monthly.day' && record.relation === 'eq': {
        if (record.value.kind === 'count' && record.value.value >= 1 && record.value.value <= 31) {
          dayOfMonth = record.value.value;
        } else if (textOf(record) === 'last') {
          dayOfMonth = 'LAST';
        }
        break;
      }
      case record.property === 'finance.month.excluded' && (record.relation === 'eq' || record.relation === 'excludes'): {
        const month = textOf(record);
        if (month && MONTH_TEXT_RE.test(month)) excludedMonths.push(month);
        break;
      }
      case /^role\.[a-z_]+\.min_weekly$/.test(record.property) && record.relation === 'eq': {
        const role = roleOf(record.property);
        const count = countOf(record);
        if (role && count !== null && count >= 1) roleMinWeekly.push({ role, minOccurrences: count });
        break;
      }
      case /^role\.[a-z_]+\.days$/.test(record.property) && record.relation === 'eq': {
        const role = roleOf(record.property);
        const days = daysOf(record);
        if (role && days) roleDays.push({ role, days: canonicalWeekdayOrder(days) });
        break;
      }
      case record.property === 'schedule.evenings.consecutive' &&
        record.relation === 'eq' &&
        record.value.kind === 'boolean' &&
        record.value.value === false:
        prohibitConsecutiveEvenings = true;
        break;
      case record.property === 'goal.metric.defined' &&
        record.relation === 'eq' &&
        record.value.kind === 'boolean' &&
        record.value.value === false:
        undefinedMetric = true;
        break;
      default:
        break;
    }
  }

  // Exclusions: explicit excludes atoms plus negated presence assertions
  // (NOT(A) remains NOT(A) in the AST and projects as the exclusion of A).
  for (const atom of atoms) {
    if (atom.negated) continue;
    const record = atom.record;
    if (record.relation === 'excludes') {
      const text = textOf(record);
      if (text && !MONTH_TEXT_RE.test(text)) forbiddenActivities.push(text);
    }
  }

  const cadence: ConstraintContract['cadence'] =
    roleDays.length || requiredWeekdays.length
      ? 'FIXED'
      : allowedWeekdays?.length && (exactWeekly !== undefined || maxWeekly !== undefined)
        ? 'FLEXIBLE'
        : 'UNSPECIFIED';

  return {
    exactWeekly,
    maxWeekly,
    requiredWeekdays: canonicalWeekdayOrder(requiredWeekdays),
    excludedWeekdays: canonicalWeekdayOrder(excludedWeekdays),
    allowedWeekdays,
    cadence,
    roleMinWeekly,
    roleDays,
    monthly: intervalMonths !== undefined ? { intervalMonths, dayOfMonth } : undefined,
    excludedMonths: excludedMonths.length ? excludedMonths : undefined,
    deadline,
    monthlyMoneyCap,
    maxMinutesPerSession,
    maxWeeklyMinutes,
    totalWeeklyOccurrences: exactWeekly,
    prohibitConsecutiveEvenings,
    undefinedMetric,
    forbiddenActivities,
  };
}

/**
 * Deterministic AST constraints with no single-atom contract form are
 * SURFACED here rather than silently dropped: the draft-repair prompt quotes
 * these lines, and tests pin their presence.
 */
export function advisoryLinesFromState(state: RequirementState): string[] {
  const lines: string[] = [];
  for (const atom of projectState(state).atoms) {
    const record = atom.record;
    if (atom.negated) continue;
    if (record.property === 'finance.monthly.amount' && record.relation === 'eq') {
      const amount = moneyOf(record);
      const phase = record.temporal.kind === 'phase' ? ` during ${record.temporal.label}` : '';
      if (amount !== null) {
        lines.push(`a monthly contribution of ${amount}${phase} (advisory — the plan must reflect it)`);
      }
    }
    if (record.property === 'finance.exchange.rate' && record.relation === 'eq') {
      const rate = countOf(record) ?? minutesOf(record);
      if (rate !== null) {
        lines.push(`an exchange rate of ${rate} (advisory — confirm the planning rate)`);
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------- canonical validation source
//
// Rev.3: ONE AST-controlled text source feeds every surviving compatibility
// validator (the financial-plan parser, goal coverage gaps, explicit activity
// coverage, evidence requirements, medical-risk gate, feasibility gate).
// Composed of:
//   1. authoritative ACTIVE requirement evidence (USER_EXPLICIT/USER_INFERRED)
//   2. bounded grounded UnmodeledEvidence (safety/compatibility visibility)
//   3. labeled ACTIVE SYSTEM_ASSUMPTION advisory evidence
// and NOTHING else: never raw goal text or transcript, never SUPERSEDED /
// REJECTED / QUARANTINED / PENDING_RESOLUTION evidence.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONEY_SYMBOL: Record<string, string> = { eur: '€', usd: '$', gbp: '£' };

function humanLabel(record: RequirementRecord): string | null {
  const v = record.value;
  switch (v.kind) {
    case 'text':
    case 'categorical':
      return v.value;
    case 'boolean':
      return v.value ? 'yes' : 'no';
    case 'count':
      return String(v.value);
    case 'quantity': {
      const symbol = MONEY_SYMBOL[v.unit];
      const unit = v.unit === 'minute' ? 'minutes' : v.unit === 'hour' ? 'hours' : v.unit;
      return symbol ? `${symbol}${v.value}` : `${v.value} ${unit}`;
    }
    case 'date':
      return v.value;
    case 'weekdaySet':
      return v.days.map((day) => DAY_NAMES[day]).join(', ');
    case 'timeOfDay': {
      const h = Math.floor(v.minutes / 60);
      const m = v.minutes % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    default:
      return null;
  }
}

function authoritativeLine(atom: ProjectedAtom): string | null {
  const record = atom.record;
  const label = humanLabel(record);
  if (label === null) return null;
  const temporal =
    record.temporal.kind === 'phase'
      ? ` (during ${record.temporal.label})`
      : record.temporal.kind === 'weekdayRecurring'
        ? ` (on ${record.temporal.days.map((d) => DAY_NAMES[d]).join(', ')})`
        : '';
  // Negated presence (NOT(A)) stays visible as the exclusion it projects to.
  if (atom.negated) return `The plan must not involve ${label}${temporal}.`;
  switch (record.relation) {
    case 'eq':
      // Outcome/target/activity values render as a pursue-able goal statement
      // so the downstream coverage gates see the goal's own words, not the
      // property key — "The goal is lose weight", never "goal outcome: ...".
      if (record.property === 'goal.outcome' || record.property === 'goal.target' || record.property === 'session.activity') {
        return `The goal is ${label}${temporal}.`;
      }
      return `${record.property.replace(/[._]/g, ' ')}: ${label}${temporal}.`;
    case 'gte':
      return `At least ${label}${temporal}.`;
    case 'lte':
      return `At most ${label}${temporal}.`;
    case 'excludes':
      return `Never schedule: ${label}${temporal}.`;
    case 'ne':
      return `Not ${label}${temporal}.`;
    case 'in':
      return `Allowed: ${label}${temporal}.`;
    case 'contains':
      return `The goal is ${label}${temporal}.`;
  }
}

/**
 * The canonical validator source (Rev.3 §A2). Deterministic: the same state
 * always renders the same text, regardless of clause order in history.
 */
export function buildValidationSource(state: RequirementState): string {
  const view = projectState(state);
  const lines: string[] = [];

  // 1. Authoritative requirement evidence — user authority only
  // (USER_EXPLICIT / USER_INFERRED). MODEL_INFERRED is an ungrounded claim
  // the model made up; it never enters the validation source, or a
  // fabricated outcome/constraint would steer the compatibility gates.
  for (const atom of view.atoms) {
    if (atom.record.provenance !== 'USER_EXPLICIT' && atom.record.provenance !== 'USER_INFERRED') {
      continue;
    }
    const line = authoritativeLine(atom);
    if (line) lines.push(line);
  }

  // 2. Bounded grounded unmodeled evidence (safety/compatibility visibility).
  for (const evidence of state.unmodeledEvidence ?? []) {
    lines.push(`Note from you: ${evidence.quote}`);
  }

  // 3. Labeled advisory assumptions — never authority.
  for (const assumption of state.records) {
    if (assumption.status !== 'ACTIVE' || assumption.provenance !== 'SYSTEM_ASSUMPTION') continue;
    const label = humanLabel(assumption);
    if (label) lines.push(`Assumed (you did not state this): ${assumption.property.replace(/[._]/g, ' ')} ${label}.`);
  }

  return lines.join('\n');
}

/**
 * All contract variants for the state: the base contract (AND of everything)
 * cross-cut with one branch per OR group. Bounded by MAX_OR_COMBINATIONS.
 */
export function contractsFromState(state: RequirementState): ConstraintContract[] {
  const view = projectState(state);
  const atoms = view.atoms;
  const orScopes = new Set(atoms.filter((a) => a.branchScope).map((a) => a.branchScope!));

  // OR groups: branches of one group are alternatives. Records carry per-branch
  // scopes (`<groupScope>#<index>`); group them by the group-level scope.
  const groupScopeOf = (branchScope: string): string => branchScope.replace(/#\d+$/, '');
  const orGroups = new Map<string, Map<number, ProjectedAtom[]>>();
  for (const atom of view.atoms) {
    if (!atom.branchScope || atom.altIndex === undefined) continue;
    const groupScope = groupScopeOf(atom.branchScope);
    const branches = orGroups.get(groupScope) ?? new Map<number, ProjectedAtom[]>();
    const branch = branches.get(atom.altIndex) ?? [];
    branch.push(atom);
    branches.set(atom.altIndex, branch);
    orGroups.set(groupScope, branches);
  }

  let combos: Array<ProjectedAtom[]> = [[]];
  for (const [, branches] of orGroups) {
    const branchList = [...branches.keys()].sort((a, b) => a - b).map((k) => branches.get(k)!);
    if (branchList.length === 0) continue;
    const next: Array<ProjectedAtom[]> = [];
    for (const combo of combos) {
      for (const branch of branchList) {
        if (next.length >= MAX_OR_COMBINATIONS) break;
        next.push([...combo, ...branch]);
      }
      if (next.length >= MAX_OR_COMBINATIONS) break;
    }
    combos = next;
  }

  return combos.map((combo) => {
    const chosenIds = new Set(combo.map((a) => a.record.id));
    const selected = atoms.filter((a) => !a.branchScope || !orScopes.has(a.branchScope) || chosenIds.has(a.record.id));
    return buildOneContract(selected);
  });
}

/** Parity helper for tests: the projection's normalized value labels. */
export function projectedValueLabels(state: RequirementState): string[] {
  return projectState(state).atoms.map((a) => normalizedValueRepr(a.record.value));
}
