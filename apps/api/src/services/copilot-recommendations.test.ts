import { describe, expect, it } from 'vitest';
import type { ProgressAnalysisV7, RecommendationItem } from '../ai/schemas.js';
import {
  normalizeRecommendations,
  priorRecommendationIdentities,
  recommendationIdentity,
  RecommendationValidationError,
  serializePriorRecommendations,
  validateRecommendationTurn,
  type RecommendationHistorySource,
} from './copilot-recommendations.js';

// Pure, offline: these pin the Stage 1 recommendation machinery before any
// wiring exists. Nothing here knows what a book is.

const item = (overrides: Partial<RecommendationItem> = {}): RecommendationItem => ({
  entityType: 'pottery_class',
  displayName: 'Wheel Throwing for Beginners',
  attribution: 'Clay House Studio',
  reason: 'Close by and beginner-friendly.',
  ...overrides,
});

const analysis = (overrides: Partial<ProgressAnalysisV7>): ProgressAnalysisV7 => ({
  explanation: 'Here is what I found.',
  suggestions: [],
  recommendsItems: false,
  recommendations: [],
  ...overrides,
});

describe('recommendationIdentity', () => {
  it('ignores case and surrounding whitespace — "The Example" and "the example" are one item', () => {
    expect(recommendationIdentity(item({ displayName: 'The Example', attribution: 'John Smith' }))).toBe(
      recommendationIdentity(item({ displayName: 'the example', attribution: 'john smith' })),
    );
    expect(recommendationIdentity(item({ displayName: '  The Example ', attribution: ' John Smith ' }))).toBe(
      recommendationIdentity(item({ displayName: 'The Example', attribution: 'John Smith' })),
    );
  });

  it('includes attribution in identity', () => {
    expect(recommendationIdentity(item({ attribution: 'John Smith' }))).not.toBe(
      recommendationIdentity(item({ attribution: 'Jane Smith' })),
    );
  });

  it('treats a missing attribution as the empty attribution', () => {
    expect(recommendationIdentity(item({ attribution: undefined }))).toBe(
      recommendationIdentity(item({ attribution: '' })),
    );
  });

  it('excludes entityType from identity — the same item under two labels is one item', () => {
    expect(recommendationIdentity(item({ entityType: 'book' }))).toBe(
      recommendationIdentity(item({ entityType: 'pottery_class' })),
    );
  });
});

describe('normalizeRecommendations', () => {
  it('drops in-turn duplicates by identity, first one wins', () => {
    const result = normalizeRecommendations([
      item({ displayName: 'The Example', attribution: 'John Smith' }),
      item({ displayName: 'the EXAMPLE', attribution: 'john SMITH', reason: 'a duplicate' }),
      item({ displayName: 'Something Else' }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].reason).toBe('Close by and beginner-friendly.');
    expect(result[1].displayName).toBe('Something Else');
  });

  it('caps at MAX_RECOMMENDATIONS as a mechanic bound', () => {
    const items = Array.from({ length: 20 }, (_, i) => item({ displayName: `Item ${i}` }));
    expect(normalizeRecommendations(items)).toHaveLength(12);
  });

  it('tolerates null and undefined payloads', () => {
    expect(normalizeRecommendations(null)).toEqual([]);
    expect(normalizeRecommendations(undefined)).toEqual([]);
  });
});

describe('priorRecommendationIdentities', () => {
  it('collects identities across every history entry', () => {
    const history: RecommendationHistorySource[] = [
      { recommendations: [item({ displayName: 'First' })] },
      { recommendations: [item({ displayName: 'Second' }), item({ displayName: 'first' })] },
      {},
    ];
    const identities = priorRecommendationIdentities(history);
    expect(identities.has('first|clay house studio')).toBe(true);
    expect(identities.has('second|clay house studio')).toBe(true);
    expect(identities.size).toBe(2);
  });

  it('tolerates entries without recommendations and null arrays', () => {
    expect(priorRecommendationIdentities([{}, { recommendations: null }]).size).toBe(0);
  });
});

describe('serializePriorRecommendations', () => {
  it('renders the prompt block from structured history only', () => {
    const history: RecommendationHistorySource[] = [
      { recommendations: [item({ displayName: 'First Item' })] },
    ];
    const block = serializePriorRecommendations(history);
    expect(block).toContain('Recent structured recommendations');
    expect(block).toContain('Do not repeat these items');
    expect(block).toContain('- entityType: pottery_class');
    expect(block).toContain('  displayName: First Item');
    expect(block).toContain('  attribution: Clay House Studio');
  });

  it('omits the attribution line when the item has none', () => {
    const block = serializePriorRecommendations([{ recommendations: [item({ attribution: undefined })] }]);
    expect(block).not.toContain('attribution:');
  });

  it('returns an empty string when the history carries no recommendations', () => {
    expect(serializePriorRecommendations([{}, {}, {}])).toBe('');
    expect(serializePriorRecommendations([])).toBe('');
  });

  it('walks newest-first and caps at 12 items', () => {
    const history: RecommendationHistorySource[] = [
      { recommendations: Array.from({ length: 8 }, (_, i) => item({ displayName: `Old ${i}` })) },
      { recommendations: Array.from({ length: 8 }, (_, i) => item({ displayName: `New ${i}` })) },
    ];
    const block = serializePriorRecommendations(history);
    expect(block).toContain('New 0');
    expect(block).toContain('New 7');
    // 8 fresh "New" items leave room for the 4 newest "Old" ones: Old 7..Old 4.
    expect(block).toContain('Old 7');
    expect(block).toContain('Old 4');
    expect(block).not.toContain('Old 3');
    expect(block).not.toContain('Old 0');
  });
});

describe('validateRecommendationTurn (the Stage 1 consistency contract)', () => {
  const emptyPrior = new Set<string>();

  it('accepts declares-true with fresh items', () => {
    const result = validateRecommendationTurn({
      analysis: analysis({ recommendsItems: true, recommendations: [item()] }),
      priorIdentities: emptyPrior,
    });
    expect(result.violations).toEqual([]);
    expect(result.items).toHaveLength(1);
  });

  it('accepts declares-false with no items as prose-only advice', () => {
    const result = validateRecommendationTurn({
      analysis: analysis({ recommendsItems: false, recommendations: [] }),
      priorIdentities: emptyPrior,
    });
    expect(result.violations).toEqual([]);
    expect(result.items).toEqual([]);
  });

  it('violates on declares-true with an empty list', () => {
    const result = validateRecommendationTurn({
      analysis: analysis({ recommendsItems: true, recommendations: [] }),
      priorIdentities: emptyPrior,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatch(/is empty/);
  });

  it('violates on declares-true where every item is a structured-history repeat', () => {
    const prior = priorRecommendationIdentities([{ recommendations: [item()] }]);
    const result = validateRecommendationTurn({
      analysis: analysis({ recommendsItems: true, recommendations: [item({ reason: 'again' })] }),
      priorIdentities: prior,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatch(/already appears in the recent conversation/);
    expect(result.items).toEqual([]);
  });

  it('violates on declares-false with items — the fields must agree', () => {
    const result = validateRecommendationTurn({
      analysis: analysis({ recommendsItems: false, recommendations: [item()] }),
      priorIdentities: emptyPrior,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatch(/Set "recommendsItems" to true/);
  });

  it('keeps fresh items and silently drops history repeats when other fresh items exist', () => {
    const prior = priorRecommendationIdentities([{ recommendations: [item({ displayName: 'Old One' })] }]);
    const result = validateRecommendationTurn({
      analysis: analysis({
        recommendsItems: true,
        recommendations: [item({ displayName: 'Old One' }), item({ displayName: 'New One' })],
      }),
      priorIdentities: prior,
    });
    expect(result.violations).toEqual([]);
    expect(result.items.map((i) => i.displayName)).toEqual(['New One']);
  });

  it('never consults the explanation prose — only the structured collection and history', () => {
    // A book-shaped prose answer with no structured items and no self-report is
    // prose-only advice under the flag-on contract, nothing more.
    const result = validateRecommendationTurn({
      analysis: analysis({
        explanation: 'Try "The Example" by John Smith, a wonderful introduction.',
        recommendsItems: false,
        recommendations: [],
      }),
      priorIdentities: emptyPrior,
    });
    expect(result.violations).toEqual([]);
    expect(result.items).toEqual([]);
  });
});

describe('RecommendationValidationError', () => {
  it('is a typed, retryable failure carrying the violations', () => {
    const err = new RecommendationValidationError(['violation one', 'violation two']);
    expect(err.code).toBe('RECOMMENDATIONS_INVALID');
    expect(err.name).toBe('RecommendationValidationError');
    expect(err.violations).toEqual(['violation one', 'violation two']);
    expect(err).toBeInstanceOf(Error);
  });
});
