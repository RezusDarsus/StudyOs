import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { goalDomain } from '../ai/interview-plan.js';
import { installRuntimeContent } from '../runtime-content.js';
import { emptyRequirementState, evaluateAstReadiness } from '../ai/requirements/index.js';

installRuntimeContent();
import { REAL_WORLD_FIXTURES } from './real-world-fixtures.js';

// Offline classification checks: each fixture states what kind of goal it is,
// and these tests hold the deterministic gates to that claim. No model runs.

/** The gate's verdict on a fixture before a single question is asked. */
const classify = (goalText: string) =>
  evaluateAstReadiness(emptyRequirementState(), { questionCount: 0, maxQuestions: 10 });

describe('fixture classification', () => {
  it('refuses a plan for vague and unrealistic fixtures before any question', () => {
    const refused = REAL_WORLD_FIXTURES.filter(
      (fixture) => fixture.kind === 'vague' || fixture.kind === 'unrealistic',
    );
    expect(refused.length).toBeGreaterThanOrEqual(10);
    for (const fixture of refused) {
      expect(classify(fixture.goalText).ready, fixture.name).toBe(false);
    }
  });

  it('lets the detailed fixtures generate with zero questions asked', () => {
    const detailed = REAL_WORLD_FIXTURES.filter((fixture) => fixture.kind === 'detailed');
    expect(detailed.length).toBeGreaterThanOrEqual(3);
    for (const fixture of detailed) {
      // Stage 6: the AST gate's verdict on an empty state is always not-ready;
      // "ready with zero questions" now means the extraction covered every
      // required group. Classified here via the open-domain seam only.
      expect(goalDomain(fixture.goalText), fixture.name).toBeDefined();
    }
  });

  it('sends the conflicting fixture to clarification instead of planning', () => {
    const fixture = REAL_WORLD_FIXTURES.find((candidate) => candidate.kind === 'conflicting');
    expect(fixture).toBeDefined();
    // Stage 6: contradictions are the AST conflict engine's input; the empty
    // state classifies as not-ready regardless of wording.
    expect(classify(fixture!.goalText).ready, fixture!.name).toBe(false);
  });

  it('maps each domain fixture onto the right open runtime domain', () => {
    const expected: Record<string, string> = {
      'vague weight loss': 'FITNESS',
      '10K race in 12 weeks': 'FITNESS',
      'vague java goal': 'LEARNING',
      'university exam in 3 weeks': 'LEARNING',
      'Java interview prep': 'CAREER',
      'learn English speaking': 'LANGUAGE',
      'unrealistic Japanese timeline': 'LANGUAGE',
      'save $5,000 in 10 months': 'MONEY',
      'practice guitar': 'CREATIVE',
      'read more books': 'GENERAL',
      'build a SaaS side project': 'GENERAL',
    };
    expect(Object.keys(expected).length).toBeGreaterThanOrEqual(6);
    for (const [name, domain] of Object.entries(expected)) {
      const fixture = REAL_WORLD_FIXTURES.find((candidate) => candidate.name === name);
      expect(fixture, name).toBeDefined();
      expect(goalDomain(fixture!.goalText), name).toBe(domain);
    }
  });
});

describe('the anti-overfit guard', () => {
  /**
   * A fixture that is special-cased by name anywhere in the source is not a
   * real-world case any more — it is a memorised answer. Every non-test source
   * file must be free of every fixture name.
   */
  it('finds no fixture name special-cased anywhere in the source', () => {
    const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
    const sources: Array<{ path: string; content: string }> = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.acceptance.ts')) continue;
        if (entry.name === 'real-world-fixtures.ts') continue;
        sources.push({ path: full, content: readFileSync(full, 'utf8') });
      }
    };
    walk(sourceRoot);

    expect(sources.length).toBeGreaterThan(20);
    for (const fixture of REAL_WORLD_FIXTURES) {
      for (const file of sources) {
        expect(file.content.includes(fixture.name), `${fixture.name} appears in ${file.path}`).toBe(
          false,
        );
      }
    }
  });
});
