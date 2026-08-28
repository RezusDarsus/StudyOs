import { GOAL_CATEGORY, type GoalCategory } from '../domain/enums.js';

// Which stored memories get injected is decided from the USER's own words, not
// from the category the model reported.
//
// The contamination bug ran through exactly that loop: the model classified
// "I need to build a house" as FITNESS, the gate then handed it the fitness
// memories, and it produced a walking plan. Asking the model for a category and
// then using that category to choose what to show the model lets it talk itself
// into any memory it likes. The gate's input has to come from outside the model.

const KEYWORDS: Record<GoalCategory, string[]> = {
  FITNESS: [
    'fitness', 'fitter', 'get fit', 'gym', 'workout', 'exercise', 'run', 'jog', 'walk', 'swim', 'cycle',
    'cycling', 'weight', 'muscle', 'strength', 'cardio', 'yoga', 'pilates', 'steps',
    'marathon', '5k', '10k', 'training', 'lose weight', 'get in shape',
  ],
  HEALTH: [
    'health', 'sleep', 'water', 'hydrat', 'meditat', 'stress', 'anxiety', 'diet',
    'nutrition', 'eat', 'smoking', 'quit smoking', 'alcohol', 'mindful', 'therapy',
    'doctor', 'wellbeing', 'wellness',
  ],
  STUDY: [
    'study', 'exam', 'revise', 'revision', 'course', 'university', 'college',
    'school', 'degree', 'homework', 'lecture', 'semester', 'test', 'certification',
  ],
  READING: ['read', 'book', 'novel', 'literature', 'pages', 'kindle', 'audiobook'],
  CAREER: [
    'career', 'job', 'work', 'promotion', 'interview', 'resume', 'cv', 'portfolio',
    'network', 'freelance', 'business', 'startup', 'client', 'linkedin',
  ],
  FINANCE: [
    'save', 'saving', 'money', 'budget', 'debt', 'spend', 'spending', 'expense',
    'salary', 'cash', 'afford', 'financ', 'bill', 'subscription', 'cost', '$', '€', '£',
  ],
  PRODUCTIVITY: [
    'productiv', 'focus', 'procrastinat', 'organis', 'organiz', 'routine', 'habit',
    'time management', 'planning', 'inbox', 'declutter', 'tidy', 'morning routine',
  ],
  PERSONAL: [
    'learn', 'language', 'spanish', 'french', 'german', 'guitar', 'piano', 'paint',
    'draw', 'write', 'writing', 'hobby', 'skill', 'instrument', 'cook', 'garden',
    'photography', 'dance', 'dancing', 'chess', 'code', 'programming',
  ],
  OTHER: [],
};

export interface CategoryGuess {
  category: GoalCategory | null;
  /** 0-1. Memory gating requires this to clear a threshold. */
  confidence: number;
  matched: string[];
}

/**
 * Classify from the user's text alone. Deliberately keyword-based: it is
 * deterministic, auditable, free, and cannot be argued with by a model.
 */
export function classifyGoalText(text: string): CategoryGuess {
  const haystack = ` ${text.toLowerCase()} `;
  const scores = new Map<GoalCategory, string[]>();

  for (const category of GOAL_CATEGORY) {
    const hits = KEYWORDS[category].filter((word) => haystack.includes(word));
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
