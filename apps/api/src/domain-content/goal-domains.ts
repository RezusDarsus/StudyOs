import type { RuntimeContentPack } from '../ai/runtime-knowledge.js';

/**
 * Goal-domain classification vocabulary (the legacy `DOMAIN_KEYWORDS` regexes,
 * source-identical) plus the domain-flavoured success questions (the legacy
 * `DOMAIN_SUCCESS_QUESTIONS` table, same prompts and options, including the
 * MONEY free-text case).
 *
 * `goal-domain` roles are OPEN RuntimeDomainIds — a runtime pack may introduce
 * a domain this file has never heard of, and the fallback-question mechanics
 * will serve whatever question the pack provides for it. The money free-text
 * special case that used to be an `if (domain === 'MONEY')` branch in core is
 * now just data: a FREE_TEXT question with coversRole 'MONEY'.
 */
export const goalDomainPack: RuntimeContentPack = {
  kind: 'lexicon',
  pack: {
    key: 'goal-domain',
    entries: [
      { phrase: '\\b(?:english|spanish|french|german|japanese|fluent|vocabulary|speaking|grammar|language)\\b', role: 'LANGUAGE', match: 'pattern' },
      { phrase: '\\b(?:save|saving|savings|budget|debt|income|spending|money|deposit)\\b', role: 'MONEY', match: 'pattern' },
      { phrase: '\\b(?:interview|resume|cv|job|career|promotion|networking)\\b', role: 'CAREER', match: 'pattern' },
      { phrase: '\\b(?:guitar|piano|paint|painting|draw|drawing|writing|novel|song|music)\\b', role: 'CREATIVE', match: 'pattern' },
      { phrase: '\\b(?:learn|study|java|python|javascript|programming|coding|course|exam|university|code|math)\\b', role: 'LEARNING', match: 'pattern' },
      { phrase: '\\b(?:fit|fitter|fitness|gym|workout|exercise|run|running|jog|weight|muscle|strength|endurance|train|training|cycle|swim)\\b', role: 'FITNESS', match: 'pattern' },
    ],
  },
};

export const goalDomainSuccessPack: RuntimeContentPack = {
  kind: 'questions',
  pack: {
    key: 'goal-domain-success',
    questions: [
      {
        id: 'essential_success',
        purpose: 'success-shaping',
        coversRole: 'MONEY',
        type: 'FREE_TEXT',
        prompt: 'How much do you want to save, and by when?',
      },
      {
        id: 'essential_success',
        purpose: 'success-shaping',
        coversRole: 'FITNESS',
        type: 'SINGLE_SELECT',
        prompt: 'What result matters most right now?',
        options: ['Lose weight', 'Build strength', 'Improve endurance', 'Be more active generally'],
      },
      {
        id: 'essential_success',
        purpose: 'success-shaping',
        coversRole: 'LEARNING',
        type: 'SINGLE_SELECT',
        prompt: 'What are you learning this for?',
        options: ['University coursework', 'Job readiness', 'General skills', 'A specific project'],
      },
      {
        id: 'essential_success',
        purpose: 'success-shaping',
        coversRole: 'LANGUAGE',
        type: 'SINGLE_SELECT',
        prompt: 'Which skill should the plan prioritize?',
        options: ['Speaking', 'Listening', 'Grammar', 'Vocabulary'],
      },
      {
        id: 'essential_success',
        purpose: 'success-shaping',
        coversRole: 'CAREER',
        type: 'SINGLE_SELECT',
        prompt: 'What would success look like?',
        options: ['Pass interviews', 'Land an offer', 'Get noticed at work', 'Build a portfolio'],
      },
      {
        id: 'essential_success',
        purpose: 'success-shaping',
        coversRole: 'CREATIVE',
        type: 'SINGLE_SELECT',
        prompt: 'What does progress look like for you?',
        options: ['Finish a piece', 'Build a daily practice', 'Share publicly', 'Learn technique'],
      },
    ],
  },
};
