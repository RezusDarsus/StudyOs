import { describe, expect, it } from 'vitest';
import { safeParseJson } from './client.js';
import { stripThinking } from './nvidia-provider.js';
import {
  copilotQuestionSchema,
  goalDraftSchema,
  interviewResponseSchema,
  draftPatchSchema,
  preferenceExtractionSchema,
  MAX_RECOMMENDATIONS,
  progressAnalysisSchema,
  progressAnalysisSchemaV7,
  recommendationItemSchema,
} from './schemas.js';
import {
  DraftValidationError,
  rewardForTask,
  validateAndNormalizeDraft,
} from './draft-validator.js';
import { buildConstraintContract } from './constraint-contract.js';
import { parseFinancialPlan } from './financial-plan.js';
import type { ConstraintContract } from './constraint-contract.js';
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

/**
 * Stage 6: the deterministic repair trims are contract-driven. Tests that
 * exercise a trim pass the AST-projected contract (as the pipeline does via
 * contractsFromState) instead of relying on a prose parser.
 */
const contractOf = (
    patch: Record<string, unknown> = {},
    extras: { excludedMonths?: string[] } = {},
  ): ConstraintContract[] => [
  buildConstraintContract({
    excludedDays: [],
    forbiddenActivities: [],
    requiredWeeklyRoles: [],
    requiredRoleDays: [],
    prohibitConsecutiveEvenings: false,
    undefinedMetric: false,
    requiresClarification: false,
    roleMinWeekly: [],
    roleDays: [],
    ...patch,
  } as Parameters<typeof buildConstraintContract>[0], extras),
];

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
      contractOf({ exactWeekly: 3, allowedDays: [1, 2, 4, 6], requiredRoleDays: [{ role: 'TRAIL', days: [6] }] }),
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
      contractOf({ exactWeekly: 3, allowedDays: [1, 2, 4, 6], requiredRoleDays: [{ role: 'TRAIL', days: [6] }], requiredWeeklyRoles: [{ role: 'STRENGTH', minOccurrences: 1 }] }),
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
          { ...baseDraft.tasks[0], title: 'Guitar practice', recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 } },
          { ...baseDraft.tasks[0], title: 'Review', recurrence: { type: 'TIMES_PER_WEEK', timesPerWeek: 3 } },
        ],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Practice exactly three times per week.',
      contractOf({ exactWeekly: 3 }),
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
      contractOf({ calendarFrequency: { intervalMonths: 1 } }),
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


  it('encodes skipped finance months in the executable recurrence',()=>{
    const result=validateAndNormalizeDraft(
      {...baseDraft,category:'FINANCE',deadline:'2027-09-30',tasks:[{...baseDraft.tasks[0],title:'Tuition transfer €350',recurrence:{type:'MONTHLY',excludedMonths:['2026-12','2027-01']}}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'I need €4,800 by September 30, 2027. I can save €350 per month, except nothing in December 2026 and January 2027.',
      contractOf({}, { excludedMonths: ['2026-12','2027-01'] }),
    );
    expect(result.tasks[0].recurrenceConfig.excludedMonths).toEqual(['2026-12','2027-01']);
  });


  it('represents conditional recovery policy without applying progression', () => {
    const result=validateAndNormalizeDraft(
      {...baseDraft,tasks:[{...baseDraft.tasks[0],title:'Ankle strength',progression:{metricType:'MINUTES',unitLabel:'min',stages:[{target:20,minDays:7},{target:30,minDays:7}]}}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'Progress only after two pain-free weeks, reduce after repeated pain, pause for sharp pain, and wait for my approval.',
      contractOf({}),
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
      contractOf({}),
    );
    expect(result.tasks[0].progression).toBeNull();
  });

  it('does not schedule or progress a deferred user-controlled resume',()=>{
    const result=validateAndNormalizeDraft(
      {...baseDraft,tasks:[{...baseDraft.tasks[0],title:'Resume training Monday',description:'Resume Monday after two weeks.',recurrence:{type:'SPECIFIC_WEEKDAYS',weekdays:[1]},progression:{metricType:'MINUTES',unitLabel:'min',stages:[{target:30,minDays:14},{target:40,minDays:14}]}}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'Recommend PAUSE, preserve the current stage, and let me decide when to resume after two weeks.',
      contractOf({}),
    );
    expect(result.tasks[0]).toMatchObject({title:'Review whether to resume',recurrenceType:'ONCE',progression:null});
    expect(result.tasks[0].description).toMatch(/no training session is scheduled automatically/i);
    expect(result.rationale).toMatch(/no automatic resume/i);
  });

  it('keeps an accepted one-session delta distinct from contradictory interview answers',()=>{
    const result=validateAndNormalizeDraft(
      {...baseDraft,description:'Four sessions every week.',tasks:[{...baseDraft.tasks[0],title:'Guitar practice',recurrence:{type:'SPECIFIC_WEEKDAYS',weekdays:[1,3,5,0]},reason:'You answered four days.'}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'I explicitly accept adding one weekly practice session and no other change.\n{"frequency":{"question":"How many days?","answer":"4 days"}}',
      contractOf({ exactWeekly: 1 }),
    );
    expect(result.tasks[0].recurrenceConfig).toEqual({timesPerWeek:1,allowedWeekdays:undefined,excludedWeekdays:undefined});
    expect(result.description).toMatch(/single weekly activity/i);
    expect(result.tasks[0].reason).toMatch(/one weekly addition/i);
  });

  it('turns user-defined outcome evidence into executable deliverables',()=>{
    const result=validateAndNormalizeDraft(
      {...baseDraft,tasks:[{...baseDraft.tasks[0],title:'Take the opening step',description:'Generic fallback.',reason:'This conservative fallback preserves the goal.',recurrence:{type:'ONCE'}}]},
      'UTC',new Date('2026-08-25T10:00:00Z'),
      'The outcome must be demonstrated by a batch pipeline, one streaming prototype, tested transformations, and architecture notes.',
      contractOf({}),
    );
    expect(result.tasks.map((task)=>task.title)).toEqual([
      'Deliver: batch pipeline','Deliver: streaming prototype','Deliver: tested transformations','Deliver: architecture notes',
    ]);
    expect(result.tasks.every((task)=>task.recurrenceType==='ONCE')).toBe(true);
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
      contractOf({}),
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
      contractOf({ exactWeekly: 3, allowedDays: [1, 2, 3, 4], excludedDays: [5] }),
    );
    expect(result.tasks[0].recurrenceConfig.weekdays).toEqual([1, 2, 3]);
  });

  it('removes invented precision for an undefined success metric', () => {
    const result = validateAndNormalizeDraft(
      { ...baseDraft, targetType: 'QUANTITY', targetValue: 95 },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Make me 95% more productive without a defined baseline.',
      contractOf({ undefinedMetric: true }),
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
      contractOf({ monthlyMoneyCap: 450 }),
    );
    expect(result.tasks[0].title).toContain('€450');
  });

  it('surfaces bounded monthly phases as advisory evidence (Rev.4 finance certification)', () => {
    // Rev.4: bounded monthly phases are INTENTIONALLY_ADVISORY — surfaced
    // through the advisory lines, never silently enforced or silently dropped.
    const source = 'By August 31, 2027 eliminate a €3,600 balance and build a €5,000 fund. We have €900 available now and can contribute €650 per month from September through November, €300 in December and January, and €700 per month from February onward.';
    const sourceFinancialPlan = parseFinancialPlan(source, '');
    expect(sourceFinancialPlan?.monthlyCaps?.length).toBe(3);
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

describe('near-duplicate task titles', () => {
  const titledTasks = (titles: string[]) => ({
    ...baseDraft,
    tasks: titles.map((title) => ({
      ...baseDraft.tasks[0],
      title,
      recurrence: { type: 'TIMES_PER_WEEK' as const, timesPerWeek: 2 },
    })),
  });

  it('removes the later of two titles that share the same meaningful words', () => {
    // Same three tokens in a different word order — the exact-title and labelled
    // dedup passes above cannot see this one.
    const result = validateAndNormalizeDraft(
      titledTasks(['Morning run in the park', 'Park run in the morning']),
      'UTC',
    );
    expect(result.tasks.map((task) => task.title)).toEqual(['Morning run in the park']);
    expect(result.adjustments).toContain('Removed near-duplicate task "Park run in the morning"');
  });

  it('removes at the 0.8 boundary, where titles share four of five tokens', () => {
    const result = validateAndNormalizeDraft(
      titledTasks(['Morning easy run in the park', 'Easy park run in the morning with a warmup']),
      'UTC',
    );
    expect(result.tasks).toHaveLength(1);
  });

  it('keeps titles whose overlap is below the threshold', () => {
    const result = validateAndNormalizeDraft(
      titledTasks(['Morning run in the park', 'Evening swim at the pool']),
      'UTC',
    );
    expect(result.tasks).toHaveLength(2);
    expect(result.adjustments.join(' ')).not.toMatch(/near-duplicate/i);
  });

  it('skips pairs where either title is too short to judge', () => {
    // "Warmup" carries a single meaningful token; comparing it by overlap
    // would judge nothing.
    const result = validateAndNormalizeDraft(titledTasks(['Warmup', 'Warmup scales']), 'UTC');
    expect(result.tasks).toHaveLength(2);
    expect(result.adjustments.join(' ')).not.toMatch(/near-duplicate/i);
  });
});

describe('placeholder task titles', () => {
  it('rejects a draft whose task title is an exact placeholder', () => {
    expect(() =>
      validateAndNormalizeDraft(
        { ...baseDraft, tasks: [{ ...baseDraft.tasks[0], title: 'Take Action' }] },
        'UTC',
      ),
    ).toThrow(/is a placeholder, not a real task/);
  });

  it('rejects every phrase on the placeholder list, whatever the casing', () => {
    for (const title of ['Take the first concrete step', 'daily practice', 'Work On My Goal']) {
      expect(() =>
        validateAndNormalizeDraft(
          { ...baseDraft, tasks: [{ ...baseDraft.tasks[0], title }] },
          'UTC',
        ),
        title,
      ).toThrow(DraftValidationError);
    }
  });

  it('never throws on the vaguer heuristic — that stays a scoring signal', () => {
    // "Do the thing" scores as generic but is not a certain placeholder, so the
    // draft survives and the quality gate carries the complaint instead.
    const result = validateAndNormalizeDraft(
      { ...baseDraft, tasks: [{ ...baseDraft.tasks[0], title: 'Do the thing' }] },
      'UTC',
    );
    expect(result.tasks).toHaveLength(1);
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

describe('constraint contract repair', () => {
  const financeDraft = {
    ...baseDraft,
    category: 'FINANCE' as const,
    title: 'Rent fund',
    tasks: [{ ...baseDraft.tasks[0], title: 'Transfer 500 GEL', recurrence: { type: 'MONTHLY' as const } }],
  };

  it('preserves the user-stated day of month on a finance monthly task', () => {
    const result = validateAndNormalizeDraft(
      financeDraft,
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Transfer 500 GEL monthly on the 1st, starting September 2026.',
      contractOf({ calendarFrequency: { intervalMonths: 1, dayOfMonth: 1 } }),
    );
    expect(result.tasks[0].recurrenceType).toBe('MONTHLY');
    expect(result.tasks[0].recurrenceConfig.dayOfMonth).toBe(1);
  });

  it('preserves every-N-months cadence with its stated day', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        category: 'FINANCE',
        tasks: [{ ...baseDraft.tasks[0], title: 'Transfer 500 GEL', recurrence: { type: 'MONTHLY' } }],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Transfer 500 GEL every three months on the fifteenth of each month.',
      contractOf({ calendarFrequency: { intervalMonths: 3, dayOfMonth: 15 } }),
    );
    expect(result.tasks[0].recurrenceType).toBe('EVERY_X_MONTHS');
    expect(result.tasks[0].recurrenceConfig.intervalMonths).toBe(3);
    expect(result.tasks[0].recurrenceConfig.dayOfMonth).toBe(15);
  });

  it('carries a task-stated day of month into an empty monthly recurrence', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        category: 'FINANCE',
        tasks: [{ ...baseDraft.tasks[0], title: 'Pay rent on the 1st', recurrence: { type: 'MONTHLY' } }],
      },
      'UTC',
    );
    expect(result.tasks[0].recurrenceConfig.dayOfMonth).toBe(1);
    expect(result.adjustments).toContain('Carried the stated day of month into "Pay rent on the 1st"');
  });

  it('leaves a non-finance monthly cadence alone', () => {
    const result = validateAndNormalizeDraft(
      { ...baseDraft, tasks: [{ ...baseDraft.tasks[0], title: 'Read a book', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [1] } }] },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'Read one book a month.',
    );
    expect(result.tasks[0].recurrenceType).toBe('SPECIFIC_WEEKDAYS');
  });

  it('merges identical weekly dinners instead of dropping their occurrences', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [
          { ...baseDraft.tasks[0], title: 'Family dinner', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [1] } },
          { ...baseDraft.tasks[0], title: 'Family dinner', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [3] } },
          { ...baseDraft.tasks[0], title: 'Family dinner', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [5] } },
        ],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'We eat dinner together three times per week.',
      contractOf({ exactWeekly: 3 }),
    );
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].recurrenceConfig.weekdays).toEqual([1, 3, 5]);
    const weekly = result.tasks.reduce(
      (sum, task) => sum + (task.recurrenceConfig.weekdays?.length ?? 0), 0,
    );
    expect(weekly).toBe(3);
    expect(result.adjustments.join(' ')).toMatch(/Merged duplicate task/);
  });

  it('merges weekday-labelled duplicates so the schedule keeps every day', () => {
    const result = validateAndNormalizeDraft(
      {
        ...baseDraft,
        tasks: [
          { ...baseDraft.tasks[0], title: 'Calculus (Tuesday)', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [2] } },
          { ...baseDraft.tasks[0], title: 'Calculus (Saturday)', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [6] } },
        ],
      },
      'UTC',
      new Date('2026-08-25T10:00:00Z'),
      'My calculus course meets twice per week.',
      contractOf({ exactWeekly: 2 }),
    );
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].recurrenceConfig.weekdays).toEqual([2, 6]);
  });

  it('rejects a duplicate merge that cannot preserve the stated total', () => {
    // Three identical Monday dinners cannot become one dinner without losing
    // two-thirds of the week's schedule, so the draft is rejected with the
    // violation instead of the total being silently rewritten.
    expect(() =>
      validateAndNormalizeDraft(
        {
          ...baseDraft,
          tasks: [
            { ...baseDraft.tasks[0], title: 'Family dinner', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [1] } },
            { ...baseDraft.tasks[0], title: 'Family dinner', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [1] } },
            { ...baseDraft.tasks[0], title: 'Family dinner', recurrence: { type: 'SPECIFIC_WEEKDAYS', weekdays: [1] } },
          ],
        },
        'UTC',
        new Date('2026-08-25T10:00:00Z'),
        'We eat dinner together three times per week.',
        contractOf({ exactWeekly: 3 }),
      ),
    ).toThrow(/exactly 3 total sessions per week/);
  });

});

describe('recommendation item schema (domain-open, Stage 1)', () => {
  const validItem = {
    entityType: 'pottery_class',
    displayName: 'Wheel Throwing for Beginners',
    attribution: 'Clay House Studio',
    reason: 'Beginner-friendly and close to the city centre.',
  };

  it('accepts a full item', () => {
    expect(recommendationItemSchema.parse(validItem)).toEqual(validItem);
  });

  it('accepts a minimal item — attribution and reason are optional', () => {
    const parsed = recommendationItemSchema.parse({ entityType: 'x', displayName: 'A' });
    expect(parsed).toEqual({ entityType: 'x', displayName: 'A' });
  });

  it('is an open set: arbitrary entity types pass', () => {
    // Values named nowhere in production code — the set is runtime data.
    for (const entityType of ['pottery_class', 'x', 'lptr9', 'street-food', 'k9_training']) {
      expect(() => recommendationItemSchema.parse({ ...validItem, entityType })).not.toThrow();
    }
  });

  it('normalizes entityType casing and surrounding whitespace', () => {
    const parsed = recommendationItemSchema.parse({ ...validItem, entityType: '  Pottery_Class ' });
    expect(parsed.entityType).toBe('pottery_class');
  });

  it('rejects an empty displayName and an oversized one', () => {
    expect(() => recommendationItemSchema.parse({ ...validItem, displayName: '   ' })).toThrow();
    expect(() =>
      recommendationItemSchema.parse({ ...validItem, displayName: 'a'.repeat(201) }),
    ).toThrow();
  });

  it('enforces the identifier mechanic: start letter, charset, length', () => {
    expect(() => recommendationItemSchema.parse({ ...validItem, entityType: '1abc' })).toThrow();
    expect(() => recommendationItemSchema.parse({ ...validItem, entityType: 'has space' })).toThrow();
    expect(() => recommendationItemSchema.parse({ ...validItem, entityType: 'a'.repeat(41) })).toThrow();
    expect(() => recommendationItemSchema.parse({ ...validItem, entityType: '' })).toThrow();
  });

  it('rejects oversized attribution and reason', () => {
    expect(() =>
      recommendationItemSchema.parse({ ...validItem, attribution: 'a'.repeat(201) }),
    ).toThrow();
    expect(() => recommendationItemSchema.parse({ ...validItem, reason: 'a'.repeat(301) })).toThrow();
  });
});

describe('progress analysis schema (Stage 1 additive fields)', () => {
  const baseAnalysis = {
    explanation: 'A consistent result — keep the current schedule.',
    suggestions: [],
  };

  it('tolerates absence of the new fields on the legacy path', () => {
    // Legacy payloads (and legacy acceptance stubs) parse exactly as before.
    const parsed = progressAnalysisSchema.parse(baseAnalysis);
    expect(parsed.recommendations).toBeUndefined();
    expect(parsed.recommendsItems).toBeUndefined();
  });

  it('accepts a payload with recommendations and no self-report (tolerant base)', () => {
    expect(() =>
      progressAnalysisSchema.parse({ ...baseAnalysis, recommendations: [{ entityType: 'x', displayName: 'A' }] }),
    ).not.toThrow();
  });

  it('rejects more than MAX_RECOMMENDATIONS items', () => {
    const items = Array.from(
      { length: MAX_RECOMMENDATIONS + 1 },
      (_, i) => ({ entityType: 'x', displayName: `Item ${i}` }),
    );
    expect(() => progressAnalysisSchema.parse({ ...baseAnalysis, recommendations: items })).toThrow();
  });

  it('V7 requires recommendsItems — the flag-on contract is strict', () => {
    expect(() => progressAnalysisSchemaV7.parse(baseAnalysis)).toThrow();
    expect(() =>
      progressAnalysisSchemaV7.parse({ ...baseAnalysis, recommendsItems: true, recommendations: [] }),
    ).not.toThrow();
    expect(() =>
      progressAnalysisSchemaV7.parse({ ...baseAnalysis, recommendsItems: false, recommendations: [] }),
    ).not.toThrow();
  });
});
