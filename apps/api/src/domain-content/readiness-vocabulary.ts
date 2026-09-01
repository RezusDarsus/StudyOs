import type { RuntimeContentPack } from '../ai/runtime-knowledge.js';

/**
 * Readiness vocabulary — the legacy `LEARNABLE_SUBJECTS` word list and the
 * unit segment of `CONCRETE_QUANTITY`, source-identical. The readiness
 * predicate, the numeric frame (`\b\d+\s*(…)`), the learning-verb check and
 * the currency-less structure stay in core mechanics.
 */
export const learnableSubjectPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'learnable-subject',
    entries: [
      { phrase: 'java' },
      { phrase: 'code' },
      { phrase: 'coding' },
      { phrase: 'programming' },
      { phrase: 'english' },
      { phrase: 'spanish' },
      { phrase: 'japanese' },
      { phrase: 'guitar' },
      { phrase: 'piano' },
      { phrase: 'painting' },
      { phrase: 'writing' },
      { phrase: 'chess' },
    ],
  },
};

export const quantityUnitPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'quantity-unit',
    entries: [
      // The unit alternation inside the legacy CONCRETE_QUANTITY regex; the
      // consumer embeds it in its numeric frame.
      { phrase: 'kg|km|pages?|books?|minutes?|hours?|sessions?|miles?|\\$|€|£', match: 'pattern' },
    ],
  },
};
