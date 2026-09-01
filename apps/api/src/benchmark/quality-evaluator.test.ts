import { describe, expect, it } from 'vitest';
import { planningSufficiencyForScoring } from './quality-evaluator.js';
import { evaluateSemanticCase } from './semantic-validator.js';
import { evaluateUsefulness, passesQualityGates, scoreInterviewQuality, scoreStructuralQuality } from './quality-evaluator.js';
import { REAL_WORLD_FIXTURES } from './real-world-fixtures.js';

const generic = {
  title: 'Get fitter',
  description: 'A plan for getting fitter.',
  rationale: 'You can adjust this starting plan.',
  tasks: [{
    title: 'Get started',
    description: 'Start working on your goal.',
    reason: 'Starting small makes the goal easier.',
    recurrenceType: 'ONCE' as const,
    recurrenceConfig: {},
    estimatedMinutes: 20,
  }],
};

const useful = {
  title: 'Build general fitness',
  description: 'Combine aerobic movement with basic strength.',
  rationale: 'You chose general fitness, so this balances endurance and strength.',
  tasks: [
    {
      title: 'Brisk walk', description: 'Walk at a steady conversational pace.',
      reason: 'You wanted an accessible endurance activity.', recurrenceType: 'TIMES_PER_WEEK' as const,
      recurrenceConfig: { timesPerWeek: 3 }, estimatedMinutes: 30,
    },
    {
      title: 'Full-body strength practice', description: 'Complete a short beginner strength circuit.',
      reason: 'You wanted balanced general fitness.', recurrenceType: 'TIMES_PER_WEEK' as const,
      recurrenceConfig: { timesPerWeek: 2 }, estimatedMinutes: 25,
    },
  ],
};

describe('usefulness benchmark', () => {
  it('fails a schema-valid placeholder even with a perfect structural score', () => {
    const result = evaluateSemanticCase({}, {
      prompt: 'I want to get fitter',
      draft: generic,
      interview: [{ question: { prompt: 'What specific target would make this successful?' } }],
    });
    expect(result.structuralScore).toBe(100);
    expect(result.usefulnessScore).toBeLessThan(75);
    expect(result.finalPass).toBe(false);
  });

  it('passes a concrete complementary plan through both hard gates', () => {
    const result = evaluateSemanticCase({}, {
      prompt: 'I want to get fitter',
      draft: useful,
      interview: [{ question: { prompt: 'What specific target would make this successful?' } }],
    });
    expect(result.structuralScore).toBeGreaterThanOrEqual(90);
    expect(result.usefulnessScore).toBeGreaterThanOrEqual(75);
    expect(result.finalPass).toBe(true);
  });

  it('scores questionnaire padding below an efficient interview', () => {
    const efficient = scoreInterviewQuality('I want to get fitter', [
      { question: { prompt: 'What specific target matters most?' } },
    ]);
    const padded = scoreInterviewQuality('I want to get fitter', [
      { question: { prompt: 'What motivates you?' } },
      { question: { prompt: 'How confident are you?' } },
      { question: { prompt: 'Why is this important to you?' } },
      { question: { prompt: 'What obstacles do you have?' } },
    ]);
    expect(efficient.score).toBe(10);
    expect(padded.score).toBeLessThan(efficient.score);
  });

  it('enforces the published hard gates', () => {
    expect(passesQualityGates({ criticalFailure: false, structuralScore: 90, usefulnessScore: 75 })).toBe(true);
    expect(passesQualityGates({ criticalFailure: false, structuralScore: 100, usefulnessScore: 74 })).toBe(false);
    expect(passesQualityGates({ criticalFailure: true, structuralScore: 100, usefulnessScore: 100 })).toBe(false);
  });

  it('separately rejects invalid recurrence structure', () => {
    const broken = {
      ...useful,
      tasks: [{ ...useful.tasks[0], recurrenceConfig: { timesPerWeek: 0 } }],
    };
    expect(scoreStructuralQuality(broken).criticalFailure).toBe(true);
    expect(scoreStructuralQuality(generic).score).toBe(100);
  });
});

describe('real-world regression architecture', () => {
  it('contains every normal-user case and gives ambiguous goals only one or two questions', () => {
    expect(REAL_WORLD_FIXTURES).toHaveLength(27);
    for (const fixture of REAL_WORLD_FIXTURES) {
      const sufficiency = planningSufficiencyForScoring(fixture.prompt);
      // A fixture's own declared range is the expectation: ambiguous goals get
      // one or two questions, detailed ones generate directly.
      expect(sufficiency.enough, fixture.prompt).toBe(fixture.questions.min === 0);
      expect(sufficiency.questionRange, fixture.prompt).toEqual(fixture.questions);
    }
  });

  it('allows a detailed 5 km request to generate with zero questions', () => {
    const fixture = REAL_WORLD_FIXTURES[15];
    expect(planningSufficiencyForScoring(fixture.prompt).enough).toBe(true);
    expect(scoreInterviewQuality(fixture.prompt, []).score).toBe(10);
  });

  it('exposes the complete 100-point usefulness rubric', () => {
    const result = evaluateUsefulness('I want to get fitter', useful, [
      { question: { prompt: 'What specific target matters most?' } },
    ]);
    expect(result.goalRelevance).toBeLessThanOrEqual(20);
    expect(result.taskSpecificity).toBeLessThanOrEqual(20);
    expect(result.planCompleteness).toBeLessThanOrEqual(15);
    expect(result.scheduleRealism).toBeLessThanOrEqual(15);
    expect(result.taskDiversity).toBeLessThanOrEqual(10);
    expect(result.personalization).toBeLessThanOrEqual(10);
    expect(result.interviewEfficiency).toBeLessThanOrEqual(10);
    expect(result.usefulnessScore).toBe(
      result.goalRelevance + result.taskSpecificity + result.planCompleteness
      + result.scheduleRealism + result.taskDiversity + result.personalization
      + result.interviewEfficiency,
    );
  });
});
