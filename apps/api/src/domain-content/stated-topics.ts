import type { RuntimeContentPack } from '../ai/runtime-knowledge.js';

/**
 * Goal-statement topic signals — the legacy `STATED_PATTERNS` regexes,
 * source-identical, in the same order. Roles are QuestionTopic values; both
 * readiness and planning-sufficiency read these through the same generic
 * filter, so the two gates cannot disagree.
 */
export const statedTopicPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'stated-topic-pattern',
    entries: [
      { phrase: '\\b(?:\\d+|one|two|three|four|five|six|seven)\\s*(?:x|times|days)\\s*(?:a|per)\\s*week|\\b(?:one|1)\\s+weekly\\b|every ?day|daily|weekdays|weekends|every\\s+(?:sun(?:day)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thurs?(?:day)?|fri(?:day)?|sat(?:urday)?)', role: 'FREQUENCY', match: 'pattern' },
      { phrase: '\\b(mon|tues?|wed|thur?s?|fri|sat|sun)(day)?s?\\b|weekdays|weekends', role: 'DAYS', match: 'pattern' },
      { phrase: '\\b\\d+\\s*(min|minute|hour|hr)', role: 'DURATION', match: 'pattern' },
      { phrase: '\\b(morning|afternoon|evening|night|before work|after work|lunchtime)\\b|\\b\\d{1,2}\\s?(am|pm)\\b', role: 'TIME_OF_DAY', match: 'pattern' },
      { phrase: '\\b\\d+\\s*(pages?|books?|kg|kilos?|km|miles?|words?)\\b|by (january|february|march|april|may|june|july|august|september|october|november|december)|in \\d+ (weeks?|months?)|\\b(?:lose weight|weight loss|build (?:strength|muscle)|improve (?:endurance|stamina)|be more active)\\b', role: 'TARGET', match: 'pattern' },
      { phrase: 'e-?books?|audiobooks?|paperbacks?|kindle|podcast|at the gym|at home', role: 'FORMAT', match: 'pattern' },
      { phrase: 'fiction|non-?fiction|fantasy|history|biograph|sci-?fi|novels?', role: 'CONTENT', match: 'pattern' },
    ],
  },
};
