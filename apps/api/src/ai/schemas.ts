import { z } from 'zod';
import { GOAL_CATEGORY, PROGRESSION_METRIC, RECURRENCE_TYPE, TARGET_TYPE } from '../domain/enums.js';
import { isDayString } from '../domain/dates.js';

// Everything the model returns is parsed through these. The backend enums stay
// authoritative — the model can only pick from what Phase 1 already supports, so
// it can never invent a recurrence like "SOMETIMES_WHEN_MOTIVATED" or hand the
// frontend an arbitrary component to render.

export const SCHEMA_VERSION = 1;

export const QUESTION_TYPES = [
  'FREE_TEXT',
  'SINGLE_SELECT',
  'MULTI_SELECT',
  'NUMBER',
  'DATE',
  'TIME',
  'DAYS_OF_WEEK',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/**
 * Option lists are bounded: too few is pointless, too many is a wall of buttons.
 *
 * Numbers are coerced rather than rejected — a "how many days per week?" question
 * legitimately comes back as [3, 4, 5, 6], and failing the whole turn over that
 * just burns a retry to get the same list back as strings.
 */
const optionSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().min(1).max(60));

/** Accept 8:00 as well as 08:00; reject anything that is not a time. */
const looseTime = z
  .union([z.string(), z.number()])
  .transform((v) => {
    const match = String(v).trim().match(/^(\d{1,2}):([0-5]\d)$/);
    if (!match) return String(v).trim();
    return `${match[1].padStart(2, '0')}:${match[2]}`;
  })
  .pipe(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'));

export const copilotQuestionSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/, 'question id must be snake_case'),
  type: z.enum(QUESTION_TYPES),
  prompt: z.string().trim().min(1).max(300),
  /**
   * Models routinely send `null` or `[]` rather than omitting a field, and a
   * NUMBER or FREE_TEXT question legitimately has no options. So the count is
   * only enforced for the types that actually render a choice list — see the
   * superRefine below.
   */
  options: z
    .array(optionSchema)
    .max(8)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  allowCustomAnswer: z.boolean().nullish().transform((v) => v ?? false),
  optional: z.boolean().nullish().transform((v) => v ?? true),
  unit: z.string().trim().max(20).nullish(),
});
export type CopilotQuestion = z.infer<typeof copilotQuestionSchema>;

/**
 * Free-form but bounded context. Different categories genuinely need different
 * fields (a saving goal has no "disliked activities"), so this is deliberately
 * permissive in shape while capped in size.
 */
export const extractedContextSchema = z.record(z.unknown()).optional();

export const interviewResponseSchema = z
  .object({
    state: z.enum(['NEEDS_MORE_INFORMATION', 'READY_TO_GENERATE']),
    assistantMessage: z.string().trim().min(1).max(400),
    question: copilotQuestionSchema.nullish(),
    extractedContext: extractedContextSchema,
    /**
     * Keys the user has just explicitly CHANGED ("actually, I meant swimming").
     * These enter at user authority and supersede the earlier statement, which a
     * normal extraction is not allowed to do.
     */
    corrections: z.record(z.unknown()).nullish(),
    category: z.enum(GOAL_CATEGORY).nullish(),
  })
  .superRefine((value, ctx) => {
    // A select question without options would render as an empty list.
    if (value.question) {
      const needsOptions =
        value.question.type === 'SINGLE_SELECT' || value.question.type === 'MULTI_SELECT';
      if (needsOptions && (!value.question.options || value.question.options.length < 2)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${value.question.type} requires at least 2 options`,
          path: ['question', 'options'],
        });
      }
    }
    if (value.state === 'NEEDS_MORE_INFORMATION' && !value.question) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'NEEDS_MORE_INFORMATION requires a question',
        path: ['question'],
      });
    }
  });
export type InterviewResponse = z.infer<typeof interviewResponseSchema>;

// ---------------------------------------------------------------- goal draft

const dayString = z
  .string()
  .trim()
  .refine(isDayString, 'expected YYYY-MM-DD');

const timeString = looseTime;

export const draftRecurrenceSchema = z.object({
  type: z.enum(RECURRENCE_TYPE),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  timesPerWeek: z.number().int().min(1).max(7).optional(),
  allowedWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  excludedWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  intervalDays: z.number().int().min(1).max(90).optional(),
  dayOfMonth: z.union([z.number().int().min(1).max(31), z.literal('LAST')]).optional(),
  intervalMonths: z.number().int().min(1).max(120).optional(),
});

/**
 * A proposed build-up ladder: walk 15 minutes, then 20, then 25, then 30.
 *
 * Deliberately permissive — an empty or one-rung "ladder" parses and is dropped
 * later with a note, because a plan the user waited thirty seconds for should not
 * be thrown away over a suggestion they never asked for. What is *sensible* is
 * decided in draft-validator.ts, and the ladder itself is finally checked by the
 * same `validateStages` Phase 1 uses for a hand-made progression.
 */
export const draftProgressionSchema = z.object({
  metricType: z.enum(PROGRESSION_METRIC),
  /** Display-only suffix: "min", "pages", "km". Never parsed. */
  unitLabel: z.string().trim().max(16).default(''),
  stages: z
    .array(
      z.object({
        // Coerced and rounded later: models write "20" and 2.5 as readily as 20.
        target: z.coerce.number().positive().max(100000),
        minDays: z.coerce.number().int().min(1).max(60).nullish(),
      }),
    )
    .max(12)
    .default([]),
});
export type DraftProgressionInput = z.infer<typeof draftProgressionSchema>;

export const draftTaskSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).default(''),
  recurrence: draftRecurrenceSchema,
  estimatedMinutes: z.number().int().min(1).max(600).nullish(),
  preferredTime: timeString.nullish(),
  /** The personalised justification, echoed back on the review screen. */
  reason: z.string().trim().max(300).default(''),
  /** Optional, and rare: only for a task whose difficulty should genuinely grow. */
  progression: draftProgressionSchema.nullish(),
});
export type DraftTaskInput = z.infer<typeof draftTaskSchema>;

export const goalDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  category: z.enum(GOAL_CATEGORY),
  targetType: z.enum(TARGET_TYPE),
  targetValue: z.number().int().min(1).max(100000).nullish(),
  deadline: dayString.nullish(),
  /** Why this plan fits this person — must reference their actual answers. */
  rationale: z.string().trim().min(1).max(600),
  // A plan with 12 daily tasks is not a plan anyone follows.
  tasks: z.array(draftTaskSchema).min(1).max(8),
});
export type GoalDraftInput = z.infer<typeof goalDraftSchema>;

// --------------------------------------------------------------- draft edits

export const draftPatchSchema = z.object({
  /** Short, friendly confirmation of what changed. */
  assistantMessage: z.string().trim().min(1).max(300),
  operations: z
    .array(
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('UPDATE_GOAL'),
          changes: z.object({
            title: z.string().trim().min(1).max(120).optional(),
            description: z.string().trim().max(1000).optional(),
            deadline: dayString.nullish(),
            targetValue: z.number().int().min(1).max(100000).nullish(),
          }),
        }),
        z.object({
          type: z.literal('UPDATE_TASK'),
          taskId: z.string().trim().min(1),
          changes: z.object({
            title: z.string().trim().min(1).max(120).optional(),
            description: z.string().trim().max(400).optional(),
            recurrence: draftRecurrenceSchema.optional(),
            estimatedMinutes: z.number().int().min(1).max(600).nullish(),
            preferredTime: timeString.nullish(),
            reason: z.string().trim().max(300).optional(),
          }),
        }),
        z.object({ type: z.literal('REMOVE_TASK'), taskId: z.string().trim().min(1) }),
        z.object({ type: z.literal('ADD_TASK'), task: draftTaskSchema }),
      ]),
    )
    .min(1)
    .max(10),
});
export type DraftPatch = z.infer<typeof draftPatchSchema>;

// ------------------------------------------------------------- preferences

export const PREFERENCE_PERSISTENCE = ['SESSION_ONLY', 'GOAL_SPECIFIC', 'LONG_TERM'] as const;

export const preferenceExtractionSchema = z.object({
  preferences: z
    .array(
      z.object({
        key: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .regex(/^[a-z0-9_]+$/, 'preference key must be snake_case'),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .transform((v) => String(v).trim())
          .pipe(z.string().min(1).max(120)),
        // The model regularly answers SESSION / SESSION_ONLY here, confusing this
        // with `persistence`. Anything that is not a real scope is treated as
        // session-only, which simply means it is not stored.
        scope: z
          .string()
          .transform((v) => (v === 'GLOBAL' || v === 'CATEGORY' ? v : 'SESSION_ONLY'))
          .pipe(z.enum(['GLOBAL', 'CATEGORY', 'SESSION_ONLY'])),
        // It also invents categories ("LANGUAGE"). Unknown ones become null rather
        // than failing the whole extraction.
        category: z
          .string()
          .nullish()
          .transform((v) =>
            v && (GOAL_CATEGORY as readonly string[]).includes(v)
              ? (v as (typeof GOAL_CATEGORY)[number])
              : null,
          ),
        confidence: z.coerce.number().min(0).max(1),
        persistence: z
          .string()
          .transform((v) =>
            (PREFERENCE_PERSISTENCE as readonly string[]).includes(v) ? v : 'SESSION_ONLY',
          )
          .pipe(z.enum(PREFERENCE_PERSISTENCE)),
      }),
    )
    .max(12),
});
export type PreferenceExtraction = z.infer<typeof preferenceExtractionSchema>;

// --------------------------------------------------------- progress analysis

export const progressAnalysisSchema = z.object({
  /** Plain-language explanation grounded in the supplied statistics. */
  explanation: z.string().trim().min(1).max(800),
  suggestions: z
    .array(
      z.object({
        summary: z.string().trim().min(1).max(200),
        taskTitle: z.string().trim().max(120).nullish(),
        proposedRecurrence: draftRecurrenceSchema.nullish(),
        proposedMinutes: z.number().int().min(1).max(600).nullish(),
        /**
         * A stage change on a task that already has a build-up ladder. Recorded as
         * a proposal and never applied — ASK_USER is absent on purpose, because
         * asking is the app's job, not something the model requests.
         */
        proposedProgressionAction: z.enum(['ADVANCE', 'STAY', 'REDUCE']).nullish(),
      }),
    )
    .max(4)
    .default([]),
});
export type ProgressAnalysis = z.infer<typeof progressAnalysisSchema>;
