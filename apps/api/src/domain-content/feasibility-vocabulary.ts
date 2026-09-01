import type { RuntimeContentPack } from '../ai/runtime-knowledge.js';

/**
 * Feasibility vocabulary — the legacy `NON_MEASURABLE_QUALITIES` word list,
 * source-identical. The verdict logic (comparative claims, short windows,
 * vague-outcome phrasing) stays in core: only the quality nouns are data.
 */
export const nonMeasurableQualityPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'non-measurable-quality',
    entries: [
      { phrase: 'creativity' },
      { phrase: 'creative' },
      { phrase: 'smarter' },
      { phrase: 'intelligence' },
      { phrase: 'charisma' },
      { phrase: 'confidence' },
      { phrase: 'happiness' },
      { phrase: 'talent' },
      { phrase: 'discipline' },
      { phrase: 'willpower' },
      { phrase: 'memory' },
    ],
  },
};
