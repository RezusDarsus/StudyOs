import { describe, expect, it } from 'vitest';
import {
  promoteMultiSelect,
  questionBudget,
  questionTopic,
  redundancyReason,
} from './interview-plan.js';
import type { CopilotQuestion } from './schemas.js';

// These tests exist because of one real interview. The user typed "I want read
// more", answered six questions, and was then asked which days suited them three
// more times in three different wordings, plus which activities they enjoyed — on a
// reading goal. They answered the day question differently each time, so the plan
// was built on a contradiction. Every case below is a piece of that run.

function question(partial: Partial<CopilotQuestion> & { prompt: string }): CopilotQuestion {
  return {
    id: partial.id ?? 'q1',
    type: partial.type ?? 'SINGLE_SELECT',
    prompt: partial.prompt,
    options: partial.options ?? ['A', 'B'],
    allowCustomAnswer: partial.allowCustomAnswer ?? true,
    optional: partial.optional ?? true,
  } as CopilotQuestion;
}

describe('what a question is about', () => {
  it('files the three wordings of the day question as one subject', () => {
    // Verbatim from the run that prompted all of this.
    const wordings = [
      'Which day(s) of the evening work best for you?',
      'Which days of the week best suit your reading schedule?',
      'Which days of the week do you actually want to read?',
    ];
    for (const prompt of wordings) {
      expect(questionTopic(prompt)).toBe('DAYS');
    }
  });

  it('keeps "how many days a week" separate from "which days"', () => {
    // Both mention days and they are not the same question: one sets the count, the
    // other sets the calendar. Filing them together would silently drop one.
    expect(questionTopic('How many days a week can you read?')).toBe('FREQUENCY');
    expect(questionTopic('Which days of the week suit you?')).toBe('DAYS');
  });

  it('reads "what time of day" as the clock, not the calendar', () => {
    expect(questionTopic('What time of day do you usually read?')).toBe('TIME_OF_DAY');
  });

  it('trusts a day picker over its wording', () => {
    expect(questionTopic('When are you free?', 'DAYS_OF_WEEK')).toBe('DAYS');
  });

  it('admits when it does not recognise the subject', () => {
    expect(questionTopic('Would you like a name for this plan?')).toBe('OTHER');
  });

  it('reads the options when the wording gives nothing away', () => {
    // Verbatim from a live run. The wording matches no pattern; the choices could not
    // be clearer, and without them this arrived as a radio group.
    expect(questionTopic('Pick your ideal reading time', 'SINGLE_SELECT', [
      'Morning',
      'Afternoon',
      'Evening',
    ])).toBe('TIME_OF_DAY');
  });

  it('does not let an option reclassify a question that was already clear', () => {
    // "3 days" in the options must not turn a frequency question into a day question.
    expect(
      questionTopic('How many days a week can you read?', 'SINGLE_SELECT', [
        '2 days',
        '3 days',
        '4 days',
      ]),
    ).toBe('FREQUENCY');
  });
});

describe('how many answers a question may take', () => {
  it('turns the time-of-day radio group into checkboxes', () => {
    // The screenshot that started this: Morning / Afternoon / Evening / Whenever,
    // pick exactly one, from someone who reads morning and night.
    const promoted = promoteMultiSelect(
      question({ prompt: 'What time of day do you usually read?', type: 'SINGLE_SELECT' }),
    );
    expect(promoted.type).toBe('MULTI_SELECT');
  });

  it('leaves a genuinely exclusive question alone', () => {
    const asked = question({ prompt: 'How long is one session?', type: 'SINGLE_SELECT' });
    expect(promoteMultiSelect(asked).type).toBe('SINGLE_SELECT');
  });

  it('promotes on the options alone when the wording is opaque', () => {
    const promoted = promoteMultiSelect(
      question({
        prompt: 'Pick your ideal reading time',
        type: 'SINGLE_SELECT',
        options: ['Morning', 'Afternoon', 'Evening'],
      }),
    );
    expect(promoted.type).toBe('MULTI_SELECT');
  });

  it('never narrows a question the model already opened up', () => {
    const asked = question({ prompt: 'How long is one session?', type: 'MULTI_SELECT' });
    expect(promoteMultiSelect(asked).type).toBe('MULTI_SELECT');
  });

  it('does not touch free text, dates or numbers', () => {
    for (const type of ['FREE_TEXT', 'NUMBER', 'DATE', 'TIME', 'DAYS_OF_WEEK'] as const) {
      expect(promoteMultiSelect(question({ prompt: 'Which days?', type })).type).toBe(type);
    }
  });
});

describe('how much interview a request has earned', () => {
  it('gives a vague goal room to ask', () => {
    const budget = questionBudget('I want read more');
    expect(budget.stated).toEqual([]);
    expect(budget.min).toBe(2);
    expect(budget.max).toBe(5);
  });

  it('stops interviewing someone who already said what they want', () => {
    // Frequency, days, duration and time of day are all in this one sentence.
    const budget = questionBudget('Read 30 minutes every evening on weekdays');
    expect(budget.stated).toContain('DURATION');
    expect(budget.stated).toContain('TIME_OF_DAY');
    expect(budget.max).toBeLessThanOrEqual(2);
    // Nothing left worth asking, so no floor either. A question here reads as not
    // having read what they wrote.
    expect(budget.min).toBe(0);
  });

  it('asks a little of someone who gave one detail', () => {
    const budget = questionBudget('I want to go to the gym 3 times a week');
    expect(budget.stated).toEqual(['FREQUENCY']);
    expect(budget.min).toBe(2);
    expect(budget.max).toBe(4);
  });

  it('never asks for more questions than it allows', () => {
    for (const goal of [
      'I want read more',
      'Run 5km on Tuesdays and Thursdays at 7am',
      'save money',
      'read 20 pages of non-fiction each morning for 30 minutes',
    ]) {
      const budget = questionBudget(goal);
      expect(budget.min).toBeLessThanOrEqual(budget.max);
    }
  });
});

describe('which questions never reach the user', () => {
  const base = { askedIds: [] as string[], askedTopics: [] as never[], stated: [] as never[] };

  it('drops a repeated subject even under a brand new id', () => {
    // The exact failure: three fresh ids, one subject. The id check alone passed all
    // three, which is how the user came to answer it three times.
    const reason = redundancyReason(
      question({ id: 'reading_days_final', prompt: 'Which days do you actually want to read?' }),
      { ...base, askedIds: ['reading_days'], askedTopics: ['DAYS'] },
    );
    expect(reason).toBe('REPEATED_TOPIC');
  });

  it('still catches a reused id', () => {
    const reason = redundancyReason(question({ id: 'reading_days', prompt: 'Anything else?' }), {
      ...base,
      askedIds: ['reading_days'],
    });
    expect(reason).toBe('REPEATED_ID');
  });

  it('does not ask back something the opening message already said', () => {
    const budget = questionBudget('Read 30 minutes every evening on weekdays');
    const reason = redundancyReason(
      question({ prompt: 'How long do you want each session to be?' }),
      { ...base, stated: budget.stated as never },
    );
    expect(reason).toBe('ALREADY_STATED');
  });

  it('lets a genuinely new question through', () => {
    const reason = redundancyReason(question({ prompt: 'What kind of books do you enjoy?' }), {
      ...base,
      askedTopics: ['DAYS', 'FREQUENCY'],
    });
    expect(reason).toBeNull();
  });

  it('does not let one unclassifiable question block every other one', () => {
    // Two OTHERs in a row is the classifier being unsure twice, not the model
    // repeating itself. Deduplicating on OTHER would cap the interview at one.
    const reason = redundancyReason(question({ prompt: 'Anything I should know?' }), {
      ...base,
      askedTopics: ['OTHER'],
    });
    expect(reason).toBeNull();
  });
});
