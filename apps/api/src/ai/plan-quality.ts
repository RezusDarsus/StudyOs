import type { RecurrenceType } from '../domain/enums.js';

export interface QualityTask {
  title: string;
  description?: string;
  reason?: string;
  recurrenceType: RecurrenceType;
  recurrenceConfig?: { weekdays?: number[]; timesPerWeek?: number; intervalDays?: number };
  estimatedMinutes?: number | null;
}

export interface QualityPlan {
  title: string;
  description?: string;
  rationale?: string;
  category?: string;
  deadline?: string | null;
  tasks: QualityTask[];
}

export interface PlanQualityBreakdown {
  goalRelevance: number;
  taskSpecificity: number;
  planCompleteness: number;
  scheduleRealism: number;
  taskDiversity: number;
  personalization: number;
  /** Plan-only score. Interview efficiency contributes the remaining 10 points in benchmarks. */
  planScore: number;
  issues: string[];
}

const STOP = new Set([
  'a', 'an', 'and', 'be', 'for', 'get', 'i', 'in', 'more', 'my', 'of', 'on', 'the',
  'to', 'want', 'with', 'your', 'you', 'goal', 'plan', 'task', 'step', 'first', 'start',
  'begin', 'work', 'progress', 'concrete', 'journey',
]);

const FAMILIES: string[][] = [
  ['fit', 'fitter', 'fitness', 'exercise', 'workout', 'gym', 'walk', 'run', 'strength', 'cardio', 'swim'],
  ['weight', 'diet', 'nutrition', 'calorie', 'meal', 'exercise'],
  ['java', 'code', 'coding', 'program', 'programming', 'developer'],
  ['read', 'reading', 'book', 'books', 'page', 'chapter'],
  ['save', 'saving', 'money', 'budget', 'expense', 'transfer', 'deposit'],
  ['sleep', 'bed', 'bedtime', 'wake', 'night', 'wind'],
  ['exam', 'study', 'revise', 'revision', 'practice', 'quiz'],
  ['marathon', 'run', 'running', 'mileage', 'race'],
  ['chess', 'tactic', 'opening', 'endgame', 'game'],
  ['english', 'language', 'vocabulary', 'speaking', 'listening'],
  ['productive', 'productivity', 'focus', 'planning', 'prioritize'],
  ['water', 'drink', 'hydration', 'hydrate'],
  ['portfolio', 'project', 'case', 'publish', 'showcase'],
  ['job', 'career', 'resume', 'application', 'interview', 'network'],
];

const ACTIONS = new Set([
  'apply', 'build', 'call', 'complete', 'cook', 'create', 'deliver', 'deposit', 'design',
  'drink', 'exercise', 'implement', 'learn', 'log', 'measure', 'plan', 'practice',
  'prepare', 'publish', 'read', 'review', 'revise', 'run', 'save', 'schedule', 'sleep',
  'study', 'swim', 'track', 'train', 'transfer', 'walk', 'write',
]);

const stem = (word: string) => word
  .replace(/ies$/, 'y')
  .replace(/ing$/, '')
  .replace(/ed$/, '')
  .replace(/s$/, '');

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem);
}

function meaningful(text: string): Set<string> {
  return new Set(tokens(text).filter((token) => token.length > 2 && !STOP.has(token)));
}

function familyFor(text: string): Set<string> | null {
  const found = new Set(tokens(text));
  const family = FAMILIES.find((words) => words.some((word) => found.has(stem(word))));
  return family ? new Set(family.map(stem)) : null;
}

function weekly(task: QualityTask): number {
  if (task.recurrenceType === 'EVERY_DAY') return 7;
  if (task.recurrenceType === 'SPECIFIC_WEEKDAYS') return task.recurrenceConfig?.weekdays?.length ?? 0;
  if (task.recurrenceType === 'TIMES_PER_WEEK') return task.recurrenceConfig?.timesPerWeek ?? 0;
  if (task.recurrenceType === 'EVERY_X_DAYS') return 7 / (task.recurrenceConfig?.intervalDays ?? 1);
  return 0;
}

function actionable(task: QualityTask, goalFamily: Set<string> | null): boolean {
  const title = meaningful(task.title);
  if (!title.size) return false;
  if ([...title].some((token) => ACTIONS.has(token))) return true;
  if (goalFamily && [...title].some((token) => goalFamily.has(token))) return true;
  return meaningful(`${task.title} ${task.description ?? ''}`).size >= 3;
}

/** Generic, goal-agnostic usefulness scoring shared by production validation and benchmarks. */
export function scorePlanQuality(
  goalText: string,
  plan: QualityPlan,
  answerText = '',
): PlanQualityBreakdown {
  const issues: string[] = [];
  const taskText = plan.tasks.map((task) => `${task.title} ${task.description ?? ''}`).join(' ');
  const goalTokens = meaningful(goalText);
  const planTokens = meaningful(taskText);
  const goalFamily = familyFor(goalText);
  const overlap = [...goalTokens].filter((token) => planTokens.has(token)).length;
  const familyOverlap = goalFamily ? [...goalFamily].some((token) => planTokens.has(token)) : false;
  const goalRelevance = !goalTokens.size || overlap > 0 || familyOverlap ? 20 : 4;
  if (goalRelevance < 20) issues.push('Tasks do not clearly pursue the stated goal');

  const actionableCount = plan.tasks.filter((task) => actionable(task, goalFamily)).length;
  const describedCount = plan.tasks.filter((task) => meaningful(task.description ?? '').size >= 2).length;
  const specificityRatio = plan.tasks.length
    ? (actionableCount * 0.7 + describedCount * 0.3) / plan.tasks.length
    : 0;
  const taskSpecificity = Math.round(20 * specificityRatio);
  if (taskSpecificity < 14) issues.push('Tasks are vague or not directly actionable');

  let planCompleteness = 0;
  if (plan.tasks.length >= 2 && actionableCount >= 2) planCompleteness = 15;
  else if (plan.tasks.length === 1 && actionableCount === 1 && weekly(plan.tasks[0]) > 0) planCompleteness = 12;
  else if (plan.tasks.length === 1 && actionableCount === 1) planCompleteness = 8;
  if (planCompleteness < 10) issues.push('The plan is too thin to be useful');

  const validSchedules = plan.tasks.filter((task) => {
    const minutes = task.estimatedMinutes ?? 15;
    const frequency = weekly(task);
    if (minutes < 5 || minutes > 180) return false;
    if (task.recurrenceType === 'SPECIFIC_WEEKDAYS' && frequency < 1) return false;
    if (task.recurrenceType === 'TIMES_PER_WEEK' && (frequency < 1 || frequency > 7)) return false;
    return true;
  }).length;
  const weeklyMinutes = plan.tasks.reduce(
    (sum, task) => sum + (task.estimatedMinutes ?? 15) * weekly(task),
    0,
  );
  const scheduleRealism = plan.tasks.length && validSchedules === plan.tasks.length && weeklyMinutes <= 14 * 60
    ? 15
    : plan.tasks.length && validSchedules === plan.tasks.length && weeklyMinutes <= 21 * 60
      ? 10
      : 3;
  if (scheduleRealism < 10) issues.push('The executable schedule is incomplete or unrealistic');

  const signatures = new Set(plan.tasks.map((task) => [...meaningful(task.title)].sort().join('|')));
  const taskDiversity = plan.tasks.length >= 2
    ? Math.round(10 * signatures.size / plan.tasks.length)
    : actionableCount === 1 ? 6 : 0;
  if (plan.tasks.length > 1 && taskDiversity < 7) issues.push('Tasks repeat rather than complement each other');

  const personalText = `${plan.rationale ?? ''} ${plan.tasks.map((task) => task.reason ?? '').join(' ')}`;
  const answerTokens = meaningful(answerText);
  const personalTokens = meaningful(personalText);
  const answerOverlap = [...answerTokens].some((token) => personalTokens.has(token));
  const addressesUser = /\byou(?:r|'re)?\b/i.test(personalText);
  const personalization = addressesUser
    ? (!answerTokens.size || answerOverlap ? 10 : 7)
    : answerOverlap ? 5 : 2;
  if (personalization < 7) issues.push('The plan does not reflect the person’s stated information');

  const planScore = goalRelevance + taskSpecificity + planCompleteness
    + scheduleRealism + taskDiversity + personalization;
  return {
    goalRelevance,
    taskSpecificity,
    planCompleteness,
    scheduleRealism,
    taskDiversity,
    personalization,
    planScore,
    issues,
  };
}
