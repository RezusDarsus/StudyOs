import { describe, expect, it } from 'vitest';
import {
  buildRuntimeKnowledgePort,
  isRuntimeKnowledgeKey,
  portMemo,
  resetRuntimeKnowledge,
  RUNTIME_KNOWLEDGE_KEYS,
  RuntimeContentError,
  runtimeContentPackSchema,
  setRuntimeKnowledge,
  getRuntimeKnowledge,
  isRuntimeKnowledgeInstalled,
  type RuntimeContentPack,
} from './runtime-knowledge.js';

// The port is a mechanic: keyed lexicons and question packs over open roles.
// Nothing here knows what a book is.

describe('key registry (closed mechanic set)', () => {
  it('accepts registered keys and rejects everything else', () => {
    for (const key of RUNTIME_KNOWLEDGE_KEYS) expect(isRuntimeKnowledgeKey(key)).toBe(true);
    for (const key of ['books', 'fitness-questions', 'FLORP', '']) {
      expect(isRuntimeKnowledgeKey(key)).toBe(false);
    }
  });

  it('contains no domain nouns — keys name mechanics only', () => {
    expect(RUNTIME_KNOWLEDGE_KEYS.join(',')).not.toMatch(/book|manga|fitness|reading|movie|course/i);
  });
});

describe('buildRuntimeKnowledgePort', () => {
  it('returns empty compiled structures for unknown keys — safe degradation', () => {
    const port = buildRuntimeKnowledgePort([]);
    const compiled = port.getLexicon('goal-category');
    expect(compiled.wordRegex).toBeNull();
    expect(compiled.alternation).toBeNull();
    expect(compiled.patterns).toEqual([]);
    expect(compiled.phrases).toEqual([]);
    expect(port.getLexiconEntries('goal-category')).toEqual([]);
    expect(port.getQuestionPack('goal-domain-success')).toEqual([]);
  });

  it('compiles word entries into a case-insensitive word-boundary regex and an alternation', () => {
    const port = buildRuntimeKnowledgePort([
      {
        kind: 'lexicon',
        pack: {
          key: 'learnable-subject',
          entries: [
            { phrase: 'java', role: 'x' },
            { phrase: 'visual studio code', role: 'x' },
          ],
        },
      },
    ]);
    const compiled = port.getLexicon('learnable-subject');
    expect(compiled.wordRegex).not.toBeNull();
    expect(compiled.wordRegex!.test('learning JAVA daily')).toBe(true);
    expect(compiled.wordRegex!.test('visual STUDIO code practice')).toBe(true);
    // Boundaries wrap the whole alternation: a fragment of a multi-word phrase
    // is not a match — "studio" alone does not read as "visual studio code".
    expect(compiled.wordRegex!.test('my studio')).toBe(false);
    expect(compiled.alternation).toBe('java|visual studio code');
  });

  it('escapes regex metacharacters in word entries — "$" matches literally via alternation', () => {
    const port = buildRuntimeKnowledgePort([
      { kind: 'lexicon', pack: { key: 'quantity-unit', entries: [{ phrase: '$' }, { phrase: 'kg' }] } },
    ]);
    const compiled = port.getLexicon('quantity-unit');
    expect(compiled.alternation).toBe('\\$|kg');
    // Symbol phrases are boundary-hostile inside \b…\b; the consumers that need
    // them embed the alternation in their own template, exactly as the legacy
    // quantity regex did: \b\d+\s*(kg|km|…|\$|€|£).
    const template = new RegExp(`\\b\\d+\\s*(${compiled.alternation})`, 'i');
    expect(template.test('save 200 $ monthly')).toBe(true);
    expect(template.test('save 200 kg monthly')).toBe(true);
    expect(template.test('save 200 monthly')).toBe(false);
  });

  it('compiles pattern entries with their raw source preserved for embedding', () => {
    const port = buildRuntimeKnowledgePort([
      {
        kind: 'lexicon',
        pack: {
          key: 'training-noun',
          entries: [{ phrase: 'training|workouts?', match: 'pattern' }],
        },
      },
    ]);
    const compiled = port.getLexicon('training-noun');
    expect(compiled.patterns[0].entry.phrase).toBe('training|workouts?');
    expect(compiled.patterns[0].regex.test('my workouts')).toBe(true);
    // A consumer may embed the raw source in a larger template.
    const template = new RegExp(`\\b(?:pause)\\b[^.?!]{0,5}\\b(?:${compiled.patterns[0].entry.phrase})\\b`);
    expect(template.test('pause workouts now')).toBe(true);
  });

  it('rejects a malformed pattern entry at build time — fail fast, never silently', () => {
    expect(() =>
      buildRuntimeKnowledgePort([
        {
          kind: 'lexicon',
          pack: { key: 'recommendation-material', entries: [{ phrase: 'books?([unclosed', match: 'pattern' }] },
        },
      ]),
    ).toThrow(RuntimeContentError);
  });

  it('rejects an unregistered pack key at build time', () => {
    expect(() =>
      buildRuntimeKnowledgePort([
        { kind: 'lexicon', pack: { key: 'books' as never, entries: [{ phrase: 'x' }] } },
      ]),
    ).toThrow(RuntimeContentError);
  });
});

describe('runtimeContentPackSchema (malformed packs are rejected)', () => {
  const validPack: RuntimeContentPack = {
    kind: 'lexicon',
    pack: { key: 'create-verb', entries: [{ phrase: 'learn' }] },
  };

  it('accepts a valid pack', () => {
    expect(runtimeContentPackSchema.safeParse(validPack).success).toBe(true);
  });

  it('rejects unknown keys, empty phrases, bad ids, oversized options', () => {
    expect(
      runtimeContentPackSchema.safeParse({
        kind: 'lexicon',
        pack: { key: 'not-a-key', entries: [] },
      }).success,
    ).toBe(false);
    expect(
      runtimeContentPackSchema.safeParse({
        kind: 'lexicon',
        pack: { key: 'create-verb', entries: [{ phrase: '   ' }] },
      }).success,
    ).toBe(false);
    expect(
      runtimeContentPackSchema.safeParse({
        kind: 'questions',
        pack: {
          key: 'goal-domain-success',
          questions: [{ id: 'Bad Id', purpose: 'p', prompt: 'p', type: 'FREE_TEXT' }],
        },
      }).success,
    ).toBe(false);
    expect(
      runtimeContentPackSchema.safeParse({
        kind: 'questions',
        pack: {
          key: 'goal-domain-success',
          questions: [
            {
              id: 'ok_id',
              purpose: 'p',
              prompt: 'p',
              type: 'SINGLE_SELECT',
              options: Array.from({ length: 9 }, (_, i) => `o${i}`),
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

describe('installation and replacement (no stale compiled data)', () => {
  it('an unbootstrapped process reads the NullPort — empty and safe', () => {
    resetRuntimeKnowledge();
    expect(isRuntimeKnowledgeInstalled()).toBe(false);
    expect(getRuntimeKnowledge().getLexicon('goal-category').phrases).toEqual([]);
  });

  it('replacing the port discards everything compiled for the predecessor', () => {
    const first = buildRuntimeKnowledgePort([
      { kind: 'lexicon', pack: { key: 'goal-category', entries: [{ phrase: 'fitness', role: 'FITNESS' }] } },
    ]);
    setRuntimeKnowledge(first);
    expect(getRuntimeKnowledge().getLexicon('goal-category').wordRegex!.test('fitness')).toBe(true);

    const second = buildRuntimeKnowledgePort([
      { kind: 'lexicon', pack: { key: 'goal-category', entries: [{ phrase: 'zindle', role: 'FLORP' }] } },
    ]);
    setRuntimeKnowledge(second);
    // The new port knows nothing of the old vocabulary — no stale merge.
    expect(getRuntimeKnowledge().getLexicon('goal-category').wordRegex!.test('fitness')).toBe(false);
    expect(getRuntimeKnowledge().getLexicon('goal-category').wordRegex!.test('zindle')).toBe(true);
    expect(isRuntimeKnowledgeInstalled()).toBe(true);
  });

  it('per-port memoization never serves one port the data of another', () => {
    resetRuntimeKnowledge();
    const a = getRuntimeKnowledge();
    const builtA = portMemo(a, 'marker', () => ({ marker: 'A' }));
    setRuntimeKnowledge(buildRuntimeKnowledgePort([]));
    const b = getRuntimeKnowledge();
    const builtB = portMemo(b, 'marker', () => ({ marker: 'B' }));
    expect(builtA.marker).toBe('A');
    expect(builtB.marker).toBe('B');
    // Same port, same tag → cached; different port → rebuilt.
    expect(portMemo(a, 'marker', () => ({ marker: 'A' }))).toBe(builtA);
  });
});
