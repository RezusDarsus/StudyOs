import { z } from 'zod';
import { getRuntimeKnowledge, portMemo } from './runtime-knowledge.js';
import { chatJson } from './client.js';
import { PROMPT_VERSIONS, intentSystemPrompt } from './prompts.js';

// Deterministic intent routing for free text aimed at the Copilot.
//
// Before Phase B every message typed into the widget's create view became the
// opening line of a goal interview, so "What happens if I miss a day?" produced
// a questionnaire about a goal nobody asked for. This module classifies the
// message first. The rules below are deliberately tight: they only fire on
// high-confidence phrasing, and anything they do not recognise is UNKNOWN —
// the caller may consult the LLM fallback, but the rules themselves never
// guess. CREATE_GOAL in particular is only ever produced by an explicit
// pattern, never by absence of a better idea.

export const COPILOT_INTENTS = [
  'CREATE_GOAL',
  'MODIFY_GOAL',
  'GOAL_QUESTION',
  'PRODUCT_HELP',
  'GENERAL_QUESTION',
  'UNKNOWN',
] as const;
export type CopilotIntent = (typeof COPILOT_INTENTS)[number];

export interface CopilotIntentResult {
  intent: CopilotIntent;
  confidence: number;
  method: 'deterministic' | 'llm';
}

/** An LLM verdict below this is discarded — a hunch is not a decision. */
export const INTENT_CONFIDENCE_THRESHOLD = 0.7;

/** The one thing the create view says when it will not silently start an interview. */
export const INTENT_CLARIFICATION =
  'Do you want me to create a goal for this, or are you asking a question?';

/**
 * The interruption answer, used while an interview question is pending.
 *
 * Real product answers (streaks, coins, achievements, settings) come in a later
 * phase; until then the honest reply says the capability is coming and hands the
 * conversation back to the question that was open. Nothing here is invented.
 */
export const PRODUCT_HELP_STUB =
  'Good question — answers about how the app works (streaks, coins, reminders) are on the way. ' +
  'Your question is still open below whenever you are ready to continue.';

/**
 * The same honesty for goal chat, where there is no pending interview question
 * to hand back — the stub simply declines to improvise and names what the
 * Copilot can genuinely do with a live goal.
 */
export const GOAL_HELP_STUB =
  'Real answers about the app itself (streaks, coins, reminders, settings) are coming soon. ' +
  'What I can do right now is explain how this goal is going or propose schedule changes — ask me one of those.';

/** Strict shape the LLM classifier must return; anything else is discarded. */
export const intentOutputSchema = z.object({
  intent: z.enum(COPILOT_INTENTS),
  confidence: z.number().min(0).max(1),
});

const UNKNOWN: CopilotIntentResult = { intent: 'UNKNOWN', confidence: 0, method: 'deterministic' };

// ---------------------------------------------------------------- rule families
//
// Each family is a documented list of anchored regexes. Order matters: the
// product-mechanics and status families are the most specific about what the
// text is NOT (a new goal), so they run before the create rules.

/** PRODUCT_HELP — questions about the app itself, never about the user's goals. */
const PRODUCT_HELP_RULES: Array<[RegExp, number]> = [
  // "What happens if I miss a day?", "if I miss one do I lose my streak?"
  [/\bwhat happens (?:if|when)\b/, 0.9],
  [/\bif i (?:miss|skip|forget)\b/, 0.85],
  // "why did my streak reset?", "how do coins work?"
  [/\b(?:why|how) (?:did|does|do|is|are)\b[^.?!]{0,40}\b(?:streak|coins?|achievements?|points?|notifications?|reminders?)\b/, 0.92],
  // "How many coins do I get?", "how much is premium?"
  [/\bhow (?:many|much|do|does|can)\b[^.?!]{0,50}\b(?:coins?|streak|achievements?|points?|premium|subscription)\b/, 0.92],
  [/\bhow much\b[^.?!]{0,30}\b(?:is|does|cost|price|pay)\b/, 0.85],
  [/\b(?:premium|subscription|pricing|is it free|do i need to pay)\b/, 0.85],
  [/\b(?:more|free|extra) coins?\b/, 0.85],
  // "Do you sell my data?", "delete my account", "privacy"
  [/\b(?:sell|delete|remove|export|download|erase)\b[^.?!]{0,30}\b(?:my )?(?:data|information|account)\b/, 0.92],
  [/\b(?:privacy|gdpr|terms of service)\b/, 0.85],
  // Account mechanics — statements included, they are never a goal.
  [/\b(?:log ?in|log ?out|sign ?in|sign ?out|password|username)\b/, 0.9],
  // "What can you do?", "how do goals work?"
  [/\bwhat can (?:you|u|this app|the app|the copilot|copilot)\b/, 0.9],
  [/\bwhat (?:are|do)\b.{0,20}\b(?:copilot|this app)\b/, 0.85],
  [/\bhow does (?:this|it|that|the copilot|copilot)\b[^.?!]{0,20}\bwork\b/, 0.9],
  [/\bhow do (?:goals?|points?|levels?|coins?|streaks?)\b[^.?!]{0,20}\bwork\b/, 0.9],
  // "turn off notifications", "how do I move a task" — app mechanics, not edits.
  [/\b(?:turn|switch) (?:on|off)\b[^.?!]{0,30}\bnotifications?\b/, 0.9],
  [/\bhow do i\b[^.?!]{0,40}\b(?:move|reschedule|edit|rename|delete|export|contact|support)\b/, 0.85],
  [/\bwhere (?:can|do) i (?:find|see|change|manage)\b/, 0.85],
];

/**
 * GOAL_QUESTION — status questions about the user's own goal or progress.
 * Classified by pattern regardless of context; the caller decides what a goal
 * question means when there is no goal in view.
 *
 * The topic nouns in the last rule (workout/gym/run/class) are runtime data
 * (the port); the structural frame, the product nouns (task, day, session,
 * streak, goal) and every other rule are core.
 */
const GOAL_QUESTION_CORE: Array<[RegExp, number]> = [
  [/\bhow (?:am|are|have) i (?:doing|going|progressing|been doing)\b/, 0.9],
  [/\bam i (?:on track|behind|ahead|on pace|falling behind|doing)\b/, 0.9],
  [/\bwhy am i\b[^.?!]{0,40}\b(?:behind|failing|struggling|losing|falling|not)\b/, 0.9],
  [/\bwhat(?:'s| is) my progress\b/, 0.85],
  [/\bwhen (?:is|are|do|does)\b[^.?!]{0,30}\bmy (?:next|upcoming|following)\b/, 0.9],
  [/\b(?:did|have|do) i\b[^.?!]{0,30}\b(?:complete|completed|finish|finished|miss|missed|hit|meet|met|do|done|skip|skipped)\b/, 0.85],
];

function goalQuestionRules(): Array<[RegExp, number]> {
  return portMemo(getRuntimeKnowledge(), 'goal-question-rules', () => {
    const alternation = getRuntimeKnowledge().getLexicon('missed-activity-noun').alternation ?? '(?!x)x';
    return [
      ...GOAL_QUESTION_CORE,
      [new RegExp(`\\bi (?:missed|skipped|forgot|failed|broke)\\b[^.?!]{0,40}\\b(?:my|the|a|${alternation})\\b`), 0.85],
    ];
  });
}

/** MODIFY_GOAL — explicit edit phrasing over something the user already has. */
const MODIFY_GOAL_RULES: Array<[RegExp, number]> = [
  [/\b(?:make|change|set|switch)\b[^.?!]{0,60}\binstead\b/, 0.9],
  [/\bchange (?:my|the|this|it)\b/, 0.9],
  [/\bmove (?:my|the|this)\b[^.?!]{0,40}\bto\b/, 0.9],
  [/\bmake (?:my|the|this|it)\b[^.?!]{0,40}\b(?:easier|harder|longer|shorter)\b/, 0.9],
  [/\b(?:set|switch) (?:my|the|this|it)\b[^.?!]{0,40}\bto\b/, 0.9],
  [/\b(?:remove|delete|drop|cancel) (?:my|the|this)\b/, 0.85],
  [/\bremove\b[^.?!]{0,30}\bfrom my\b/, 0.85],
  [/\badd\b[^.?!]{0,60}\bto my (?:goal|plan|schedule|routine)\b/, 0.9],
];

/**
 * GENERAL_QUESTION — greetings and advice questions. Advice ("should I…?")
 * is opinion about a choice, not a commitment, so it must never start an
 * interview; the create rules are blocked from question-shaped text anyway.
 */
const GENERAL_GREETING =
  /^(?:hi|hello|hey|yo|hiya|thanks|thank you|thx|ty|good (?:morning|afternoon|evening))(?: there)?[!,. !?]*$/;
// "Should I…?" and "help me decide whether I should…" are both advice about a
// choice — opinion, not commitment, and never a goal statement.
const GENERAL_ADVICE =
  /\bshould (?:i|we|one)\b[^.?!]*\?$|\bhelp me (?:decide|choose|figure out|pick)\b[^.?!]*\?$|\b(?:any |some )?advice\b[^.?!]*\?$/;

/**
 * R1 — first-person commitment. The strongest create signal: the speaker puts
 * themselves on record. Informational framings ("I want to know how streaks
 * work") are excluded — wanting information is not wanting a plan.
 */
const CREATE_INFORMATIONAL =
  /\bi (?:want|need|would like|'d like) (?:to )?(?:know|understand|find out|check|see|ask|hear|clarify)\b/;
// The activity-verb alternation in the last rule is runtime data (the port);
// the commitment frames are core. Exported for the parity tests.
export const CREATE_COMMITMENT: Array<[RegExp, number]> = [
  [/\bi (?:really )?(?:want|need|plan|intend|hope|decided|commit|committed|choose) to\b/, 0.98],
  [/\bi want\b/, 0.95],
  [/\bi need\b/, 0.95],
  [/\bi'?d like\b/, 0.95],
  [/\bi'?m (?:going|planning|trying|gonna) to\b/, 0.95],
  [/\bmy goal is\b/, 0.95],
  [/\bhelp me\b/, 0.95],
  [/\bi (?:will|'?ll)\b/, 0.9],
];

function createCommitmentRules(): Array<[RegExp, number]> {
  return portMemo(getRuntimeKnowledge(), 'create-commitment-rules', () => {
    const verbs = getRuntimeKnowledge().getLexicon('commitment-activity-verb').alternation ?? '(?!x)x';
    return [
      ...CREATE_COMMITMENT,
      [new RegExp(`\\bi can\\b[^.?!]{0,60}\\b(?:${verbs})\\b`), 0.9],
    ];
  });
}

/**
 * R2 — imperative + activity. Bare goal statements ("learn Java", "save for a
 * trip", "read 20 pages a day") are a leading activity verb with something
 * after it. The verb LIST is runtime data (the port); the imperative frame
 * (prefix, suffix forms, the required following word) is core.
 */
function createImperative(): RegExp {
  return portMemo(getRuntimeKnowledge(), 'create-imperative', () => {
    const verbs = getRuntimeKnowledge().getLexicon('create-verb').alternation ?? '(?!x)x';
    return new RegExp(`^(?:please\\s+)?(?:${verbs})(?:s|es|ed|ing)?\\s+\\S`);
  });
}

/**
 * R3 — goal management phrasing. Accepting, rejecting or pausing a schedule is
 * still goal-directed intent (the benchmark's authority-talk cases live here),
 * and refusing to plan around it would strand the user. The training/workout
 * nouns in the third rule are runtime data; the product nouns (sessions, plan,
 * schedule, goal) stay core.
 */
const CREATE_MANAGEMENT_CORE: Array<[RegExp, number]> = [
  [/\bkeep my (?:current )?(?:schedule|plan|streak|goal|routine|sessions?)\b/, 0.92],
  [/\b(?:reject|accept|approve|veto)\b[^.?!]{0,60}\b(?:increase|decrease|change|proposal|proposed|schedule|session|addition|reduction)\b/, 0.92],
  [/\b(?:progress|stay|reduce|advance|pause)\b[^.?!]{0,60}\b(?:recommendation|approve|approval)\b/, 0.92],
  [/\brecommend whether\b/, 0.85],
];

function createManagementRules(): Array<[RegExp, number]> {
  return portMemo(getRuntimeKnowledge(), 'create-management-rules', () => {
    const training = getRuntimeKnowledge().getLexicon('training-noun').patterns[0]?.entry.phrase ?? '(?!x)x';
    return [
      ...CREATE_MANAGEMENT_CORE.slice(0, 2),
      [new RegExp(`\\b(?:pause|resume|halt)\\b[^.?!]{0,30}\\b(?:${training}|sessions?|plan|schedule|goal)\\b`), 0.92],
      ...CREATE_MANAGEMENT_CORE.slice(2),
    ];
  });
}

/**
 * R4 — explicit goal-object creation. "create a goal that…", "before creating a
 * hydration habit": the object of the sentence says what the message is for,
 * wherever in the sentence it sits.
 */
const CREATE_OBJECT =
  /\bcreat(?:e|ing|es|ed)\b[^.?!]{0,40}\b(?:a|an|my|the)? ?(?:goal|plan|habit|routine)\b|\b(?:create|generate)\b[^.?!]{0,40}\b(?:a|an|my)? ?tasks?\b/;

/** First word, lower-cased, letters and apostrophes only. */
function firstWord(text: string): string {
  return (text.trim().split(/\s+/)[0] ?? '').replace(/[^a-z']/g, '');
}

const QUESTION_STARTERS = new Set([
  'who', 'what', 'when', 'where', 'which', 'why', 'how', 'can', 'could', 'do',
  'does', 'did', 'is', 'are', 'am', 'was', 'were', 'should', 'would', 'will',
  'shall', 'may', 'might',
]);

/**
 * Classify a message offline, deterministically, with high-confidence rules only.
 *
 * When no rule fires the result is UNKNOWN at confidence 0 — never a guess.
 * The benchmark runs this function and nothing else, so its verdicts must stay
 * reproducible without a provider.
 */
export function classifyIntentDeterministic(
  text: string,
  opts: { hasGoalContext?: boolean } = {},
): CopilotIntentResult {
  const lowered = text.trim().toLowerCase();
  if (lowered.length === 0) return UNKNOWN;

  for (const [pattern, confidence] of PRODUCT_HELP_RULES) {
    if (pattern.test(lowered)) return { intent: 'PRODUCT_HELP', confidence, method: 'deterministic' };
  }

  for (const [pattern, base] of goalQuestionRules()) {
    if (pattern.test(lowered)) {
      // A goal on screen makes a status question unambiguous; without one the
      // pattern alone still decides — the caller owns the context policy.
      return { intent: 'GOAL_QUESTION', confidence: opts.hasGoalContext ? 0.95 : base, method: 'deterministic' };
    }
  }

  for (const [pattern, confidence] of MODIFY_GOAL_RULES) {
    if (pattern.test(lowered)) return { intent: 'MODIFY_GOAL', confidence, method: 'deterministic' };
  }

  if (GENERAL_GREETING.test(lowered) || GENERAL_ADVICE.test(lowered)) {
    return { intent: 'GENERAL_QUESTION', confidence: 0.85, method: 'deterministic' };
  }

  // The create families require statement shape: nothing that opens like or
  // ends as a question may become a goal, however goal-flavoured its words.
  const endsWithQuestion = /\?\s*$/.test(text.trim());
  if (!endsWithQuestion && !QUESTION_STARTERS.has(firstWord(text))) {
    if (!CREATE_INFORMATIONAL.test(lowered)) {
      for (const [pattern, confidence] of createCommitmentRules()) {
        if (pattern.test(lowered)) return { intent: 'CREATE_GOAL', confidence, method: 'deterministic' };
      }
      if (createImperative().test(lowered)) {
        return { intent: 'CREATE_GOAL', confidence: 0.9, method: 'deterministic' };
      }
      for (const [pattern, confidence] of createManagementRules()) {
        if (pattern.test(lowered)) return { intent: 'CREATE_GOAL', confidence, method: 'deterministic' };
      }
      if (CREATE_OBJECT.test(lowered)) {
        return { intent: 'CREATE_GOAL', confidence: 0.95, method: 'deterministic' };
      }
    }
  }

  return UNKNOWN;
}

/**
 * Deterministic first, LLM only when the rules have no verdict.
 *
 * The fallback's output is validated strictly — unknown intent names, missing
 * or out-of-range confidence, a thrown error, a null, a timeout or a hang all
 * degrade to UNKNOWN. Failure is never mapped to CREATE_GOAL: an outage must
 * not be allowed to mint sessions.
 */
export async function classifyIntent(
  text: string,
  opts: { hasGoalContext?: boolean; llmTimeoutMs?: number } = {},
  llmFallback?: (text: string) => Promise<CopilotIntentResult | null>,
): Promise<CopilotIntentResult> {
  const deterministic = classifyIntentDeterministic(text, opts);
  if (deterministic.intent !== 'UNKNOWN' || !llmFallback) return deterministic;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      Promise.resolve(llmFallback(text)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), opts.llmTimeoutMs ?? 10_000);
      }),
    ]);
    const parsed = intentOutputSchema.safeParse(raw);
    if (!parsed.success) return UNKNOWN;
    if (parsed.data.confidence < INTENT_CONFIDENCE_THRESHOLD) {
      return { intent: 'UNKNOWN', confidence: parsed.data.confidence, method: 'llm' };
    }
    return { intent: parsed.data.intent, confidence: parsed.data.confidence, method: 'llm' };
  } catch {
    return UNKNOWN;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The production fallback: one small, strict JSON request. Any failure —
 * provider down, timeout, malformed reply — becomes null, which the caller
 * maps to UNKNOWN.
 */
export async function classifyIntentWithLlm(text: string): Promise<CopilotIntentResult | null> {
  try {
    const out = await chatJson(
      {
        purpose: 'INTENT_CLASSIFICATION',
        promptVersion: PROMPT_VERSIONS.intent,
        thinking: false,
        temperature: 0,
        maxTokens: 100,
        timeoutMs: 8_000,
        retryTransient: false,
        messages: [
          { role: 'system', content: intentSystemPrompt() },
          { role: 'user', content: text.slice(0, 400) },
        ],
      },
      intentOutputSchema,
    );
    return { intent: out.intent, confidence: out.confidence, method: 'llm' };
  } catch {
    return null;
  }
}
