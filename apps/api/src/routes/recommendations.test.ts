import { describe, expect, it } from 'vitest';
import { recommendationMutationSchema } from './recommendations.js';

// The mutation endpoint's contract, tested at the schema level: the route
// itself is thin (auth, one ownership check, one service call) and is covered
// end-to-end by the acceptance suite.

const validBody = {
  action: 'mark_consumed' as const,
  operationId: '0b9e6c35-f4de-4f99-9b55-39f24b0d1c11',
  entityType: 'pottery_class',
  displayName: 'Wheel Throwing for Beginners',
};

describe('recommendationMutationSchema', () => {
  it('accepts a minimal action with the domain-open entity fields', () => {
    const parsed = recommendationMutationSchema.parse(validBody);
    expect(parsed.action).toBe('mark_consumed');
    expect(parsed.displayName).toBe('Wheel Throwing for Beginners');
  });

  it('rejects unregistered actions — the kind set is closed', () => {
    expect(() =>
      recommendationMutationSchema.parse({ ...validBody, action: 'execute_command' }),
    ).toThrow();
  });

  it('enforces the operationId shape', () => {
    for (const operationId of ['short', 'has spaces yes', 'a'.repeat(65), '']) {
      expect(() => recommendationMutationSchema.parse({ ...validBody, operationId })).toThrow();
    }
    expect(() =>
      recommendationMutationSchema.parse({ ...validBody, operationId: 'a'.repeat(64) }),
    ).not.toThrow();
  });

  it('rejects a note on mark_consumed — notes belong to corrections', () => {
    expect(() =>
      recommendationMutationSchema.parse({ ...validBody, note: 'not yet' }),
    ).toThrow();
  });

  it('accepts a correction with a note', () => {
    const parsed = recommendationMutationSchema.parse({
      ...validBody,
      action: 'correct_consumption',
      note: 'Actually, not yet.',
    });
    expect(parsed.note).toBe('Actually, not yet.');
  });

  it('normalizes the entity fields through the Stage 1 schema', () => {
    const parsed = recommendationMutationSchema.parse({
      ...validBody,
      entityType: '  Pottery_Class ',
      displayName: '  Wheel Throwing  ',
      attribution: null,
    });
    expect(parsed.entityType).toBe('pottery_class');
    expect(parsed.displayName).toBe('Wheel Throwing');
    expect(parsed.attribution).toBeNull();
  });
});
