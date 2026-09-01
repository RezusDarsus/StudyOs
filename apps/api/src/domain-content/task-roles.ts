import type { RuntimeContentPack } from '../ai/runtime-knowledge.js';

/**
 * Semantic task-role vocabulary — the exact regex sources from the legacy
 * inline `semanticTaskRoles` lexicons, in the same order. Role NAMES are
 * mechanic (contract codes depend on them) and stay typed in core; these
 * entries are the words that tag a task with a role. Sources are tested
 * against lowercased text, exactly as before.
 */
export const taskRolePack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'task-role',
    entries: [
      { phrase: '\\b(strength|resistance|weights?|lower-body|ankle strengthening)\\b', role: 'STRENGTH', match: 'pattern' },
      { phrase: '\\b(trail|technical terrain)\\b', role: 'TRAIL', match: 'pattern' },
      { phrase: '\\blong\\s+run\\b', role: 'LONG_RUN', match: 'pattern' },
      { phrase: '\\b(save|saving|contribut|deposit|transfer|payment|pay(?:ment)?|budget review|bonus)\\b|[€$£]\\s*[\\d,]+|\\b(?:USD|EUR|GBP|GEL)\\b', role: 'FINANCE_TRANSFER', match: 'pattern' },
      { phrase: '\\b(interview prep|mock interview|interview practice)\\b', role: 'INTERVIEW_PREP', match: 'pattern' },
    ],
  },
};
