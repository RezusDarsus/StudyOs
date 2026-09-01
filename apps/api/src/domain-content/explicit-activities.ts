import type { RuntimeContentPack } from '../ai/runtime-knowledge.js';

/**
 * Explicit-activity vocabulary — the legacy `EXPLICIT_ACTIVITIES` table,
 * source-identical, same order. Labels are OPEN RuntimeRoleIds (plain strings
 * on both the parse side and the validation side), so a runtime pack may
 * introduce an activity the core has never heard of. The coverage invariant
 * ("explicitly requested activities must appear in the plan") stays in core.
 */
export const explicitActivityPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'explicit-activity',
    entries: [
      { phrase: '\\bbox(?:ing)?\\b', role: 'boxing', match: 'pattern' },
      { phrase: '\\bgym\\b', role: 'gym', match: 'pattern' },
      { phrase: '\\brun(?:ning)?\\b', role: 'running', match: 'pattern' },
      { phrase: '\\bwalk(?:ing)?\\b', role: 'walking', match: 'pattern' },
      { phrase: '\\bswim(?:ming)?\\b', role: 'swimming', match: 'pattern' },
      { phrase: '\\bcycl(?:e|ing)\\b', role: 'cycling', match: 'pattern' },
      { phrase: '\\byoga\\b', role: 'yoga', match: 'pattern' },
      { phrase: '\\bpilates\\b', role: 'pilates', match: 'pattern' },
    ],
  },
};
