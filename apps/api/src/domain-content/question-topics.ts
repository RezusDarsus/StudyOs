import type { RuntimeContentPack } from '../ai/runtime-knowledge.js';

/**
 * Interview question-topic classification patterns — the legacy
 * `TOPIC_PATTERNS` regexes, source-identical, in the same precedence order.
 * Roles are QuestionTopic values (mechanic enum, mapped through the generic
 * filter); the patterns themselves are data.
 */
export const questionTopicPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'question-topic-pattern',
    entries: [
      { phrase: 'how many (days|times|sessions)|how often|per week|each week|a week', role: 'FREQUENCY', match: 'pattern' },
      { phrase: '\\bdays\\b|\\bday\\(s\\)|weekday|weekend|which day', role: 'DAYS', match: 'pattern' },
      { phrase: 'how (many minutes|long)|session length|minutes per|how much time', role: 'DURATION', match: 'pattern' },
      { phrase: "time of day|what time|morning|afternoon|evening|night|o'clock", role: 'TIME_OF_DAY', match: 'pattern' },
      { phrase: 'format|medium|e-?book|audiobook|paperback|equipment|at home or|device', role: 'FORMAT', match: 'pattern' },
      { phrase: 'what (kind|type|sort)|which (kind|type|genre)|genre|material|subject|topic', role: 'CONTENT', match: 'pattern' },
      { phrase: '\\bwhere\\b|location|indoors|outdoors|at the gym|at home', role: 'LOCATION', match: 'pattern' },
      { phrase: 'enjoy|prefer doing|like doing|which activit|favourite|favorite', role: 'INTEREST', match: 'pattern' },
      { phrase: "avoid|stopping you|get in the way|struggle|obstacle|can't do|unavailable", role: 'CONSTRAINT', match: 'pattern' },
      { phrase: '\\bwhy\\b|motivat|what.s driving|important to you', role: 'MOTIVATION', match: 'pattern' },
      { phrase: 'how many (books|pages|kg|km)|target|by when|deadline|finish by|aiming for|what result|result matters|success|outcome|lose weight|build strength|improve endurance|be more active', role: 'TARGET', match: 'pattern' },
      { phrase: 'currently|at the moment|right now|experience|how fit|starting point|level', role: 'EXPERIENCE', match: 'pattern' },
    ],
  },
};
