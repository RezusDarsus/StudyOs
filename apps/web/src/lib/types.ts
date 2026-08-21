export type GoalCategory =
  | 'FITNESS'
  | 'HEALTH'
  | 'STUDY'
  | 'READING'
  | 'CAREER'
  | 'FINANCE'
  | 'PRODUCTIVITY'
  | 'PERSONAL'
  | 'OTHER';

export type GoalVisibility = 'PRIVATE' | 'PUBLIC';
export type GoalStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';
export type TargetType = 'HABIT' | 'QUANTITY' | 'WEEKLY_TARGET' | 'DEADLINE';
export type RecurrenceType =
  | 'ONCE'
  | 'EVERY_DAY'
  | 'SPECIFIC_WEEKDAYS'
  | 'TIMES_PER_WEEK'
  | 'EVERY_X_DAYS';
export type OccurrenceStatus = 'PENDING' | 'COMPLETED' | 'MISSED' | 'SKIPPED';
export type FriendState = 'NONE' | 'REQUEST_SENT' | 'REQUEST_RECEIVED' | 'FRIENDS' | 'BLOCKED';

/**
 * What anyone may see about a user. Email, timezone and notification settings are
 * deliberately absent — the server only sends those to the account owner.
 */
export interface PublicProfile {
  id: string;
  name: string;
  avatarEmoji: string;
  bio: string;
  totalCoins: number;
  bestStreak: number;
  level: number;
  intoLevel: number;
  perLevel: number;
  percent: number;
}

/** The signed-in user's own record, which does include the private fields. */
export interface CurrentUser extends PublicProfile {
  email: string;
  timezone: string;
  notifications: {
    taskReminders: boolean;
    friendActivity: boolean;
    leaderboardUpdates: boolean;
    achievements: boolean;
    morningSummary: boolean;
    eveningCheck: boolean;
    /** HH:MM, read in the `timezone` above — never an offset. */
    morningTime: string;
    eveningTime: string;
  };
}

export interface GoalSummary {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  category: GoalCategory;
  visibility: GoalVisibility;
  status: GoalStatus;
  targetType: TargetType;
  targetValue: number | null;
  timezone: string;
  startDate: string;
  deadline: string | null;
  createdAt: string;
  participantCount: number;
  taskCount: number;
  progress: number;
  streak: number;
  todayCompleted: number;
  todayRequired: number;
}

export interface TaskDefinition {
  id: string;
  goalId: string;
  title: string;
  description: string;
  recurrenceType: RecurrenceType;
  recurrenceConfig: { weekdays?: number[]; timesPerWeek?: number; intervalDays?: number };
  reward: number;
  startDate: string;
  endDate: string | null;
  reminderTime: string | null;
  /** Present on the goal detail payload; null for a task with no ladder. */
  progression?: ProgressionSummary | null;
  /** How it has been feeling to me lately. Null when I have not rated it. */
  difficulty?: FeedbackSummary | null;
}

export interface DayScore {
  day: string;
  required: number;
  completed: number;
  percent: number | null;
}

export interface GoalDetailResponse {
  goal: GoalSummary & {
    owner: { id: string; name: string; avatarEmoji: string };
    isOwner: boolean;
    isParticipant: boolean;
    /** Only ever populated for the goal owner. */
    inviteCode: string | null;
  };
  tasks: TaskDefinition[];
  participants: Array<{
    id: string;
    userId: string;
    name: string;
    avatarEmoji: string;
    role: string;
    joinedOn: string;
    isMe: boolean;
  }>;
  me: {
    participantId: string;
    progress: { completedOccurrences: number; totalOccurrences: number; percent: number };
    streak: { current: number; best: number };
    today: DayScore;
    average: { percent: number | null; countedDays: number };
  } | null;
  history: DayScore[];
  today: string;
}

export interface TodayTask {
  occurrenceId: string;
  taskId: string;
  title: string;
  description: string;
  reward: number;
  reminderTime: string | null;
  status: OccurrenceStatus;
  dueDate: string;
  /**
   * The target *this day* was asked for, which is not always the plan's current
   * one — a day generated before a stage change keeps the number it was given.
   * Null when the task has no progression.
   */
  progression?: {
    target: number;
    unitLabel: string;
    metricType: ProgressionMetric;
    stageLabel: string;
  } | null;
  /** What I said about how this day felt, or null if I have not said. */
  feedback?: DifficultyRating | null;
}

export interface TodayResponse {
  groups: Array<{
    goalId: string;
    goalTitle: string;
    category: GoalCategory;
    visibility: GoalVisibility;
    streak: number;
    today: string;
    tasks: TodayTask[];
  }>;
  summary: {
    required: number;
    completed: number;
    percent: number | null;
    coinsToday: number;
    streak: number;
  };
}

export interface LeaderboardEntry {
  participantId: string;
  userId: string;
  name: string;
  avatarEmoji: string;
  percent: number | null;
  completed: number;
  required: number;
  currentStreak: number;
  totalCompleted: number;
  rank: number;
  isMe: boolean;
}

export interface Friend {
  id: string;
  name: string;
  avatarEmoji: string;
  level: number;
  totalCoins: number;
  currentStreak: number;
  sharedGoals: number;
}

export interface Challenge {
  id: string;
  title: string;
  description: string;
  category: GoalCategory;
  participantCount: number;
  taskCount: number;
  startDate: string;
  deadline: string | null;
  owner: { id: string; name: string; avatarEmoji: string };
  hasJoined: boolean;
}

export interface Notification {
  id: string;
  type:
    | 'REMINDER'
    | 'FRIEND'
    | 'PROGRESS'
    | 'LEADERBOARD'
    | 'ACHIEVEMENT'
    | 'MORNING_SUMMARY'
    | 'EVENING_INCOMPLETE';
  title: string;
  body: string;
  data: {
    goalId?: string;
    /** Present for a pending goal invitation; accepting it grants goal access. */
    invitationId?: string;
    achievementCode?: string;
    /** Set by the daily summaries, which are about the day rather than one goal. */
    goalIds?: string[];
    required?: number;
    completed?: number;
    remaining?: number;
    streak?: number;
  };
  /** The user's own calendar day for the scheduled summaries; null for everything else. */
  localDate: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface Achievement {
  code: string;
  title: string;
  description: string;
  icon: string;
  reward: number;
  unlockedAt: string | null;
}

export const CATEGORY_LABEL: Record<GoalCategory, string> = {
  FITNESS: 'Fitness',
  HEALTH: 'Health',
  STUDY: 'Study',
  READING: 'Reading',
  CAREER: 'Career',
  FINANCE: 'Finance',
  PRODUCTIVITY: 'Productivity',
  PERSONAL: 'Personal Growth',
  OTHER: 'Other',
};

export const CATEGORY_EMOJI: Record<GoalCategory, string> = {
  FITNESS: '🏋️',
  HEALTH: '💚',
  STUDY: '📚',
  READING: '📖',
  CAREER: '💼',
  FINANCE: '💰',
  PRODUCTIVITY: '⚡',
  PERSONAL: '🌱',
  OTHER: '🎯',
};

export const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Human wording for a recurrence rule, used wherever a task is described. */
export function describeRecurrence(task: Pick<TaskDefinition, 'recurrenceType' | 'recurrenceConfig'>) {
  switch (task.recurrenceType) {
    case 'ONCE':
      return 'Once';
    case 'EVERY_DAY':
      return 'Every day';
    case 'SPECIFIC_WEEKDAYS': {
      const days = task.recurrenceConfig.weekdays ?? [];
      if (days.length === 7) return 'Every day';
      return days.map((d) => WEEKDAY_LABEL[d]).join(', ');
    }
    case 'TIMES_PER_WEEK':
      return `${task.recurrenceConfig.timesPerWeek ?? 1}x per week`;
    case 'EVERY_X_DAYS': {
      const n = task.recurrenceConfig.intervalDays ?? 1;
      return n === 1 ? 'Every day' : `Every ${n} days`;
    }
    default:
      return '';
  }
}

// ------------------------------------------------------------ progression

export type ProgressionMetric = 'MINUTES' | 'REPS' | 'DISTANCE_KM' | 'PAGES' | 'AMOUNT' | 'COUNT';
export type ProgressionAction = 'ADVANCE' | 'STAY' | 'REDUCE' | 'ASK_USER';
export type ProgressionSource = 'SYSTEM' | 'USER' | 'COPILOT';
export type StageState = 'DONE' | 'CURRENT' | 'UPCOMING';

/** Enough to put a chip on a task row. */
export interface ProgressionSummary {
  id: string;
  taskId: string;
  metricType: ProgressionMetric;
  unitLabel: string;
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  currentStageIndex: number;
  stageCount: number;
  /** Already phrased, e.g. "Stage 2 of 4". */
  stageLabel: string;
  currentTarget: number | null;
}

export interface ProgressionStage {
  stageIndex: number;
  target: number;
  label: string;
  minDays: number;
  state: StageState;
}

export interface Progression extends ProgressionSummary {
  stageStartedOn: string;
  advanceThreshold: number;
  reduceThreshold: number;
  stages: ProgressionStage[];
}

/**
 * What a review concludes. Read-only — the server recomputes it before applying
 * anything, so nothing here can move a stage on its own.
 */
export interface ProgressionReview {
  action: ProgressionAction;
  fromStageIndex: number;
  toStageIndex: number;
  completionRate: number;
  reason: string;
  windowStart: string;
  windowEnd: string;
  eligibleCount: number;
  completedCount: number;
  applied: boolean;
  needsConfirmation: boolean;
}

/** One row of the audit trail. `applied: false` means it was only ever a proposal. */
export interface ProgressionDecision {
  id: string;
  action: ProgressionAction;
  fromStageIndex: number;
  toStageIndex: number;
  completionRate: number;
  completedCount: number;
  eligibleCount: number;
  windowStart: string;
  windowEnd: string;
  source: ProgressionSource;
  reason: string;
  applied: boolean;
  createdAt: string;
}

/** Fallback unit when the plan's own label is blank. */
const METRIC_UNIT: Record<ProgressionMetric, string> = {
  MINUTES: 'min',
  REPS: 'reps',
  DISTANCE_KM: 'km',
  PAGES: 'pages',
  AMOUNT: '',
  COUNT: '',
};

/** "20 min", "8 reps", or just "8" when the metric has no natural unit. */
export function formatTarget(
  target: number,
  plan: { unitLabel: string; metricType: ProgressionMetric },
) {
  const unit = plan.unitLabel || METRIC_UNIT[plan.metricType];
  return unit ? `${target} ${unit}` : String(target);
}

export const METRIC_LABEL: Record<ProgressionMetric, string> = {
  MINUTES: 'Minutes',
  REPS: 'Repetitions',
  DISTANCE_KM: 'Distance (km)',
  PAGES: 'Pages',
  AMOUNT: 'Amount',
  COUNT: 'Count',
};

// ------------------------------------------------------------ difficulty feedback

export type DifficultyRating = 'TOO_EASY' | 'JUST_RIGHT' | 'TOO_HARD';

/**
 * What the last three weeks of ratings add up to.
 *
 * `MIXED` is a real answer — the user has said different things on different days,
 * and the honest response is a question rather than a change. `UNKNOWN` means there
 * is not enough to go on yet.
 */
export type FeedbackSignal = DifficultyRating | 'MIXED' | 'UNKNOWN';

export interface FeedbackSummary {
  sampleSize: number;
  counts: Record<DifficultyRating, number>;
  latest: { day: string; rating: DifficultyRating } | null;
  dominant: DifficultyRating | null;
  signal: FeedbackSignal;
  windowStart: string;
  windowEnd: string;
}

/** The buttons, in the order they are offered. */
export const DIFFICULTY_OPTIONS: Array<{ rating: DifficultyRating; label: string }> = [
  { rating: 'TOO_EASY', label: 'Too easy' },
  { rating: 'JUST_RIGHT', label: 'Just right' },
  { rating: 'TOO_HARD', label: 'Too hard' },
];

/** How a given rating is read back once chosen. */
export const DIFFICULTY_LABEL: Record<DifficultyRating, string> = {
  TOO_EASY: 'Too easy',
  JUST_RIGHT: 'Just right',
  TOO_HARD: 'Too hard',
};

/**
 * The trend in a sentence, or null when there is nothing worth saying.
 *
 * Phrased as an observation, never as a plan. Deciding what to do about a task that
 * keeps feeling too hard is the user's call, and the wording should not imply the
 * app has already made it.
 */
export function describeDifficulty(summary: FeedbackSummary): string | null {
  const days = `${summary.sampleSize} ${summary.sampleSize === 1 ? 'day' : 'days'}`;
  switch (summary.signal) {
    case 'TOO_EASY':
      return `Felt too easy on most of the last ${days}`;
    case 'TOO_HARD':
      return `Felt too hard on most of the last ${days}`;
    case 'JUST_RIGHT':
      return `Feeling about right (${days} rated)`;
    case 'MIXED':
      return `Mixed so far — ${days} rated`;
    default:
      return null;
  }
}

// ------------------------------------------------------------ adjustment offers

export type AdjustmentKind = 'EASE_STAGE' | 'ADVANCE_STAGE' | 'START_LADDER';

/**
 * A change the app is willing to offer, worked out from how the user has rated their
 * own days. Every one of them points at the progression view, which is where the
 * change is actually made — so nothing here applies anything, and there is no
 * endpoint that would.
 */
export interface AdjustmentOffer {
  kind: AdjustmentKind;
  taskId: string;
  taskTitle: string;
  headline: string;
  because: string;
  suggestedAction: 'ADVANCE' | 'REDUCE' | null;
  /** True when the completion numbers point the other way. Must be said out loud. */
  needsOverride: boolean;
}

export interface AdjustmentOffersResponse {
  today: string;
  offers: AdjustmentOffer[];
  /** A ladder is shared by the whole goal, so only its owner can move one. */
  canApply: boolean;
}

// ---------------------------------------------------------------- Copilot

export type QuestionType =
  | 'FREE_TEXT'
  | 'SINGLE_SELECT'
  | 'MULTI_SELECT'
  | 'NUMBER'
  | 'DATE'
  | 'TIME'
  | 'DAYS_OF_WEEK';

export interface CopilotQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  options?: string[];
  allowCustomAnswer: boolean;
  optional: boolean;
  unit?: string | null;
}

export interface InterviewTurn {
  sessionId: string;
  status: string;
  assistantMessage: string;
  question: CopilotQuestion | null;
  questionCount: number;
  estimatedTotal: number;
  context: Record<string, unknown>;
  canGenerate: boolean;
}

/**
 * A build-up the Copilot proposed on a draft task: walk 15 min, then 20, then 30.
 *
 * Nothing here exists as a real {@link Progression} yet — it becomes one, through
 * the ordinary creation path, only if the user confirms the draft.
 */
export interface DraftProgression {
  metricType: ProgressionMetric;
  unitLabel: string;
  stages: Array<{ target: number; minDays: number }>;
}

export interface DraftTask {
  id: string;
  title: string;
  description: string;
  recurrenceType: RecurrenceType;
  recurrenceConfig: { weekdays?: number[]; timesPerWeek?: number; intervalDays?: number };
  estimatedMinutes: number | null;
  preferredTime: string | null;
  /** Why this task suits this person — quoted from the interview. */
  reason: string;
  /** Null for the ordinary task, which is most of them. */
  progression: DraftProgression | null;
}

export interface GoalDraft {
  id: string;
  sessionId: string | null;
  title: string;
  description: string;
  category: GoalCategory;
  targetType: TargetType;
  targetValue: number | null;
  deadline: string | null;
  visibility: GoalVisibility;
  rationale: string;
  status: 'GENERATED' | 'EDITING' | 'CONFIRMED' | 'DISCARDED';
  createdGoalId: string | null;
  tasks: DraftTask[];
}

export interface CopilotStatus {
  enabled: boolean;
  resumable: Array<{
    id: string;
    initialGoalText: string;
    status: string;
    questionCount: number;
    updatedAt: string;
  }>;
}

export interface ProgressSuggestion {
  summary: string;
  taskTitle?: string | null;
  proposedRecurrence?: {
    type: RecurrenceType;
    weekdays?: number[];
    timesPerWeek?: number;
    intervalDays?: number;
  } | null;
  proposedMinutes?: number | null;
  proposedProgressionAction?: 'ADVANCE' | 'STAY' | 'REDUCE' | null;
}

/**
 * A stage change the Copilot suggested and the server declined to make for it.
 *
 * `applied` is always false — the Copilot is not an authorised source, even when it
 * agrees with the review. Rendered as a suggestion with a button, never as news.
 */
export interface CopilotProgressionProposal {
  planId: string;
  taskTitle: string;
  requested: ProgressionAction;
  /** What the numbers say, computed server-side. */
  reviewAction: ProgressionAction;
  stageLabel: string;
  reason: string;
  applied: boolean;
}

export interface GoalCopilotAnswer {
  summary: {
    goalTitle: string;
    periodDays: number;
    eligibleTaskOccurrences: number;
    completedTaskOccurrences: number;
    completionRate: number;
    currentStreak: number;
    mostMissedTasks: Array<{ title: string; missRate: number; scheduled: number }>;
  };
  analysis: { explanation: string; suggestions: ProgressSuggestion[] };
  progressionProposals: CopilotProgressionProposal[];
}

/**
 * A proposed ladder in one line: "15 → 20 → 30 min".
 *
 * The unit goes on the last rung only. "15 min → 20 min → 30 min" says the same
 * thing three times and is harder to read at a glance.
 */
export function describeDraftLadder(progression: DraftProgression) {
  const targets = progression.stages.map((stage) => stage.target);
  if (targets.length === 0) return '';
  const last = formatTarget(targets[targets.length - 1], progression);
  return targets.length === 1 ? last : `${targets.slice(0, -1).join(' → ')} → ${last}`;
}

/** Human wording for a draft task's recurrence. */
export function describeDraftRecurrence(task: Pick<DraftTask, 'recurrenceType' | 'recurrenceConfig'>) {
  return describeRecurrence({
    recurrenceType: task.recurrenceType,
    recurrenceConfig: task.recurrenceConfig,
  });
}
