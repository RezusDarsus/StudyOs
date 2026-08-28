import { describe, expect, it } from 'vitest';
import { safeParseJson } from './client.js';
import { stripThinking } from './nvidia-provider.js';
import {
  copilotQuestionSchema,
  goalDraftSchema,
  interviewResponseSchema,
  draftPatchSchema,
  preferenceExtractionSchema,
} from './schemas.js';
import {
  DraftValidationError,
  rewardForTask,
  validateAndNormalizeDraft,
} from './draft-validator.js';
import { answeredPairs } from '../services/copilot-session.js';
import {
  applyModelExtraction,
  createContext,
  literalAnswers,
  parseContext,
  putEntry,
  recordAnswer,
  toPlainObject,
} from './context.js';
import { classifyGoalText, memoryGateCategory } from './category.js';
import { canonicalPreferenceKey } from '../services/preferences.js';

// These run entirely offline. Nothing here calls a provider, so the suite is
// deterministic and costs nothing.

const baseDraft = {
  title: 'Become More Active',
  description: 'Walking based routine.',
  category: 'HEALTH' as const,
  targetType: 'HABIT' as const,
  rationale: 'You said you enjoy walking and prefer evenings.',
  tasks: [
    {
      title: 'Evening walk',
      description: '',
      recurrence: { type: 'TIMES_PER_WEEK' as const, timesPerWeek: 5 },
      estimatedMinutes: 35,
      preferredTime: '20:00',
      reason: 'You enjoy walking.',
    },
  ],
};

describe('tolerant JSON extraction', () => {
  it('parses a clean object', () => {
    expect(safeParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('unwraps a markdown fence', () => {
    const result = safeParseJson('```json\n{"a":1}\n```');
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('recovers an object buried in prose', () => {
    const result = safeParseJson('Sure! Here you go:\n{"a":1}\nHope that helps.');
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('reports failure rather than guessing', () => {
    expect(safeParseJson('not json at all')).toEqual({ ok: false });
  });
});

describe('reasoning leakage', () => {
  it('strips a think block that leaked into the content', () => {
    expect(stripThinking('<think>hmm let me see</think>{"a":1}')).toBe('{"a":1}');
    expect(stripThinking('plain output')).toBe('plain output');
  });
});

describe('question schema', () => {
  it('accepts a select question with options', () => {
    const parsed = copilotQuestionSchema.parse({
      id: 'preferred_activity',
      type: 'MULTI_SELECT',
      prompt: 'Which activities do you enjoy?',
      options: ['Walking', 'Swimming'],
    });
    expect(parsed.options).toEqual(['Walking', 'Swimming']);
    expect(parsed.optional).toBe(true);
  });

  it('tolerates null/empty options on a question that has none', () => {
    // Models send null instead of omitting the field; a NUMBER question has no list.
    const parsed = copilotQuestionSchema.parse({
      id: 'days_per_week',
      type: 'NUMBER',
      prompt: 'How many days per week?',
      options: null,
    });
    expect(parsed.options).toBeUndefined();
    expect(copilotQuestionSchema.parse({ ...parsed, options: [] }).options).toBeUndefined();
  });

  it('coerces numeric options rather than failing the turn', () => {
    // "How many days per week?" legitimately comes back as [3, 4, 5, 6].
    const parsed = copilotQuestionSchema.parse({
      id: 'days_per_week',
      type: 'SINGLE_SELECT',
      prompt: 'How many days per week?',
      options: [3, 4, 5, 6],
    });
    expect(parsed.options).toEqual(['3', '4', '5', '6']);
  });

  it('rejects a made-up question type', () => {
    expect(() =>
      copilotQuestionSchema.parse({ id: 'x', type: 'RENDER_IFRAME', prompt: 'hi' }),
    ).toThrow();
  });

  it('rejects a snake_case violation and an oversized option list', () => {
    expect(() =>
      copilotQuestionSchema.parse({ id: 'Bad Id', type: 'FREE_TEXT', prompt: 'hi' }),
    ).toThrow();
    expect(() =>
      copilotQuestionSchema.parse({
        id: 'x',
        type: 'SINGLE_SELECT',
        prompt: 'hi',
        options: Array.from({ length: 12 }, (_, i) => `opt${i}`),
      }),
    ).toThrow();
  });

  it('requires a select question to actually offer choices', () => {
    const result = interviewResponseSchema.safeParse({
      state: 'NEEDS_MORE_INFORMATION',
      assistantMessage: 'Pick one',
      question: { id: 'x', type: 'SINGLE_SELECT', prompt: 'Pick one', options: ['only'] },
    });
    expect(result.success).toBe(false);
  });

  it('requires a question when more information is needed', () => {
    const result = interviewResponseSchema.safeParse({
      state: 'NEEDS_MORE_INFORMATION',
      assistantMessage: 'Thinking...',
      question: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('context provenance', () => {
  const memory = [
    { key: 'preferred_activity', value: 'walking' },
    { key: 'disliked_activity', value: 'running' },
  ];

  it('ranks a literal answer above anything the model infers', () => {
    const ctx = createContext('get fitter');
    recordAnswer(ctx, { key: 'liked_activities', questionId: 'q1', value: 'dancing' });
    applyModelExtraction(ctx, { liked_activities: 'walking' }, memory);
    expect(toPlainObject(ctx).liked_activities).toBe('dancing');
  });

  it('lets an explicit correction supersede an earlier answer', () => {
    const ctx = createContext('get fitter');
    recordAnswer(ctx, { key: 'liked_activities', questionId: 'q1', value: 'gym' });
    // "Actually, I meant swimming" arrives through the corrections channel.
    applyModelExtraction(ctx, {}, memory, { liked_activities: 'swimming' });
    expect(toPlainObject(ctx).liked_activities).toBe('swimming');
  });

  it('does not let a plain extraction masquerade as a correction', () => {
    const ctx = createContext('get fitter');
    recordAnswer(ctx, { key: 'liked_activities', questionId: 'q1', value: 'gym' });
    applyModelExtraction(ctx, { liked_activities: 'swimming' }, memory);
    expect(toPlainObject(ctx).liked_activities).toBe('gym');
  });

  it('accepts a genuinely new fact', () => {
    const ctx = createContext('get fitter');
    applyModelExtraction(ctx, { minutes_per_session: 30 }, memory);
    expect(toPlainObject(ctx).minutes_per_session).toBe(30);
  });

  it('goal intent cannot be rewritten by anything', () => {
    const ctx = createContext('build a house');
    applyModelExtraction(ctx, { goalIntent: 'get fit' }, memory, { goalIntent: 'get fit' });
    expect(ctx.goalIntent).toBe('build a house');
    expect(putEntry(ctx, 'goalIntent', { value: 'x', source: 'CURRENT_USER_ANSWER' })).toBe(false);
  });

  it('records where every value came from', () => {
    const ctx = createContext('get fitter');
    recordAnswer(ctx, { key: 'liked_activities', questionId: 'q1', value: 'dancing' });
    applyModelExtraction(ctx, { plan_style: 'flexible' }, memory);
    expect(ctx.entries.liked_activities.source).toBe('CURRENT_USER_ANSWER');
    expect(ctx.entries.plan_style.source).toBe('CURRENT_SESSION_INFERENCE');
    expect(literalAnswers(ctx).map((a) => a.key)).toEqual(['liked_activities']);
  });

  it('migrates a pre-provenance blob at the weakest plausible authority', () => {
    const ctx = parseContext(JSON.stringify({ days_per_week: 5 }), 'read more');
    expect(ctx.entries.days_per_week.source).toBe('CURRENT_SESSION_INFERENCE');
    expect(ctx.goalIntent).toBe('read more');
  });
});

describe('preference contamination guard', () => {
  // Regression: memories from PREVIOUS goals were echoed back as extracted
  // context and became "facts the user stated" — producing a walking plan for
  // someone who answered "dancing".
  const memory = [
    { key: 'preferred_activity', value: 'walking' },
    { key: 'disliked_activity', value: 'running' },
  ];

  it('drops a memory the model merely parroted back', () => {
    const ctx = createContext('build a house');
    applyModelExtraction(ctx, { preferred_activity: 'walking' }, memory);
    expect(toPlainObject(ctx)).toEqual({});
  });

  it('drops a mutated memory key the user never spoke to', () => {
    const ctx = createContext('build a house');
    applyModelExtraction(ctx, { preferred_activity: 'swimming' }, memory);
    expect(toPlainObject(ctx).preferred_activity).toBeUndefined();
  });

  it('allows that same key once the user has actually answered it', () => {
    const ctx = createContext('get fitter');
    recordAnswer(ctx, { key: 'preferred_activity', questionId: 'q1', value: 'dancing' });
    applyModelExtraction(ctx, {}, memory, { preferred_activity: 'salsa' });
    expect(toPlainObject(ctx).preferred_activity).toBe('salsa');
  });

  it('never stores a memory hint at user authority', () => {
    const ctx = createContext('save money');
    applyModelExtraction(ctx, { preferred_activity: 'walking' }, memory);
    const userAuthored = Object.values(ctx.entries).filter(
      (e) => e.source === 'CURRENT_USER_ANSWER' || e.source === 'CURRENT_USER_MESSAGE',
    );
    expect(userAuthored).toHaveLength(0);
  });
});

describe('preference key canonicalisation', () => {
  // One account accumulated 47 preferences with five different keys for session
  // length, and a FITNESS block holding both "evenings" and "morning".
  it('collapses the many names the model invents for session length', () => {
    for (const key of [
      'session_duration',
      'session_duration_minutes',
      'session_length',
      'ideal_session_length',
      'preferred_session_length',
    ]) {
      expect(canonicalPreferenceKey(key)).toBe('session_length_minutes');
    }
  });

  it('collapses frequency and day-list variants', () => {
    for (const key of [
      'frequency',
      'preferred_frequency',
      'session_frequency',
      'preferred_sessions_per_week',
      'preferred_days_of_week',
    ]) {
      expect(canonicalPreferenceKey(key)).toBe('sessions_per_week');
    }
  });

  it('collapses time-of-day variants so they cannot contradict each other', () => {
    for (const key of ['preferred_time', 'preferred_time_of_day', 'energy_time', 'focus_time']) {
      expect(canonicalPreferenceKey(key)).toBe('preferred_time_of_day');
    }
  });

  it('merges numbered activity duplicates', () => {
    expect(canonicalPreferenceKey('preferred_activity_2')).toBe('preferred_activity');
    expect(canonicalPreferenceKey('disliked_activity')).toBe('disliked_activity');
  });

  it('leaves an unrecognised key alone', () => {
    expect(canonicalPreferenceKey('preferred_book_type')).toBe('preferred_book_type');
  });
});

describe('memory gating', () => {
  it('classifies from the user text, not the model', () => {
    expect(classifyGoalText('I want to save $3,000 for a trip').category).toBe('FINANCE');
    expect(classifyGoalText('I want to get fitter and go to the gym').category).toBe('FITNESS');
  });

  it('withholds category memory when the model disagrees with the text', () => {
    // The exact shape of the bug: model said FITNESS for a construction project.
    expect(memoryGateCategory('I need to build a house', 'FITNESS').category).toBeNull();
  });

  it('withholds category memory when the goal is not clearly categorised', () => {
    expect(memoryGateCategory('I need to build a house', null).category).toBeNull();
  });

  it('allows category memory when the text independently agrees', () => {
    expect(memoryGateCategory('I want to get fitter, gym and cardio', 'FITNESS').category).toBe(
      'FITNESS',
    );
  });
});

describe('answered pairs', () => {
  it('pairs each question with the answer it received', () => {
    const pairs = answeredPairs([
      {
        role: 'assistant',
        content: 'Which activities?',
        structuredPayload: JSON.stringify({ id: 'liked_activities', prompt: 'Which activities?' }),
      },
      {
        role: 'user',
        content: 'Walking',
        structuredPayload: JSON.stringify({ questionId: 'liked_activities', answer: ['Walking'] }),
      },
    ]);
    expect(pairs).toEqual([
      { questionId: 'liked_activities', prompt: 'Which activities?', answer: 'Walking' },
    ]);
  });
});

describe('recurrence mapping', () => {
  it('normalises a near-miss frequency', () => {
    // 8x/week reads as someone counting a twice-daily session: the intent is clear.
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [{ ...baseDraft.tasks[0], recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 8 } }],
      },
      'UTC',
    );
    expect(result.tasks[0].recurrenceConfig.timesPerWeek).toBe(7);
    expect(result.adjustments.join(' ')).toMatch(/capped/i);
  });

  it('rejects a semantically impossible frequency rather than clamping it', () => {
    // 300x/week is not a rounding error. Silently turning it into 7 would hand
    // the user a plan nobody asked for.
    expect(() =>
      validateAndNormalizeDraft(
        {
          ...baseDraft,
          tasks: [
            { ...baseDraft.tasks[0], recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 300 } },
          ],
        },
        'UTC',
      ),
    ).toThrow(DraftValidationError);
  });

  it('falls back when a weekday task names no weekdays', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [{ ...baseDraft.tasks[0], recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [] } }],
      },
      'UTC',
    );
    expect(result.tasks[0].recurrenceType).toBe('EVERY_DAY');
  });

  it('deduplicates and sorts weekdays', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [
          { ...baseDraft.tasks[0], recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [5, 1, 1, 3] } },
        ],
      },
      'UTC',
    );
    expect(result.tasks[0].recurrenceConfig.weekdays).toEqual([1, 3, 5]);
  });

  it('refuses a recurrence type the app does not support', () => {
    const result = goalDraftSchema.safeParse({
      ...baseDraft,
      tasks: [{ ...baseDraft.tasks[0], recurrence: { type: 'SOMETIMES_WHEN_MOTIVATED' } }],
    });
    expect(result.success).toBe(false);
  });
});

describe('draft validation', () => {
  it('drops a deadline that is not in the future', () => {
    const result = validateAndNormalizeDraft(
      { ...baseDraft, deadline: '2020-01-01' },
      'UTC',
      new Date('2026-08-20T10:00:00Z'),
    );
    expect(result.deadline).toBeNull();
    expect(result.adjustments.join(' ')).toMatch(/not in the future/i);
  });

  it('downgrades a deadline goal with no usable date to a habit', () => {
    const result = validateAndNormalizeDraft(
      { ...baseDraft, targetType: 'DEADLINE', deadline: null },
      'UTC',
    );
    expect(result.targetType).toBe('HABIT');
  });

  it('removes duplicate tasks', () => {
    const result = validateAndNormalizeDraft(
      { ...baseDraft, tasks: [baseDraft.tasks[0], { ...baseDraft.tasks[0] }] },
      'UTC',
    );
    expect(result.tasks).toHaveLength(1);
  });

  it('aligns a named Saturday task with weekday 6', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [{
          ...baseDraft.tasks[0],
          title: 'Saturday study',
          recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [5] },
        }],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Study every Saturday.',
    );
    expect(result.tasks[0].recurrenceConfig.weekdays).toEqual([6]);
  });

  it('makes a one-off task recur when its named weekday is mandatory', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [{
          ...baseDraft.tasks[0],
          title: 'Long run on Sunday',
          recurrence: { type: 'ONCE' },
        }],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Sunday must be the long run, with at most three training days per week.',
    );
    expect(result.tasks[0].recurrenceType).toBe('SPECIFIC_WEEKDAYS');
    expect(result.tasks[0].recurrenceConfig.weekdays).toEqual([0]);
  });

  it('preserves a mandatory Saturday while filling an exact three-day schedule', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [
          { ...baseDraft.tasks[0], title: 'Trail practice (Saturday)', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [1, 2, 4] } },
          { ...baseDraft.tasks[0], title: 'Strength session', recurrence: { type: 'ONCE' } },
          { ...baseDraft.tasks[0], title: 'Trail run (Monday or Tuesday)', recurrence: { type: 'ONCE' } },
        ],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'I may train Monday, Tuesday, Thursday, or Saturday, but need exactly three total sessions weekly, including Saturday trail practice.',
    );
    expect(result.tasks.map((task) => task.recurrenceConfig.weekdays)).toEqual([[6], [1], [2]]);
  });

  it('reconciles aggregate frequency without dropping weekly strength or Saturday trail roles', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [
          { ...baseDraft.tasks[0], title: 'Trail practice', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [1, 2, 4] } },
          { ...baseDraft.tasks[0], title: 'Ankle strength', recurrence: { type: 'ONCE' } },
          { ...baseDraft.tasks[0], title: 'Recovery walk', recurrence: { type: 'ONCE' } },
        ],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Train Monday, Tuesday, Thursday, or Saturday with exactly three total sessions weekly, including Saturday trail practice and one strength session.',
    );
    const trail=result.tasks.find((task)=>task.title==='Trail practice')!;
    const strength=result.tasks.find((task)=>task.title==='Ankle strength')!;
    const weekly=result.tasks.reduce((sum,task)=>sum+(task.recurrenceType==='SPECIFIC_WEEKDAYS'?(task.recurrenceConfig.weekdays?.length??0):task.recurrenceType==='TIMES_PER_WEEK'?(task.recurrenceConfig.timesPerWeek??0):0),0);
    expect(weekly).toBe(3);
    expect(trail.recurrenceConfig.weekdays).toContain(6);
    expect(strength.recurrenceType).toBe('SPECIFIC_WEEKDAYS');
  });

  it('normalizes aggregate frequency across separately scheduled tasks', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [
          { ...baseDraft.tasks[0], title: 'Practice', recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 } },
          { ...baseDraft.tasks[0], title: 'Review', recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 } },
        ],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Practice exactly three times per week.',
    );
    expect(result.tasks.map((task) => task.recurrenceType)).toEqual(['TIMES_PER_WEEK', 'ONCE']);
    expect(result.tasks[0].recurrenceConfig.timesPerWeek).toBe(3);
  });

  it('preserves monthly savings instead of converting a weekday answer into weekly recurrence', () => {
    const result=validateAndNormalizeDraft(
      {
        ...baseDraft,
        category:'FINANCE',
        title:'Laptop fund',
        deadline:'2027-01-15',
        rationale:'Use 2.75 GEL per USD as a planning assumption.',
        tasks:[{...baseDraft.tasks[0],title:'Set aside 700 GEL savings',description:'Transfer 700 GEL to the laptop fund.',recurrence:{type:'SPECIFIC_WEEKDAYS',weekdays:[6]}}],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'I need $1,800 by January 15, 2027 and can set aside 700 GEL monthly.\n{"days_per_week":{"question":"Which day?","answer":["Sat"]}}',
    );
    expect(result.tasks[0].recurrenceType).toBe('MONTHLY');
    expect(result.rationale).toMatch(/4,?950 GEL/i);
    expect(result.rationale).toMatch(/8 monthly contributions/i);
    expect(result.rationale).toMatch(/shortfall/i);
  });

  it('keeps explicitly weekly savings weekly', () => {
    const result=validateAndNormalizeDraft(
      {...baseDraft,category:'FINANCE',tasks:[{...baseDraft.tasks[0],title:'Weekly savings transfer',recurrence:{type:'TIMES_PER_WEEK',timesPerWeek:1}}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),'Transfer €50 once per week.',
    );
    expect(result.tasks[0].recurrenceType).toBe('TIMES_PER_WEEK');
  });

  it('keeps period-specific finance caps distinct and reports the combined shortfall',()=>{
    const result=validateAndNormalizeDraft(
      {...baseDraft,category:'FINANCE',deadline:'2027-08-31',tasks:[
        {...baseDraft.tasks[0],title:'February onward payment',description:'Transfer €650 from February onward.',reason:'Use €650 from February.',recurrence:{type:'MONTHLY'}},
      ]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'By August 31, 2027 eliminate a €3,600 balance and build a €5,000 fund. We have €900 available now and can contribute €650 per month from September through November, €300 in December and January, and €700 per month from February onward. Calculate whether the combined €8,600 objective fits.',
    );
    expect(result.tasks.map((task)=>({description:task.description,config:task.recurrenceConfig}))).toEqual([
      {description:'Contribute €650 per month from 2026-09-01 through 2026-11-30.',config:{dayOfMonth:1,activeFrom:'2026-09-01',activeUntil:'2026-11-30'}},
      {description:'Contribute €300 per month from 2026-12-01 through 2027-01-31.',config:{dayOfMonth:1,activeFrom:'2026-12-01',activeUntil:'2027-01-31'}},
      {description:'Contribute €700 per month from 2027-02-01 through 2027-08-31.',config:{dayOfMonth:1,activeFrom:'2027-02-01',activeUntil:'2027-08-31'}},
    ]);
    expect(result.rationale).toMatch(/7450 EUR/);
    expect(result.rationale).toMatch(/250 EUR shortfall/);
  });

  it('encodes skipped finance months in the executable recurrence',()=>{
    const result=validateAndNormalizeDraft(
      {...baseDraft,category:'FINANCE',deadline:'2027-09-30',tasks:[{...baseDraft.tasks[0],title:'Tuition transfer €350',recurrence:{type:'MONTHLY'}}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'I need €4,800 by September 30, 2027. I can save €350 per month, except nothing in December 2026 and January 2027.',
    );
    expect(result.tasks[0].recurrenceConfig.excludedMonths).toEqual(['2026-12','2027-01']);
    expect(result.tasks[0].description).toMatch(/350 EUR once per month/i);
    expect(result.tasks[0].description).not.toMatch(/1st and 15th/i);
  });

  it('adds flexible weekday bounds to TIMES_PER_WEEK tasks', () => {
    const result=validateAndNormalizeDraft(
      {...baseDraft,tasks:[{...baseDraft.tasks[0],title:'Strength workout',recurrence:{type:'TIMES_PER_WEEK',timesPerWeek:1}}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'Train at most three days per week. Monday, Tuesday, Thursday, and Saturday are available. Wednesday is unavailable. One weekly session must be strength.',
    );
    expect(result.tasks[0].recurrenceConfig.allowedWeekdays).toEqual([1,2,4,6]);
    expect(result.tasks[0].recurrenceConfig.excludedWeekdays).toEqual([3]);
  });

  it('represents conditional recovery policy without applying progression', () => {
    const result=validateAndNormalizeDraft(
      {...baseDraft,tasks:[{...baseDraft.tasks[0],title:'Ankle strength',progression:{metricType:'MINUTES',unitLabel:'min',stages:[{target:20,minDays:7},{target:30,minDays:7}]}}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'Progress only after two pain-free weeks, reduce after repeated pain, pause for sharp pain, and wait for my approval.',
    );
    expect(result.tasks[0].progression).toBeNull();
    expect(result.rationale).toMatch(/PROGRESS only after 2 pain-free weeks/i);
    expect(result.rationale).toMatch(/REDUCE after repeated pain/i);
    expect(result.rationale).toMatch(/PAUSE for sharp pain/i);
  });

  it('does not apply a progression while approval is reserved', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [{
          ...baseDraft.tasks[0],
          estimatedMinutes: 15,
          progression: {
            metricType: 'MINUTES',
            unitLabel: 'min',
            stages: [
              { target: 15, minDays: 7 },
              { target: 25, minDays: 7 },
            ],
          },
        }],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Recommend changes, but do not apply them until I explicitly approve.',
    );
    expect(result.tasks[0].progression).toBeNull();
  });

  it('does not schedule or progress a deferred user-controlled resume',()=>{
    const result=validateAndNormalizeDraft(
      {...baseDraft,tasks:[{...baseDraft.tasks[0],title:'Resume training Monday',description:'Resume Monday after two weeks.',recurrence:{type:'SPECIFIC_WEEKDAYS',weekdays:[1]},progression:{metricType:'MINUTES',unitLabel:'min',stages:[{target:30,minDays:14},{target:40,minDays:14}]}}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'Recommend PAUSE, preserve the current stage, and let me decide when to resume after two weeks.',
    );
    expect(result.tasks[0]).toMatchObject({title:'Review whether to resume',recurrenceType:'ONCE',progression:null});
    expect(result.tasks[0].description).toMatch(/no training session is scheduled automatically/i);
    expect(result.rationale).toMatch(/no automatic resume/i);
  });

  it('keeps an accepted one-session delta distinct from contradictory interview answers',()=>{
    const result=validateAndNormalizeDraft(
      {...baseDraft,description:'Four sessions every week.',tasks:[{...baseDraft.tasks[0],title:'Practice',recurrence:{type:'SPECIFIC_WEEKDAYS',weekdays:[1,3,5,0]},reason:'You answered four days.'}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'I explicitly accept adding one weekly practice session and no other change.\n{"frequency":{"question":"How many days?","answer":"4 days"}}',
    );
    expect(result.tasks[0].recurrenceConfig).toEqual({timesPerWeek:1,allowedWeekdays:undefined,excludedWeekdays:undefined});
    expect(result.description).toMatch(/single weekly activity/i);
    expect(result.tasks[0].reason).toMatch(/one weekly addition/i);
  });

  it('turns user-defined outcome evidence into executable deliverables',()=>{
    const result=validateAndNormalizeDraft(
      {...baseDraft,tasks:[{...baseDraft.tasks[0],title:'Take the first concrete step',description:'Generic fallback.',reason:'This conservative fallback preserves the goal.',recurrence:{type:'ONCE'}}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'The outcome must be demonstrated by a batch pipeline, one streaming prototype, tested transformations, and architecture notes.',
    );
    expect(result.tasks.map((task)=>task.title)).toEqual([
      'Deliver: batch pipeline','Deliver: streaming prototype','Deliver: tested transformations','Deliver: architecture notes',
    ]);
    expect(result.tasks.every((task)=>task.recurrenceType==='ONCE')).toBe(true);
  });

  it('rejects a generic placeholder presented as a successful plan', () => {
    expect(() => validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [{
          ...baseDraft.tasks[0],
          title: 'Take the first concrete step',
          recurrence: { type: 'ONCE' },
        }],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'I want to get fitter.',
    )).toThrow(/generic placeholder/i);
  });

  it('does not increase workload when approval is required first', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [{
          ...baseDraft.tasks[0],
          estimatedMinutes: 15,
          progression: {
            metricType: 'MINUTES', unitLabel: 'min',
            stages: [{ target: 15, minDays: 7 }, { target: 25, minDays: 7 }],
          },
        }],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Require my approval before increasing weekly workload.',
    );
    expect(result.tasks[0].progression).toBeNull();
  });

  it('moves model weekdays into an explicit weekday-only domain', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [{
          ...baseDraft.tasks[0],
          recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [0, 2, 4] },
        }],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Schedule three blocks on weekday mornings, but never on Friday.',
    );
    expect(result.tasks[0].recurrenceConfig.weekdays).toEqual([1, 2, 3]);
  });

  it('removes invented precision for an undefined success metric', () => {
    const result = validateAndNormalizeDraft(
      { ...baseDraft, targetType: 'QUANTITY', targetValue: 95 },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Make me 95% more productive without a defined baseline.',
    );
    expect(result.targetType).toBe('HABIT');
    expect(result.targetValue).toBeNull();
  });

  it('clamps invented monthly contributions to the user cap', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [{ ...baseDraft.tasks[0], title: 'Add €1,000 bonus in month 1' }],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Contribute at most €450 per month.',
    );
    expect(result.tasks[0].title).toContain('€450');
  });

  it('rejects a plan nobody could sustain', () => {
    expect(() =>
      validateAndNormalizeDraft(
        {
          ...baseDraft,
          tasks: Array.from({ length: 8 }, (_, i) => ({
            ...baseDraft.tasks[0],
            title: `Task ${i}`,
            estimatedMinutes: 240,
            recurrence: { type: 'EVERY_DAY' as const },
          })),
        },
        'UTC',
      ),
    ).toThrow(DraftValidationError);
  });

  it('trims a long-but-plausible session', () => {
    const result = validateAndNormalizeDraft(
      { ...baseDraft, tasks: [{ ...baseDraft.tasks[0], estimatedMinutes: 300 }] },
      'UTC',
    );
    expect(result.tasks[0].estimatedMinutes).toBe(240);
  });

  it('rejects a session length that is not a real session', () => {
    expect(() =>
      validateAndNormalizeDraft(
        { ...baseDraft, tasks: [{ ...baseDraft.tasks[0], estimatedMinutes: 900 }] },
        'UTC',
      ),
    ).toThrow(DraftValidationError);
  });
});

describe('AI build-up ladders', () => {
  // A ladder is an enhancement nobody asked for, so every failure below drops the
  // ladder and keeps the plan. Losing a plan the user waited for, over a suggestion
  // they never requested, would be the worse trade every time.
  const laddered = (
    progression: unknown,
    task: Record<string, unknown> = {},
  ) => ({
    ...baseDraft,
    tasks: [{ ...baseDraft.tasks[0], estimatedMinutes: 15, progression, ...task }],
  });

  const ladder = (targets: number[], minDays = 7) => ({
    metricType: 'MINUTES' as const,
    unitLabel: 'min',
    stages: targets.map((target) => ({ target, minDays })),
  });

  it('keeps a sensible ladder', () => {
    const result = validateAndNormalizeDraft(laddered(ladder([15, 20, 30])) as never, 'UTC');
    expect(result.tasks[0].progression?.stages.map((s) => s.target)).toEqual([15, 20, 30]);
    expect(result.tasks[0].progression?.unitLabel).toBe('min');
  });

  it('starts the task on the first rung, not the number the model typed', () => {
    const result = validateAndNormalizeDraft(
      laddered(ladder([15, 20, 30]), { estimatedMinutes: 30 }) as never,
      'UTC',
    );
    expect(result.tasks[0].estimatedMinutes).toBe(15);
    expect(result.adjustments.join(' ')).toMatch(/starts at 15 minutes/i);
  });

  it('prices the task from the starting rung, so a steep climb earns no more today', () => {
    const result = validateAndNormalizeDraft(laddered(ladder([15, 30, 60])) as never, 'UTC');
    expect(result.tasks[0].reward).toBe(rewardForTask({ estimatedMinutes: 15 }));
    expect(result.tasks[0].reward).not.toBe(rewardForTask({ estimatedMinutes: 60 }));
  });

  it('drops a ladder on a one-off task, which has nothing to climb over', () => {
    const result = validateAndNormalizeDraft(
      laddered(ladder([15, 20, 30]), { recurrence: { type: 'ONCE' as const } }) as never,
      'UTC',
    );
    expect(result.tasks[0].progression).toBeNull();
    expect(result.adjustments.join(' ')).toMatch(/nothing to build up over/i);
  });

  it('drops a ladder that does not actually climb', () => {
    const result = validateAndNormalizeDraft(laddered(ladder([20, 20, 15])) as never, 'UTC');
    expect(result.tasks[0].progression).toBeNull();
    expect(result.adjustments.join(' ')).toMatch(/fewer than two real steps/i);
    // The plan survives. That is the whole point.
    expect(result.tasks).toHaveLength(1);
  });

  it('drops rungs that vanish into each other once rounded', () => {
    const result = validateAndNormalizeDraft(laddered(ladder([10, 10.4, 20])) as never, 'UTC');
    expect(result.tasks[0].progression?.stages.map((s) => s.target)).toEqual([10, 20]);
  });

  it('trims a ladder the model padded out to look thorough', () => {
    const result = validateAndNormalizeDraft(
      laddered(ladder([15, 16, 17, 18, 19, 20, 21, 22])) as never,
      'UTC',
    );
    expect(result.tasks[0].progression?.stages).toHaveLength(6);
    expect(result.adjustments.join(' ')).toMatch(/trimmed from 8 steps to 6/i);
  });

  it('refuses to hold a step for a single day', () => {
    const result = validateAndNormalizeDraft(laddered(ladder([15, 20], 1)) as never, 'UTC');
    expect(result.tasks[0].progression?.stages.every((s) => s.minDays >= 3)).toBe(true);
  });

  it('judges the workload at the top of the ladder, not the bottom', () => {
    // 15 minutes a day is trivially sustainable; 240 is not, and the plan is a
    // promise to get there. Measuring rung one would wave through a climb into a
    // wall.
    expect(() =>
      validateAndNormalizeDraft(
        laddered(ladder([15, 60, 120, 240]), {
          recurrence: { type: 'EVERY_DAY' as const },
        }) as never,
        'UTC',
      ),
    ).toThrow(DraftValidationError);
  });

  it('leaves a task with no ladder alone', () => {
    const result = validateAndNormalizeDraft(baseDraft, 'UTC');
    expect(result.tasks[0].progression).toBeNull();
    expect(result.adjustments.join(' ')).not.toMatch(/build-up/i);
  });
});

describe('reward calculation', () => {
  it('derives reward from effort, never from the model', () => {
    expect(rewardForTask({ estimatedMinutes: 5 })).toBe(5);
    expect(rewardForTask({ estimatedMinutes: 20 })).toBe(10);
    expect(rewardForTask({ estimatedMinutes: 35 })).toBe(15);
    expect(rewardForTask({ estimatedMinutes: 60 })).toBe(20);
    expect(rewardForTask({ estimatedMinutes: 180 })).toBe(25);
  });

  it('is bounded, so an AI-created goal cannot inflate the leaderboard', () => {
    const rewards = [1, 10, 45, 120, 600].map((m) => rewardForTask({ estimatedMinutes: m }));
    expect(Math.max(...rewards)).toBeLessThanOrEqual(25);
  });

  it('ignores any reward the model tries to supply', () => {
    const parsed = goalDraftSchema.parse({
      ...baseDraft,
      tasks: [{ ...baseDraft.tasks[0], reward: 9999, rewardSuggestion: 9999 }],
    });
    expect(parsed.tasks[0]).not.toHaveProperty('reward');
  });
});

describe('lenient parsing of common model quirks', () => {
  it('pads a single-digit time', () => {
    const parsed = goalDraftSchema.parse({
      ...baseDraft,
      tasks: [{ ...baseDraft.tasks[0], preferredTime: '8:00' }],
    });
    expect(parsed.tasks[0].preferredTime).toBe('08:00');
  });

  it('still rejects something that is not a time at all', () => {
    const result = goalDraftSchema.safeParse({
      ...baseDraft,
      tasks: [{ ...baseDraft.tasks[0], preferredTime: 'in the morning' }],
    });
    expect(result.success).toBe(false);
  });

  it('treats an unknown preference scope as session-only', () => {
    // The model confuses `scope` with `persistence` and answers "SESSION".
    const parsed = preferenceExtractionSchema.parse({
      preferences: [
        {
          key: 'preferred_activity',
          value: 'dancing',
          scope: 'SESSION',
          confidence: 0.9,
          persistence: 'LONG_TERM',
        },
      ],
    });
    expect(parsed.preferences[0].scope).toBe('SESSION_ONLY');
  });

  it('drops an invented category instead of failing extraction', () => {
    const parsed = preferenceExtractionSchema.parse({
      preferences: [
        {
          key: 'preferred_language',
          value: 'spanish',
          scope: 'CATEGORY',
          category: 'LANGUAGE',
          confidence: 0.9,
          persistence: 'LONG_TERM',
        },
      ],
    });
    expect(parsed.preferences[0].category).toBeNull();
  });

  it('coerces a numeric preference value', () => {
    const parsed = preferenceExtractionSchema.parse({
      preferences: [
        {
          key: 'days_per_week',
          value: 5,
          scope: 'GLOBAL',
          confidence: 0.9,
          persistence: 'LONG_TERM',
        },
      ],
    });
    expect(parsed.preferences[0].value).toBe('5');
  });
});

describe('draft patches', () => {
  it('accepts a minimal field update', () => {
    const parsed = draftPatchSchema.parse({
      assistantMessage: 'Made the walks 30 minutes.',
      operations: [{ type: 'UPDATE_TASK', taskId: 'task-1', changes: { estimatedMinutes: 30 } }],
    });
    expect(parsed.operations).toHaveLength(1);
  });

  it('rejects an unknown operation type', () => {
    const result = draftPatchSchema.safeParse({
      assistantMessage: 'ok',
      operations: [{ type: 'DROP_DATABASE', taskId: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty patch', () => {
    expect(draftPatchSchema.safeParse({ assistantMessage: 'ok', operations: [] }).success).toBe(
      false,
    );
  });
});
