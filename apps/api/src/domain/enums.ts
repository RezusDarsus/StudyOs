// Status-like values are stored as Strings rather than native enums, so these
// constants plus their guards are the single place the vocabulary is defined. (The
// choice dates from SQLite, which had no enums; see prisma/schema.prisma for why it
// outlived the move to PostgreSQL.)

export const GOAL_VISIBILITY = ['PRIVATE', 'PUBLIC'] as const;
export type GoalVisibility = (typeof GOAL_VISIBILITY)[number];

export const GOAL_STATUS = ['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;
export type GoalStatus = (typeof GOAL_STATUS)[number];

export const GOAL_CATEGORY = [
  'FITNESS',
  'HEALTH',
  'STUDY',
  'READING',
  'CAREER',
  'FINANCE',
  'PRODUCTIVITY',
  'PERSONAL',
  'OTHER',
] as const;
export type GoalCategory = (typeof GOAL_CATEGORY)[number];

export const TARGET_TYPE = ['HABIT', 'QUANTITY', 'WEEKLY_TARGET', 'DEADLINE'] as const;
export type TargetType = (typeof TARGET_TYPE)[number];

export const RECURRENCE_TYPE = [
  'ONCE',
  'EVERY_DAY',
  'SPECIFIC_WEEKDAYS',
  'TIMES_PER_WEEK',
  'EVERY_X_DAYS',
  'MONTHLY',
  'EVERY_X_MONTHS',
] as const;
export type RecurrenceType = (typeof RECURRENCE_TYPE)[number];

export const OCCURRENCE_STATUS = ['PENDING', 'COMPLETED', 'MISSED', 'SKIPPED'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUS)[number];

export const PARTICIPANT_ROLE = ['OWNER', 'MEMBER'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLE)[number];

export const PARTICIPANT_STATUS = ['ACTIVE', 'LEFT'] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUS)[number];

export const FRIENDSHIP_STATUS = ['PENDING', 'ACCEPTED', 'BLOCKED'] as const;
export type FriendshipStatus = (typeof FRIENDSHIP_STATUS)[number];

/** The relationship as seen from one specific user's point of view. */
export const FRIEND_STATE = [
  'NONE',
  'REQUEST_SENT',
  'REQUEST_RECEIVED',
  'FRIENDS',
  'BLOCKED',
] as const;
export type FriendState = (typeof FRIEND_STATE)[number];

export const INVITATION_STATUS = ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUS)[number];

export const NOTIFICATION_TYPE = [
  'REMINDER',
  'FRIEND',
  'PROGRESS',
  'LEADERBOARD',
  'ACHIEVEMENT',
  /** The 08:00 local "here is your day" summary. At most one per user per local day. */
  'MORNING_SUMMARY',
  /** The 20:30 local nudge, sent only when something is still outstanding. */
  'EVENING_INCOMPLETE',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPE)[number];

/**
 * The two types a scheduled job produces, and the only ones that carry a dedupe key.
 *
 * Separated from the list above because "may arrive at most once per local day" is a
 * property of these two specifically, not of notifications in general — three friend
 * requests in a day are three notifications.
 */
export const SCHEDULED_NOTIFICATION_TYPE = ['MORNING_SUMMARY', 'EVENING_INCOMPLETE'] as const;
export type ScheduledNotificationType = (typeof SCHEDULED_NOTIFICATION_TYPE)[number];

export const REWARD_REASON = [
  'TASK_COMPLETED',
  'TASK_UNDONE',
  'ACHIEVEMENT',
  'GOAL_COMPLETED',
] as const;
export type RewardReason = (typeof REWARD_REASON)[number];

export const LEADERBOARD_MODE = ['daily', 'average'] as const;
export type LeaderboardMode = (typeof LEADERBOARD_MODE)[number];

/** What a progression plan is counting up. Display only — the maths is the same. */
export const PROGRESSION_METRIC = [
  'MINUTES',
  'REPS',
  'DISTANCE_KM',
  'PAGES',
  'AMOUNT',
  'COUNT',
] as const;
export type ProgressionMetric = (typeof PROGRESSION_METRIC)[number];

/**
 * The only four things a progression review may conclude. ADVANCE and REDUCE
 * change the stage; STAY holds it; ASK_USER changes nothing at all and puts the
 * choice to the user. Nothing outside this list can move a plan.
 */
export const PROGRESSION_ACTION = ['ADVANCE', 'STAY', 'REDUCE', 'ASK_USER'] as const;
export type ProgressionAction = (typeof PROGRESSION_ACTION)[number];

export const PROGRESSION_STATUS = ['ACTIVE', 'COMPLETED', 'ABANDONED'] as const;
export type ProgressionStatus = (typeof PROGRESSION_STATUS)[number];

/** Who produced a decision. COPILOT is always a proposal, never an application. */
export const PROGRESSION_SOURCE = ['SYSTEM', 'USER', 'COPILOT'] as const;
export type ProgressionSource = (typeof PROGRESSION_SOURCE)[number];

/**
 * How a task felt on a given day. Three options on purpose: a five-point scale
 * invites people to split hairs between "3" and "4" when the only thing worth
 * knowing is which direction the task should move, if any.
 */
export const DIFFICULTY_RATING = ['TOO_EASY', 'JUST_RIGHT', 'TOO_HARD'] as const;
export type DifficultyRating = (typeof DIFFICULTY_RATING)[number];
