import { MAX_RECOMMENDATIONS, type ProgressAnalysisV7, type RecommendationItem } from '../ai/schemas.js';

/**
 * Stage 1 deterministic recommendation machinery.
 *
 * Everything here is pure: no model, no database, no I/O. The flag-on ADVICE
 * turn validates what the model returned, folds the structured history and
 * builds the prompt block — and the model's prose is never scraped for
 * recommendation identity. Domain-open by construction: nothing below knows
 * what kinds of things exist; `entityType` is opaque runtime data.
 *
 * Identity for Stage 1 is deliberately shallow: casefolded displayName plus
 * casefolded attribution. Editions, translations, aliases and external IDs are
 * later migration stages.
 */

export type StructuredRecommendation = RecommendationItem;

/**
 * Two recommendations are the same item when their names and attributions
 * match case-insensitively. `entityType` is deliberately NOT part of identity:
 * the same item described as two different types is still the same item.
 */
export function recommendationIdentity(item: Pick<StructuredRecommendation, 'displayName' | 'attribution'>): string {
  return `${item.displayName.trim().toLocaleLowerCase()}|${(item.attribution ?? '').trim().toLocaleLowerCase()}`;
}

/**
 * Normalize one turn's recommendations: trim, drop in-turn duplicates by
 * identity (first wins) and cap at the mechanic bound. Display values are kept
 * exactly as the model wrote them — normalization is for identity and safety,
 * not for rewriting what will be shown.
 */
export function normalizeRecommendations(
  items: readonly StructuredRecommendation[] | null | undefined,
): StructuredRecommendation[] {
  const seen = new Set<string>();
  const result: StructuredRecommendation[] = [];
  for (const item of items ?? []) {
    const identity = recommendationIdentity(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(item);
    if (result.length >= MAX_RECOMMENDATIONS) break;
  }
  return result;
}

/** Anything that carries structured recommendations per turn — the goal-chat history entry. */
export interface RecommendationHistorySource {
  recommendations?: StructuredRecommendation[] | null;
}

/** Every item the conversation already contains, as identities. */
export function priorRecommendationIdentities(
  history: readonly RecommendationHistorySource[],
): ReadonlySet<string> {
  const identities = new Set<string>();
  for (const entry of history) {
    for (const item of entry.recommendations ?? []) {
      identities.add(recommendationIdentity(item));
    }
  }
  return identities;
}

/**
 * The prompt block handed to the model before it generates: the structured
 * recommendations the conversation already contains, newest first, capped at
 * MAX_RECOMMENDATIONS. Generation uses this to avoid repeats; the deterministic
 * validator remains the final defense. Returns '' when there is nothing to say —
 * callers must not add an empty block to the prompt.
 */
export function serializePriorRecommendations(
  history: readonly RecommendationHistorySource[],
): string {
  const items: StructuredRecommendation[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0 && items.length < MAX_RECOMMENDATIONS; i--) {
    const entryItems = [...(history[i].recommendations ?? [])].reverse();
    for (const item of entryItems) {
      const identity = recommendationIdentity(item);
      if (seen.has(identity)) continue;
      seen.add(identity);
      items.push(item);
      if (items.length >= MAX_RECOMMENDATIONS) break;
    }
  }
  if (items.length === 0) return '';
  const lines = items.map((item) => {
    const attribution = item.attribution ? `\n  attribution: ${item.attribution}` : '';
    return `- entityType: ${item.entityType}\n  displayName: ${item.displayName}${attribution}`;
  });
  return `Recent structured recommendations. Do not repeat these items:\n${lines.join('\n')}`;
}

export interface RecommendationTurnResult {
  /** Fresh, valid, history-filtered items — empty when the turn is prose-only. */
  items: StructuredRecommendation[];
  /** Consistency violations; non-empty means the turn failed validation. */
  violations: string[];
}

/**
 * Enforce the flag-on consistency contract:
 *
 *   recommendsItems  recommendations (fresh)   verdict
 *   ---------------  ------------------------  ----------------------
 *   true             one or more               accept
 *   true             zero                      violation (repair)
 *   false            non-empty                 violation (repair)
 *   false            zero                      valid prose-only advice
 *
 * "Zero fresh" includes the case where the model listed items but every one of
 * them was already in the structured history — those are exact repeats, which
 * the follow-up contract exists to prevent.
 */
export function validateRecommendationTurn(input: {
  analysis: ProgressAnalysisV7;
  priorIdentities: ReadonlySet<string>;
}): RecommendationTurnResult {
  const { analysis, priorIdentities } = input;
  const all = normalizeRecommendations(analysis.recommendations);
  const fresh: StructuredRecommendation[] = [];
  const repeats: string[] = [];
  for (const item of all) {
    if (priorIdentities.has(recommendationIdentity(item))) repeats.push(item.displayName);
    else fresh.push(item);
  }

  const violations: string[] = [];
  if (analysis.recommendsItems && fresh.length === 0) {
    violations.push(
      all.length === 0
        ? 'You set "recommendsItems" to true but "recommendations" is empty. Either list every recommended item in "recommendations", or set "recommendsItems" to false if you are not recommending concrete items.'
        : `Every recommended item already appears in the recent conversation (${repeats.join(', ')}). Recommend different items instead, or set "recommendsItems" to false if you are not recommending concrete items.`,
    );
  }
  if (!analysis.recommendsItems && all.length > 0) {
    violations.push(
      'You returned items in "recommendations" but set "recommendsItems" to false. Set "recommendsItems" to true, or remove the items if you are not recommending concrete items.',
    );
  }
  return { items: fresh, violations };
}

/**
 * The flag-on terminal failure: the model could not produce a consistent,
 * non-repeating structured recommendation set within the one-repair budget.
 * Typed and retryable — nothing is substituted, fabricated or fallen back.
 */
export class RecommendationValidationError extends Error {
  readonly code = 'RECOMMENDATIONS_INVALID' as const;
  constructor(readonly violations: readonly string[]) {
    super(`The AI reply did not satisfy the structured recommendation contract: ${violations.join(' ')}`);
    this.name = 'RecommendationValidationError';
  }
}
