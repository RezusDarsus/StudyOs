import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emptyRequirementState,
  ingestExtraction,
  evaluateAstReadiness,
  detectConflicts,
  projectState,
  requirementFragmentSchema,
} from '../ai/requirements/index.js';

// Stage 5 architecture guards — enforced permanently:
//
//   1. Mechanic quarantine — requirement modules never import prompt text or
//      the AI client; they are pure deterministic engines.
//   2. Provenance is server-owned — the extraction schema has NO provenance
//      field, and USER_EXPLICIT is produced only by grounding.
//   3. Single source of truth — the contract projection never re-parses
//      prose: it imports no parser of goal text or transcript.
//   4. Model budget — the flag-ON interview turn is bounded at one extraction
//      call plus at most one schema repair.
//   5. Stage 4 isolation — the capability registry never reads requirement
//      state; authorization/confirmation/idempotency are unaffected.
//   6. No new DB schema — requirement state lives inside structuredContext.

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

const requirementModules = walk(join(apiSrc, 'ai', 'requirements'));

describe('mechanic quarantine (requirements modules are pure engines)', () => {
  it('no requirement module imports prompt text', () => {
    const violations = requirementModules.filter((file) =>
      /from\s+'[^']*prompts\.js'/.test(readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('no requirement module imports the model client or prisma', () => {
    const violations = requirementModules.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /from\s+'[^']*(client|prisma)\.js'/.test(text) && !file.endsWith('index.ts');
    });
    expect(violations).toEqual([]);
  });

  it('no requirement module imports Stage 1-4 prose parsers for semantic state', () => {
    // The contract projection derives from the AST, never by re-parsing the
    // goal text or the transcript.
    const projection = readFileSync(join(apiSrc, 'ai', 'requirements', 'contract-projection.ts'), 'utf8');
    expect(projection).not.toContain('parseExplicitGoalConstraints');
    expect(projection).not.toContain('parseFinancialPlan');
  });
});

describe('provenance is server-owned (model cannot assign USER_EXPLICIT)', () => {
  it('the extraction schema carries no provenance field', () => {
    const source = readFileSync(join(apiSrc, 'ai', 'requirements', 'extract-schema.ts'), 'utf8');
    // The only USER_EXPLICIT in the module is inside provenanceFor's output
    // contract — never an accepted input field.
    const schemaStart = source.indexOf('export const requirementFragmentSchema');
    const schemaSource = source.slice(schemaStart, source.indexOf('export type RequirementFragment'));
    expect(schemaSource).not.toContain('USER_EXPLICIT');
    expect(schemaSource).not.toContain('provenance');
  });

  it('explicitness requires a grounded quote against the CURRENT turn', () => {
    // Grounded against an unrelated historical sentence -> never user authority.
    const fragment = requirementFragmentSchema.parse({
      atoms: [{
        property: 'goal.outcome', scope: 'goal', relation: 'contains',
        value: { kind: 'text', value: 'run' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'completely fabricated quote',
      }],
    });
    const { state } = ingestExtraction(emptyRequirementState(), fragment, {
      turn: 5,
      message: 'the current turn says something else entirely',
      at: '2026-08-31T00:00:00.000Z',
    });
    expect(state.records[0].provenance).toBe('MODEL_INFERRED');
    expect(state.records[0].evidence).toBeNull();
  });
});

describe('model budget (one extraction call, at most one repair)', () => {
  it('the interview call passes maxAttempts 2 — no other attempt budget exists', () => {
    const session = readFileSync(join(apiSrc, 'services', 'copilot-session.ts'), 'utf8');
    expect(session).toContain('maxAttempts: 2');
    expect(session).not.toContain('maxAttempts: 3');
    // No flag-conditional budget: exactly one bounded path.
    expect((session.match(/maxAttempts:/g) ?? []).length).toBe(1);
  });
});

describe('Stage 4 isolation (requirements never touch the capability registry)', () => {
  it('no capability module imports the requirements engine', () => {
    const capabilityFiles = walk(join(apiSrc, 'capabilities'));
    const violations = capabilityFiles.filter((file) =>
      /from\s+'[^']*requirements\//.test(readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });
});

describe('no new DB schema (the AST rides inside structuredContext)', () => {
  it('the requirements state is JSON-in-TEXT, not a table', () => {
    const schema = readFileSync(join(apiSrc, '..', 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).not.toContain('model RequirementRecord');
    expect(schema).not.toContain('model RequirementGroup');
  });
});

describe('inert state never influences the projection (behavioral guard)', () => {
  it('a state full of non-ACTIVE records projects nothing and blocks nothing', () => {
    const state = emptyRequirementState();
    const fragment = requirementFragmentSchema.parse({
      atoms: [{
        property: 'goal.outcome', scope: 'goal', relation: 'contains',
        value: { kind: 'text', value: 'run' }, strength: 'REQUIRED',
        source: 'stated', evidence: 'run',
      }],
    });
    const { state: withRecord } = ingestExtraction(emptyRequirementState(), fragment, {
      turn: 1, message: 'go for a run', at: '2026-08-31T00:00:00.000Z',
    });
    // Everything non-ACTIVE is stripped by hand to simulate inert history.
    const inert: typeof withRecord = {
      records: withRecord.records.map((r) => ({ ...r, status: 'SUPERSEDED' as const })),
      groups: withRecord.groups.map((g) => ({ ...g, status: 'QUARANTINED' as const })),
    };
    expect(projectState(inert).atoms).toHaveLength(0);
    expect(detectConflicts(projectState(inert))).toHaveLength(0);
    // Readiness treats it as an empty interview: required coverage missing.
    const readiness = evaluateAstReadiness(inert, { questionCount: 1, maxQuestions: 10 });
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain('DESIRED_OUTCOME');
    void state;
  });
});
