import type { RuntimeContentPack } from '../ai/runtime-knowledge.js';

/**
 * Intent-routing topic vocabulary — the domain word/phrase segments that the
 * legacy intent-router templates embedded, plus the goal-chat recommendation
 * topic nouns. The structural frames around these fragments (commitment
 * phrasing, question shapes, continuation words) stay in core.
 */
export const createVerbPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'create-verb',
    entries: [
      'learn', 'read', 'save', 'sleep', 'prepare', 'run', 'go', 'get', 'build', 'find',
      'start', 'cook', 'improve', 'wake', 'stop', 'spend', 'organize', 'organise',
      'study', 'walk', 'reduce', 'practice', 'practise', 'lose', 'become', 'train',
      'apply', 'complete', 'meditate', 'create', 'generate', 'schedule', 'implement',
      'design', 'plan', 'use', 'make', 'set', 'track', 'log', 'quit', 'cut', 'gain',
      'write', 'draw', 'play', 'eat', 'drink', 'exercise', 'budget', 'be', 'repeat',
      'pause', 'resume', 'increase', 'recommend', 'guarantee', 'limit', 'avoid',
      'stretch', 'lift', 'swim', 'cycle', 'hike', 'journal', 'invest', 'finish', 'give',
    ].map((phrase) => ({ phrase })),
  },
};

export const missedActivityNounPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'missed-activity-noun',
    entries: [
      // The legacy rule 114 alternation was a structural/product segment
      // (task, day, session, streak, goal) followed by topic nouns
      // (workout, gym, run, class). Only the topic nouns are runtime data.
      { phrase: 'workout' },
      { phrase: 'gym' },
      { phrase: 'run' },
      { phrase: 'class' },
    ],
  },
};

export const commitmentActivityVerbPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'commitment-activity-verb',
    entries: [
      // The complete legacy rule 157 alternation, verbatim — activity verbs
      // are vocabulary; the frame ("\bi can\b[^.?!]{0,60}\b(…)\b") stays core.
      { phrase: 'study' },
      { phrase: 'train' },
      { phrase: 'practice' },
      { phrase: 'save' },
      { phrase: 'contribute' },
      { phrase: 'spend' },
      { phrase: 'work' },
      { phrase: 'give' },
      { phrase: 'commit' },
      { phrase: 'dedicate' },
      { phrase: 'exercise' },
      { phrase: 'go' },
      { phrase: 'do' },
    ],
  },
};

export const trainingNounPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'training-noun',
    entries: [
      // Legacy rule 188 alternation: plan/schedule/goal/sessions are product
      // mechanics and stay; training/workouts are topic vocabulary.
      { phrase: 'training|workouts?', match: 'pattern' },
    ],
  },
};

export const recommendationTopicPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'recommendation-topic',
    entries: [
      // The legacy goalCopilotIntent ADVICE regex's topic-noun alternation,
      // verbatim. The structural advice verbs (suggest|recommend|…|what|
      // which|how can|how should) remain in core.
      { phrase: 'books?|novels?|manga|manhwa|webtoons?|comics?|graphic novels?|light novels?|read next|reading|recipes?|courses?|podcasts?|techniques?|resources?', match: 'pattern' },
    ],
  },
};

export const recommendationMaterialPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'recommendation-material',
    entries: [
      // The legacy READING_MATERIAL regex, verbatim — the reading-material
      // vocabulary that feeds goal-chat follow-up breadth, the legacy book
      // ask detection and the Stage 2 routing-signal condition.
      { phrase: 'books?|novels?|manga|manhwa|webtoons?|comics?|graphic\\s+novels?|light\\s+novels?|read\\s+next|reading\\s+recommendation', match: 'pattern' },
    ],
  },
};
