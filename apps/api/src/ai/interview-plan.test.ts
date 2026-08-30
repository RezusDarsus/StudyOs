import { describe, expect, it } from 'vitest';
import {
  promoteMultiSelect,
  ensureCustomAnswer,
  goalDomain,
  questionBudget,
  questionDomainMismatch,
  essentialFallbackQuestion,
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
    expect(budget.min).toBe(1);
    expect(budget.max).toBe(2);
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
    expect(budget.min).toBe(1);
    expect(budget.max).toBe(2);
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

  it('requires clarification for an impossible day count', () => {
    const budget = questionBudget(
      'I need exactly three different days per week, but I can exercise only on Monday and Wednesday.',
    );
    expect(budget.requiresClarification).toBe(true);
    expect(budget.min).toBeGreaterThan(0);
  });

  it('recognizes every-week wording and days named before "only days"', () => {
    const budget = questionBudget(
      'I need three different days every week. Monday and Wednesday are the only days possible.',
    );
    expect(budget.requiresClarification).toBe(true);
  });

  it('recognizes a qualified expert goal as undefined', () => {
    const budget = questionBudget('Help me become a world-class expert in distributed systems.');
    expect(budget.requiresClarification).toBe(true);
  });

  it('requires a measurable definition instead of accepting fake precision', () => {
    const budget = questionBudget('Make me 95% more productive in 30 days.');
    expect(budget.requiresClarification).toBe(true);
    expect(budget.min).toBeGreaterThan(0);
  });
});

describe('deterministic minimum interview',()=>{
  it('asks a domain-flavoured success question for a vague fitness goal',()=>{
    const first=essentialFallbackQuestion('I want to get fitter',[]);
    expect(first.id).toBe('essential_success');
    expect(first.type).toBe('SINGLE_SELECT');
    expect(first.optional).toBe(false);
    expect(first.allowCustomAnswer).toBe(true);
    expect(first.options).toEqual(['Lose weight','Build strength','Improve endurance','Be more active generally']);
    const second=essentialFallbackQuestion('I want to get fitter',['TARGET']);
    expect(second.id).toBe('essential_frequency');
    expect(questionTopic(second.prompt,second.type,second.options)).toBe('FREQUENCY');
    expect(questionBudget('I want to get fitter')).toMatchObject({ min: 1, max: 2 });
    expect(questionBudget('Run 30 minutes three days per week')).toMatchObject({ min: 0, max: 1 });
  });

  it('keeps the open free-text success question when no domain fits',()=>{
    const general=essentialFallbackQuestion('I want to turn my life around',[]);
    expect(general.id).toBe('essential_success');
    expect(general.type).toBe('FREE_TEXT');
    expect(general.prompt).toBe('What specific target or result would make this goal feel successful to you?');
  });
});

describe('goalDomain', () => {
  it('routes goals by their subject', () => {
    expect(goalDomain('I want to run a 10K race')).toBe('FITNESS');
    expect(goalDomain('I want to learn Java')).toBe('LEARNING');
    expect(goalDomain('I want to learn English speaking')).toBe('LANGUAGE');
    expect(goalDomain('I want to save $5,000 in 10 months')).toBe('MONEY');
    expect(goalDomain('Prepare for a job interview')).toBe('CAREER');
    expect(goalDomain('Practice guitar every evening')).toBe('CREATIVE');
    expect(goalDomain('I want to reduce my social media use')).toBe('GENERAL');
  });

  it('puts language above learning, so "learn English" is a language goal', () => {
    expect(goalDomain('learn Japanese grammar')).toBe('LANGUAGE');
  });

  it('puts career above learning, so interview prep is about the career', () => {
    expect(goalDomain('Study for my Java interview')).toBe('CAREER');
  });

  it('matches on word boundaries only', () => {
    // "retraining" contains "training" but is not a training goal.
    expect(goalDomain('retraining my cat to use the litter tray')).toBe('GENERAL');
  });
});

describe('domain-flavoured fallback questions', () => {
  it('offers exclusive outcome choices for a language goal', () => {
    const question = essentialFallbackQuestion('I want to become fluent in Spanish', []);
    expect(question.id).toBe('essential_success');
    expect(question.type).toBe('SINGLE_SELECT');
    expect(question.optional).toBe(false);
    expect(question.allowCustomAnswer).toBe(true);
    expect(question.options).toEqual(['Speaking', 'Listening', 'Grammar', 'Vocabulary']);
  });

  it('asks a money goal for its amount and date in plain text', () => {
    const question = essentialFallbackQuestion('I want to save for a trip', []);
    expect(question.id).toBe('essential_success');
    expect(question.type).toBe('FREE_TEXT');
    expect(question.prompt).toBe('How much do you want to save, and by when?');
  });

  it('gives learning, career and creative goals their own concrete choices', () => {
    expect(essentialFallbackQuestion('I want to learn Python', []).options).toEqual([
      'University coursework', 'Job readiness', 'General skills', 'A specific project',
    ]);
    expect(essentialFallbackQuestion('I want to land a job', []).options).toEqual([
      'Pass interviews', 'Land an offer', 'Get noticed at work', 'Build a portfolio',
    ]);
    expect(essentialFallbackQuestion('I want to learn piano', []).options).toEqual([
      'Finish a piece', 'Build a daily practice', 'Share publicly', 'Learn technique',
    ]);
  });

  it('leaves every other branch of the fallback unchanged', () => {
    const frequency = essentialFallbackQuestion('I want to get fitter', ['TARGET']);
    expect(frequency.id).toBe('essential_frequency');
    expect(frequency.type).toBe('NUMBER');
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
    expect(questionBudget('Water plants every Saturday morning.').stated).toContain('FREQUENCY');
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
