import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRuntimeKnowledgePort,
  getRuntimeKnowledge,
  isRuntimeKnowledgeInstalled,
  RUNTIME_KNOWLEDGE_KEYS,
  setRuntimeKnowledge,
  type RuntimeContentPack,
} from '../ai/runtime-knowledge.js';
import { installRuntimeContent } from '../runtime-content.js';

// Stage 3 architecture guards — enforced permanently:
//
//   1. The runtime-knowledge port is the ONLY domain-knowledge surface the
//      Copilot core imports. Core modules (ai/**, services/copilot-*) may
//      import the port, never the domain-content packs.
//   2. runtime-content.ts is the sole composition root: the only non-test
//      module allowed to import domain-content/*, and it performs exactly
//      one install (plus server.ts, which calls it).
//   3. The inline legacy vocabulary tables are deleted: no core module
//      re-declares the migrated lexicons locally.
//   4. An absent port is a safe port: empty lexicons degrade generically,
//      and a replacement port can never inherit stale compiled data.

const apiSrc = join(__dirname, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('runtime boundary (Stage 3, canonical since Stage 6)', () => {
  it('Copilot core imports the port, never a domain-content pack', () => {
    const core = walk(join(apiSrc, 'ai'))
      .concat(walk(join(apiSrc, 'services')))
      .filter((file) => !file.includes('runtime-knowledge.ts'));
    const violations = core.filter((file) => /from\s+'[^']*domain-content\//.test(read(file)));
    expect(violations).toEqual([]);
  });

  it('runtime-content.ts is the sole importer of domain-content packs', () => {
    const importers = walk(apiSrc).filter(
      (file) => /from\s+'[^']*domain-content\//.test(read(file)) && !file.endsWith('.test.ts'),
    );
    const relative = importers.map((f) => f.slice(apiSrc.length + 1).replace(/\\/g, '/')).sort();
    expect(relative).toEqual(['runtime-content.ts']);
  });

  it('server bootstraps the port and the capability registry once, unconditionally', () => {
    const server = read(join(apiSrc, 'server.ts'));
    expect(server).toContain('installRuntimeContent()');
    expect(server).toContain('registerCapabilities()');
    // No flag may gate the bootstrap: composition is not a flag question.
    expect(server).not.toContain('COPILOT_RUNTIME_DOMAIN_CONTENT');
    expect(server).not.toContain('COPILOT_CAPABILITY_REGISTRY');
  });

  it('the migrated lexicons exist only as runtime data — no inline legacy table survives', () => {
    // The one mechanic surface that carried inline legacy vocabulary outside
    // the packs was goal-constraints.ts (role regexes). The role SOURCES are
    // runtime data now; the module must say so and must not re-declare them.
    const goalConstraints = read(join(apiSrc, 'ai', 'goal-constraints.ts'));
    expect(goalConstraints).toContain('runtime data');
    // No core module declares a hard-coded lexicon array for a migrated key.
    for (const file of walk(join(apiSrc, 'ai')).concat(walk(join(apiSrc, 'services')))) {
      const text = read(file);
      expect(text, file).not.toMatch(
        /const\s+(?:STATED_PATTERNS|DOMAIN_KEYWORDS|EXPLICIT_ACTIVITIES|LEARNABLE_SUBJECTS|NON_MEASURABLE_QUALITIES|READING_MATERIAL|BOOK_FALLBACKS)\s*=/,
      );
    }
  });

  it('an absent port degrades generically — never an inline vocabulary fallback', () => {
    expect(RUNTIME_KNOWLEDGE_KEYS.length).toBeGreaterThan(0);
    const prior = getRuntimeKnowledge();
    try {
      // Swap in the true NullPort-equivalent: a port built from zero packs.
      setRuntimeKnowledge(buildRuntimeKnowledgePort([]));
      for (const key of RUNTIME_KNOWLEDGE_KEYS) {
        const lexicon = getRuntimeKnowledge().getLexicon(key);
        expect(lexicon.wordRegex).toBeNull();
        expect(lexicon.patterns).toHaveLength(0);
      }
      expect(getRuntimeKnowledge().getQuestionPack('goal-domain')).toEqual([]);
    } finally {
      setRuntimeKnowledge(prior);
    }
  });

  it('a replacement port never inherits compiled data from its predecessor', () => {
    const packs: RuntimeContentPack[] = [
      { kind: 'lexicon', pack: { key: 'goal-category', entries: [{ phrase: 'florp', role: 'OTHER' }] } },
    ];
    setRuntimeKnowledge(buildRuntimeKnowledgePort(packs));
    try {
      expect(isRuntimeKnowledgeInstalled()).toBe(true);
      // Only the replacement's own phrase compiles; everything else is empty.
      expect(getRuntimeKnowledge().getLexicon('goal-category').phrases).toEqual(['florp']);
      expect(getRuntimeKnowledge().getLexicon('task-role').phrases).toEqual([]);
    } finally {
      // restore the composed production port for later tests in this worker
      installRuntimeContent();
    }
  });
});
