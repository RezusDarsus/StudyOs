import { GOAL_CATEGORY, type GoalCategory } from '../domain/enums.js';
import { getRuntimeKnowledge, portMemo } from './runtime-knowledge.js';

// Which stored memories get injected is decided from the USER's own words, not
// from the category the model reported.
//
// The contamination bug ran through exactly that loop: the model classified
// "I need to build a house" as FITNESS, the gate then handed it the fitness
// memories, and it produced a walking plan. Asking the model for a category and
// then using that category to choose what to show the model lets it talk itself
// into any memory it likes. The gate's input has to come from outside the model.



export interface CategoryGuess {
  category: GoalCategory | null;
  /** 0-1. Memory gating requires this to clear a threshold. */
  confidence: number;
  matched: string[];
}

/**
 * The flag-ON source of the same table: the runtime knowledge port's
 * `goal-category` lexicon, grouped by role. Roles are mapped through the one
 * generic persisted-category filter — a runtime role that is not a stored
 * GOAL_CATEGORY value can never influence classification, so a synthetic
 * runtime domain is correctly invisible here while a real new domain is just
 * data with a valid role. Memoized per port instance; a port replacement
 * rebuilds from scratch.
 */
function runtimeCategoryKeywords(): Record<GoalCategory, string[]> {
  const port = getRuntimeKnowledge();
  return portMemo(port, 'goal-category-keywords', () => {
    const table = {} as Record<GoalCategory, string[]>;
    for (const category of GOAL_CATEGORY) table[category] = [];
    for (const entry of port.getLexiconEntries('goal-category')) {
      if (entry.role && (GOAL_CATEGORY as readonly string[]).includes(entry.role)) {
        table[entry.role as GoalCategory].push(entry.phrase);
      }
    }
    return table;
  });
}

/**
 * Classify from the user's text alone. Deliberately keyword-based: it is
 * deterministic, auditable, free, and cannot be argued with by a model.
 */
export function classifyGoalText(text: string): CategoryGuess {
  // The keyword TABLE is runtime data (the port); the scoring mechanics
  // (substring matching, ranking, confidence) are core.
  const table = runtimeCategoryKeywords();
  const haystack = ` ${text.toLowerCase()} `;
  const scores = new Map<GoalCategory, string[]>();

  for (const category of GOAL_CATEGORY) {
    const hits = table[category].filter((word) => haystack.includes(word));
    if (hits.length > 0) scores.set(category, hits);
  }

  if (scores.size === 0) return { category: null, confidence: 0, matched: [] };

  const ranked = [...scores.entries()].sort((a, b) => b[1].length - a[1].length);
  const [topCategory, topHits] = ranked[0];
  const runnerUp = ranked[1]?.[1].length ?? 0;

  // Confidence rises with how many terms matched and how clearly the winner leads.
  const margin = topHits.length - runnerUp;
  let confidence = Math.min(1, topHits.length * 0.3 + margin * 0.25);
  // A single generic keyword is a weak signal on its own.
  if (topHits.length === 1 && margin === 0) confidence = Math.min(confidence, 0.3);

  return { category: topCategory, confidence: Math.round(confidence * 100) / 100, matched: topHits };
}

/** Below this, category-scoped memory stays out of the prompt entirely. */
export const MEMORY_GATE_CONFIDENCE = 0.55;

/**
 * Decide which category (if any) may unlock category-scoped memory.
 *
 * The model's own guess is only honoured when the user's text independently
 * agrees with it. Otherwise nothing category-scoped is injected — GLOBAL
 * preferences, which apply broadly, still are.
 */
export function memoryGateCategory(
  goalText: string,
  modelCategory: string | null | undefined,
): { category: GoalCategory | null; reason: string } {
  const guess = classifyGoalText(goalText);

  if (!guess.category || guess.confidence < MEMORY_GATE_CONFIDENCE) {
    return {
      category: null,
      reason: `goal text is not clearly categorised (${guess.category ?? 'none'} @ ${guess.confidence})`,
    };
  }
  if (modelCategory && modelCategory !== guess.category) {
    // The model says FITNESS, the text says PERSONAL: trust neither.
    return {
      category: null,
      reason: `model says ${modelCategory}, text says ${guess.category} — withholding`,
    };
  }
  return { category: guess.category, reason: `text agrees (${guess.matched.join(', ')})` };
}
