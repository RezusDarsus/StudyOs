import { beforeAll, describe, expect, it } from 'vitest';
import { GOAL_CATEGORY } from './domain/enums.js';
import { getRuntimeKnowledge, isRuntimeKnowledgeInstalled } from './ai/runtime-knowledge.js';
import { installRuntimeContent } from './runtime-content.js';

// The composed port must be a faithful, validated home for the exact content
// the legacy inline tables carried. Structural parity (same words per role) is
// the strongest guarantee the flag-ON path can behave identically.

beforeAll(() => {
  installRuntimeContent();
});

describe('runtime content composition', () => {
  it('bootstraps explicitly and only when asked', () => {
    expect(isRuntimeKnowledgeInstalled()).toBe(true);
  });

  it('carries the complete category keyword set per persisted category', () => {
    const entries = getRuntimeKnowledge().getLexiconEntries('goal-category');
    const byRole = new Map<string, string[]>();
    for (const entry of entries) {
      if (!entry.role) continue;
      byRole.set(entry.role, [...(byRole.get(entry.role) ?? []), entry.phrase]);
    }
    // Every persisted category the legacy table knew is present (OTHER was
    // empty there and stays empty here).
    for (const category of GOAL_CATEGORY) {
      expect(byRole.has(category), `missing category ${category}`).toBe(category !== 'OTHER');
    }
    // The role values never invent a persisted category.
    for (const role of byRole.keys()) {
      expect(GOAL_CATEGORY as readonly string[]).toContain(role);
    }
  });

  it('serves the domain-flavoured success questions, including the MONEY free-text case', () => {
    const questions = getRuntimeKnowledge().getQuestionPack('goal-domain-success');
    const byRole = new Map(questions.map((q) => [q.coversRole, q]));
    expect(byRole.get('MONEY')).toMatchObject({ type: 'FREE_TEXT', prompt: 'How much do you want to save, and by when?' });
    expect(byRole.get('FITNESS')).toMatchObject({
      type: 'SINGLE_SELECT',
      prompt: 'What result matters most right now?',
      options: ['Lose weight', 'Build strength', 'Improve endurance', 'Be more active generally'],
    });
    expect(byRole.get('LEARNING')).toMatchObject({ prompt: 'What are you learning this for?' });
    expect(byRole.get('LANGUAGE')).toMatchObject({ prompt: 'Which skill should the plan prioritize?' });
    expect(byRole.get('CAREER')).toMatchObject({ prompt: 'What would success look like?' });
    expect(byRole.get('CREATIVE')).toMatchObject({ prompt: 'What does progress look like for you?' });
    // No GENERAL entry: the generic fallback prompt is core behavior.
    expect(byRole.has('GENERAL')).toBe(false);
  });

  it('compiles the pattern families with their exact legacy sources', () => {
    const compiled = getRuntimeKnowledge().getLexicon('stated-topic-pattern');
    const target = compiled.patterns.find((p) => p.entry.role === 'TARGET');
    expect(target?.entry.phrase).toBe(
      '\\b\\d+\\s*(pages?|books?|kg|kilos?|km|miles?|words?)\\b|by (january|february|march|april|may|june|july|august|september|october|november|december)|in \\d+ (weeks?|months?)|\\b(?:lose weight|weight loss|build (?:strength|muscle)|improve (?:endurance|stamina)|be more active)\\b',
    );
    expect(target?.regex.test('read 20 pages a day')).toBe(true);
    expect(target?.regex.test('lose weight')).toBe(true);
  });

  it('carries the recommendation vocabulary fragments used by goal-chat routing', () => {
    const material = getRuntimeKnowledge().getLexicon('recommendation-material').patterns[0];
    expect(material.entry.phrase).toBe(
      'books?|novels?|manga|manhwa|webtoons?|comics?|graphic\\s+novels?|light\\s+novels?|read\\s+next|reading\\s+recommendation',
    );
    expect(material.regex.test('can you suggest some MANGA?')).toBe(true);
  });
});
