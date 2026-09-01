import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyIntent,
  classifyIntentDeterministic,
  INTENT_CLARIFICATION,
  INTENT_CONFIDENCE_THRESHOLD,
  type CopilotIntentResult,
} from './intent-router.js';
import { installRuntimeContent } from '../runtime-content.js';

// The routing vocabularies (verbs, nouns, topics) are runtime data; the port
// must exist before the rules compile (the same bootstrap the server runs).
installRuntimeContent();

// The routing layer's contract, in order of how badly it fails if broken:
// a question must never start an interview, a goal statement must never be
// lost, and a broken LLM fallback must degrade to UNKNOWN — never to
// CREATE_GOAL.

const create = (text: string, opts?: { hasGoalContext?: boolean }) =>
  classifyIntentDeterministic(text, opts);

const llmResult = (intent: CopilotIntentResult['intent'], confidence: number): CopilotIntentResult => ({
  intent,
  confidence,
  method: 'llm',
});

describe('classifyIntentDeterministic — CREATE_GOAL', () => {
  it('accepts explicit first-person commitments', () => {
    for (const text of [
      'I want to get fitter',
      'I need to exercise more',
      "I'm going to start running three times a week",
      'My goal is to read one book a month',
      'Help me build a daily meditation habit',
      "I'd like to cook more at home",
      'I will study Japanese for 20 minutes daily',
      'I can study at most six hours per week in three evening blocks. Prepare me for an interview',
    ]) {
      const result = create(text);
      expect(result.intent, text).toBe('CREATE_GOAL');
      expect(result.confidence).toBeGreaterThanOrEqual(INTENT_CONFIDENCE_THRESHOLD);
      expect(result.method).toBe('deterministic');
    }
  });

  it('accepts bare imperative goal statements', () => {
    for (const text of [
      'learn Java',
      'read more books',
      'save money',
      'Build an emergency fund while paying debt',
      'drink more water',
      'walk 30 minutes every day',
      'Track my water intake every day',
    ]) {
      expect(create(text).intent, text).toBe('CREATE_GOAL');
    }
  });

  it('accepts goal-management phrasing, including authority talk', () => {
    // These are create-intents for the benchmark even though they read like
    // administration: the speaker is steering their plan, not asking a question.
    for (const text of [
      'I reject the proposed increase. Keep my current schedule at two sessions per week.',
      'I accept adding exactly one weekly practice session and no other change.',
      'Pause training for two weeks and let me decide whether and when to resume.',
      'Recommend whether I should progress, stay, reduce or pause. Do not apply it until I approve it.',
    ]) {
      expect(create(text).intent, text).toBe('CREATE_GOAL');
    }
  });

  it('does not mistake an informational want for a commitment', () => {
    expect(create('I want to know how streaks work').intent).not.toBe('CREATE_GOAL');
    expect(create('I need to see my coins').intent).not.toBe('CREATE_GOAL');
  });

  it('never classifies question-shaped text as a goal', () => {
    expect(create('Can you help me decide whether I should exercise more?').intent).not.toBe('CREATE_GOAL');
    expect(create('Should I set a goal of running 5km?').intent).not.toBe('CREATE_GOAL');
    expect(create('I want to get fitter, right?').intent).not.toBe('CREATE_GOAL');
  });
});

describe('classifyIntentDeterministic — PRODUCT_HELP', () => {
  it('catches the product-mechanics questions the audit flagged', () => {
    for (const text of [
      'What happens if I miss a day?',
      'Why did my streak reset?',
      'How many coins do I get?',
      'How much is premium?',
      'Do you sell my data?',
      'How do goals work?',
      'How do I log out?',
      'How do I turn off notifications?',
    ]) {
      expect(create(text).intent, text).toBe('PRODUCT_HELP');
    }
  });

  it('catches product mechanics stated as a sentence, not only as questions', () => {
    expect(create('I need to reset my password').intent).toBe('PRODUCT_HELP');
  });
});

describe('classifyIntentDeterministic — GOAL_QUESTION', () => {
  it('catches status questions and past-tense reports about the goal', () => {
    for (const text of [
      'how am I doing?',
      'why am I behind',
      'when is my next workout?',
      'did I complete my tasks yesterday?',
      'I missed my workout yesterday',
      'I skipped my study session today',
    ]) {
      expect(create(text).intent, text).toBe('GOAL_QUESTION');
    }
  });

  it('reports the goal context through confidence, not through a different intent', () => {
    const withContext = create('how am I doing?', { hasGoalContext: true });
    const without = create('how am I doing?');
    expect(withContext.confidence).toBeGreaterThan(without.confidence);
    expect(withContext.intent).toBe(without.intent);
  });
});

describe('classifyIntentDeterministic — MODIFY_GOAL', () => {
  it('catches explicit edit phrasing', () => {
    for (const text of [
      'make it three days instead',
      'make the gym one three days instead',
      'move my run to Friday',
      'make my walks easier',
      'remove the meditation task',
      'add stretching to my goal',
      'change my deadline to March',
    ]) {
      expect(create(text).intent, text).toBe('MODIFY_GOAL');
    }
  });

  it('does not steal imperative goal statements that merely say make or set', () => {
    expect(create('make my bed every day').intent).toBe('CREATE_GOAL');
  });
});

describe('classifyIntentDeterministic — GENERAL_QUESTION and UNKNOWN', () => {
  it('routes greetings and advice questions away from the interview', () => {
    for (const text of [
      'hi',
      'hello there!',
      'good morning',
      'thanks!',
      'Can you help me decide whether I should exercise more?',
      'Should I train in the morning or evening?',
      'Can you give me advice on staying motivated?',
    ]) {
      expect(create(text).intent, text).toBe('GENERAL_QUESTION');
    }
  });

  it('returns UNKNOWN at confidence 0 when no rule fires — never a guess', () => {
    for (const text of ['what?', 'asdf qwerty', 'purple monkey dishwasher', '???', 'hmm', '']) {
      const result = create(text);
      expect(result, text).toEqual({ intent: 'UNKNOWN', confidence: 0, method: 'deterministic' });
    }
  });
});

describe('classifyIntent — LLM fallback', () => {
  it('does not call the fallback when the rules have a verdict', async () => {
    const fallback = vi.fn();
    const result = await classifyIntent('I want to get fitter', {}, fallback);
    expect(result.intent).toBe('CREATE_GOAL');
    expect(result.method).toBe('deterministic');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('accepts a strictly valid LLM verdict above the threshold', async () => {
    const fallback = vi.fn(async () => llmResult('PRODUCT_HELP', 0.9));
    const result = await classifyIntent('blue apple', {}, fallback);
    expect(result).toEqual({ intent: 'PRODUCT_HELP', confidence: 0.9, method: 'llm' });
  });

  it('discards an LLM verdict below the threshold as UNKNOWN', async () => {
    const fallback = vi.fn(async () => llmResult('CREATE_GOAL', INTENT_CONFIDENCE_THRESHOLD - 0.01));
    const result = await classifyIntent('blue apple', {}, fallback);
    expect(result.intent).toBe('UNKNOWN');
    expect(result.method).toBe('llm');
  });

  it.each([
    ['unknown intent name', async () => llmResult('START_A_BUSINESS' as never, 0.99)],
    ['non-number confidence', async () => ({ intent: 'CREATE_GOAL', confidence: 'high' })],
    ['out-of-range confidence', async () => ({ intent: 'CREATE_GOAL', confidence: 1.5 })],
    ['missing confidence', async () => ({ intent: 'CREATE_GOAL' })],
    ['null', async () => null],
  ])('degrades %s to UNKNOWN, never CREATE_GOAL', async (_label, fallback) => {
    const result = await classifyIntent('blue apple', {}, fallback as () => Promise<CopilotIntentResult | null>);
    expect(result.intent).toBe('UNKNOWN');
  });

  it('degrades a thrown provider error to UNKNOWN', async () => {
    const fallback = vi.fn(async () => {
      throw new Error('provider down');
    });
    const result = await classifyIntent('blue apple', {}, fallback);
    expect(result.intent).toBe('UNKNOWN');
  });

  it('degrades a hanging fallback to UNKNOWN once the timeout passes', async () => {
    const fallback = vi.fn(
      () => new Promise<CopilotIntentResult>(() => llmResult('CREATE_GOAL', 0.99)),
    );
    const result = await classifyIntent('blue apple', { llmTimeoutMs: 10 }, fallback);
    expect(result.intent).toBe('UNKNOWN');
  });

  it('works without a fallback at all', async () => {
    expect((await classifyIntent('what?')).intent).toBe('UNKNOWN');
    expect((await classifyIntent('I want to get fitter')).intent).toBe('CREATE_GOAL');
  });
});

describe('the frozen intent benchmark runner', () => {
  const script = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'scripts', 'intent-benchmark.mjs');

  it('runs the offline benchmark green against the frozen fixtures', () => {
    // Stage 6: the vocabularies are runtime data behind the port, installed
    // unconditionally by the runner — there is no flag mode left to compare.
    // Every frozen fixture must classify exactly as the parity gate pinned.
    const output = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toContain('frozen-100 compatibility: 100/100');
    expect(output).toContain('PASS');
  });
});

describe('the clarification contract', () => {
  it('offers exactly two ways forward and invents no answer', () => {
    expect(INTENT_CLARIFICATION).toBe(
      'Do you want me to create a goal for this, or are you asking a question?',
    );
  });
});
