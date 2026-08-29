import { describe, expect, it } from 'vitest';
import {
  classifyFrequencyAnswer,
  CORRECTION_SIGNAL,
  frequencyConflictClarification,
  isFrequencyStatement,
  spokenUserStatements,
  statedFrequencyNumber,
  withCorrectionSignal,
} from './frequency-conflict.js';
import { applyModelExtraction, createContext, recordAnswer, serializeContext } from './context.js';

// These run entirely offline: the detector is pure — constraints parsed from
// the original goal text against one literal answer.

const everyWeekday = { exactWeekly: 5 as number | undefined, maxWeekly: undefined, allowedDays: [1, 2, 3, 4, 5] };
const atMostFour = { exactWeekly: undefined, maxWeekly: 4, allowedDays: undefined };
const monWedOnly = { exactWeekly: undefined, maxWeekly: undefined, allowedDays: [1, 3] };
const noFrequency = { exactWeekly: undefined, maxWeekly: undefined, allowedDays: undefined };

describe('frequency contradiction detector', () => {
  it('calls a number filling a stated gap consistent', () => {
    expect(classifyFrequencyAnswer(noFrequency, 3)).toBe('CONSISTENT');
    expect(classifyFrequencyAnswer(noFrequency, 'three days')).toBe('CONSISTENT');
  });

  it('calls a number at or under a stated ceiling consistent', () => {
    expect(classifyFrequencyAnswer(atMostFour, 3)).toBe('CONSISTENT');
    expect(classifyFrequencyAnswer(atMostFour, 4)).toBe('CONSISTENT');
  });

  it('calls a number equal to the stated exact total consistent', () => {
    expect(classifyFrequencyAnswer(everyWeekday, 5)).toBe('CONSISTENT');
    expect(classifyFrequencyAnswer(everyWeekday, 'weekdays')).toBe('CONSISTENT');
    expect(classifyFrequencyAnswer(everyWeekday, 'every weekday')).toBe('CONSISTENT');
  });

  it('calls chosen days that all fit the allowed days consistent', () => {
    expect(classifyFrequencyAnswer(monWedOnly, 'Monday and Wednesday')).toBe('CONSISTENT');
  });

  it('calls a non-schedule answer consistent whatever was stated', () => {
    expect(classifyFrequencyAnswer(everyWeekday, 'whenever I can fit it in')).toBe('CONSISTENT');
  });

  it('reads every correction-signal variant as a correction, not a contradiction', () => {
    for (const text of [
      'actually, 3 days per week',
      'Actually, make it 3 days per week',
      'please change to 3 days',
      'switch to 3 days instead',
      "let's do 3 days",
      'I only do 3 days',
      'reduce to 3 days',
      'Make it 3 days per week instead',
    ]) {
      expect(CORRECTION_SIGNAL.test(text), text).toBe(true);
      expect(classifyFrequencyAnswer(everyWeekday, text), text).toBe('CORRECTION');
    }
    // Even a correction that repeats the original number stays a correction.
    expect(classifyFrequencyAnswer(everyWeekday, 'actually, 5 days')).toBe('CORRECTION');
  });

  it('calls a different plan total a contradiction', () => {
    expect(classifyFrequencyAnswer(everyWeekday, 3)).toBe('CONTRADICTION');
    expect(classifyFrequencyAnswer(everyWeekday, '3')).toBe('CONTRADICTION');
    expect(classifyFrequencyAnswer(everyWeekday, 'three days per week')).toBe('CONTRADICTION');
    expect(classifyFrequencyAnswer({ ...everyWeekday, exactWeekly: 3 }, 5)).toBe('CONTRADICTION');
  });

  it('calls silently narrowing the stated total a contradiction', () => {
    // The original says 5; the answer says 3 with no correction signal — the
    // plan would quietly deviate from the original request.
    expect(classifyFrequencyAnswer(everyWeekday, 3)).toBe('CONTRADICTION');
  });

  it('calls exceeding a stated ceiling a contradiction', () => {
    expect(classifyFrequencyAnswer(atMostFour, 6)).toBe('CONTRADICTION');
  });

  it('calls a chosen day outside the allowed days a contradiction', () => {
    expect(classifyFrequencyAnswer(monWedOnly, 'Monday and Friday')).toBe('CONTRADICTION');
    expect(classifyFrequencyAnswer(monWedOnly, 'Friday')).toBe('CONTRADICTION');
  });

  it('maps whole-week wording to its plan total', () => {
    expect(statedFrequencyNumber('every weekday')).toBe(5);
    expect(statedFrequencyNumber('weekdays')).toBe(5);
    expect(statedFrequencyNumber('daily')).toBe(7);
    expect(statedFrequencyNumber('twice a week')).toBe(2);
    expect(statedFrequencyNumber('Monday, Wednesday')).toBeNull();
    expect(statedFrequencyNumber(3)).toBe(3);
  });
});

describe('frequency statement selection', () => {
  it('picks frequency answers by key and by question wording', () => {
    const context = createContext('Read 20 pages every weekday evening.');
    recordAnswer(context, {
      key: 'essential_frequency',
      questionId: 'essential_frequency',
      question: 'How many days per week can you realistically work on this goal?',
      value: 3,
    });
    recordAnswer(context, { key: 'session_length', questionId: 'q2', question: 'How many minutes per session?', value: 30 });
    const statements = spokenUserStatements(context.entries);
    expect(statements.filter(isFrequencyStatement).map((s) => s.key)).toEqual(['essential_frequency']);
  });

  it('treats a resolve answer as a frequency statement whatever its wording', () => {
    expect(isFrequencyStatement({ key: 'resolve_frequency_conflict', value: 'Make it 3 days per week' })).toBe(true);
  });

  it('includes a direct message only when it re-states a schedule with a signal', () => {
    expect(isFrequencyStatement({ key: 'schedule_note', value: 'Actually, make it 3 days', fromMessage: true })).toBe(true);
    expect(isFrequencyStatement({ key: 'schedule_note', value: 'I meant swimming', fromMessage: true })).toBe(false);
    // A bare number in a message without a signal is not a weekly total.
    expect(isFrequencyStatement({ key: 'schedule_note', value: '20 pages', fromMessage: true })).toBe(false);
  });
});

describe('frequency conflict clarification', () => {
  const GOAL = 'Read 20 pages of nonfiction every weekday evening.';
  const FREQUENCY_QUESTION = 'How many days per week can you realistically work on this goal?';

  const clarificationFor = (statements: Parameters<typeof frequencyConflictClarification>[1]) =>
    frequencyConflictClarification(GOAL, statements, '2026-08-29');

  it('asks which schedule to use, naming both numbers', () => {
    const conflict = clarificationFor([
      { key: 'essential_frequency', question: FREQUENCY_QUESTION, value: 3 },
    ]);
    expect(conflict?.message).toBe(
      'You originally said every weekday (5 days a week), but your latest answer says 3 days per week. Which schedule should I use?',
    );
    expect(conflict?.question).toMatchObject({ id: 'resolve_frequency_conflict', type: 'FREE_TEXT', optional: false, allowCustomAnswer: true });
    expect(conflict?.question.prompt).toBe(conflict?.message);
  });

  it('stays silent when the latest answer agrees with the goal', () => {
    expect(clarificationFor([{ key: 'essential_frequency', question: FREQUENCY_QUESTION, value: 5 }])).toBeNull();
    expect(clarificationFor([{ key: 'essential_frequency', question: FREQUENCY_QUESTION, value: 3 }])).not.toBeNull();
  });

  it('stays silent when the goal stated no frequency at all', () => {
    expect(frequencyConflictClarification(
      'Read 20 pages of nonfiction.',
      [{ key: 'essential_frequency', question: FREQUENCY_QUESTION, value: 3 }],
      '2026-08-29',
    )).toBeNull();
  });

  it('stays silent once a resolution was recorded after the contradiction', () => {
    expect(clarificationFor([
      { key: 'essential_frequency', question: FREQUENCY_QUESTION, value: 3 },
      { key: 'resolve_frequency_conflict', value: 'Make it 3 days per week' },
    ])).toBeNull();
  });

  it('accepts a direct correction message as the resolution without an extra question', () => {
    expect(clarificationFor([
      { key: 'essential_frequency', question: FREQUENCY_QUESTION, value: 3 },
      { key: 'schedule_note', value: 'Actually, make it 3 days', fromMessage: true },
    ])).toBeNull();
  });

  it('judges the latest statement, not the first contradiction seen', () => {
    // The user first contradicted, then re-answered agreeing — the latest word wins.
    expect(clarificationFor([
      { key: 'essential_frequency', question: FREQUENCY_QUESTION, value: 3 },
      { key: 'days_followup', question: 'Which days of the week suit you best?', value: 'Every weekday' },
    ])).toBeNull();
  });
});

describe('recording a conflict resolution', () => {
  it('wraps a bare number so it reads as the correction it is', () => {
    expect(withCorrectionSignal(3)).toBe('Make it 3 days per week');
    expect(withCorrectionSignal('3')).toBe('Make it 3 days per week');
    expect(withCorrectionSignal('three')).toBe('Make it three days per week');
  });

  it('wraps schedule wording without touching the user’s words', () => {
    expect(withCorrectionSignal('every weekday')).toBe('Make it every weekday');
    expect(withCorrectionSignal('Monday, Wednesday and Friday')).toBe('Make it Monday, Wednesday and Friday');
  });

  it('keeps answers that already carry the correction or a resolution verb', () => {
    expect(withCorrectionSignal('Actually, make it 3 days')).toBe('Actually, make it 3 days');
    expect(withCorrectionSignal('reduce to two days')).toBe('reduce to two days');
    expect(withCorrectionSignal('allow two sessions on one day')).toBe('allow two sessions on one day');
    expect(withCorrectionSignal('Make Friday available')).toBe('Make Friday available');
    expect(withCorrectionSignal('Add Saturday as an available day')).toBe('Add Saturday as an available day');
  });

  it('records the wrapped value through the normal answer path', () => {
    const context = createContext('Read 20 pages every weekday evening.');
    recordAnswer(context, { key: 'resolve_frequency_conflict', questionId: 'resolve_frequency_conflict', value: withCorrectionSignal(3) });
    expect(serializeContext(context)).toContain('Make it 3 days per week');
  });

  it('keeps a model-relayed correction message at user authority', () => {
    const context = createContext('Read 20 pages every weekday evening.');
    applyModelExtraction(context, {}, [], { schedule_note: 'Actually, make it 3 days' });
    const statements = spokenUserStatements(context.entries);
    expect(statements).toHaveLength(1);
    expect(statements[0].fromMessage).toBe(true);
    expect(isFrequencyStatement(statements[0])).toBe(true);
  });
});
