import { describe, expect, it } from 'vitest';
import {
  promoteMultiSelect,
  ensureCustomAnswer,
  goalDomain,
  questionDomainMismatch,
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
  it('classifies outcome wording and fitness outcome options as the target topic', () => {
    expect(questionTopic('What result matters most right now?')).toBe('TARGET');
    expect(
      questionTopic('Choose one', 'SINGLE_SELECT', [
        'Lose weight',
        'Build strength',
        'Improve endurance',
        'Be more active generally',
      ]),
    ).toBe('TARGET');
  });

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


describe('the custom-answer guarantee', () => {
  it('forces allowCustomAnswer on every single-select question', () => {
    const asked = question({
      prompt: 'How confident are you?',
      type: 'SINGLE_SELECT',
      allowCustomAnswer: false,
    });
    expect(ensureCustomAnswer(asked).allowCustomAnswer).toBe(true);
  });

  it('leaves every other type alone', () => {
    const free = question({
      prompt: 'What does success look like?',
      type: 'FREE_TEXT',
      allowCustomAnswer: false,
    });
    expect(ensureCustomAnswer(free).allowCustomAnswer).toBe(false);
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

  it('rejects weekday scheduling for a monthly savings transfer', () => {
    expect(questionDomainMismatch(
      question({ prompt:'Which days of the week should you make the transfer?' }),
      'Set aside 700 GEL monthly for a laptop.',
    )).toBe(true);
  });

  it('rejects malformed mixed calendar units', () => {
    expect(questionDomainMismatch(
      question({ prompt:'How many months per week will you save?' }),
      'Save for a laptop.',
    )).toBe(true);
  });

  it('rejects weekly frequency questions for monthly finance', () => {
    expect(questionDomainMismatch(
      question({ prompt:'How many days per week should you make the contribution?' }),
      'Contribute 700 GEL monthly.',
    )).toBe(true);
  });

  it('rejects per-month questions when every named weekday is already explicit',()=>{
    expect(questionDomainMismatch(
      question({prompt:'How many Sundays per month would you like to call?'}),
      'Call my parents every Sunday afternoon.',
    )).toBe(true);
  });

  it('rejects resume scheduling questions when the user reserves that decision',()=>{
    expect(questionDomainMismatch(
      question({prompt:'Which day should the first session back be?'}),
      'Recommend PAUSE and let me decide when to resume.',
    )).toBe(true);
    expect(questionDomainMismatch(
      question({prompt:'How many minutes per session after the pause?'}),
      'Recommend PAUSE and let me decide when to resume.',
    )).toBe(true);
  });
  it('rejects finance schedule questions already answered by named cap periods',()=>{
    const goal='Contribute €650 per month from September through November and €300 in December and January.';
    expect(questionDomainMismatch(question({prompt:'What is the first contribution date?'}),goal)).toBe(true);
    expect(questionDomainMismatch(question({prompt:'Which months have the €300 cap?'}),goal)).toBe(true);
  });
});
