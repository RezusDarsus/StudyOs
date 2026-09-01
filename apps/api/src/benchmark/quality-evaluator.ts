import { scorePlanQuality, type PlanQualityBreakdown, type QualityPlan } from '../ai/plan-quality.js';
import { questionTopic, type QuestionTopic } from '../ai/interview-plan.js';
import { getRuntimeKnowledge, portMemo } from '../ai/runtime-knowledge.js';

export interface InterviewItem { question: { prompt: string; type?: string; options?: string[] } }

export interface InterviewQuality {
  score: number;
  issues: string[];
  expectedQuestions: { min: number; max: number };
}

export interface UsefulnessEvaluation extends PlanQualityBreakdown {
  interviewEfficiency: number;
  usefulnessScore: number;
  interview: InterviewQuality;
}

export interface StructuralQuality {
  score: number;
  criticalFailure: boolean;
  issues: string[];
}

export function scoreStructuralQuality(plan: QualityPlan, today = '2026-08-25'): StructuralQuality {
  const issues: string[] = [];
  if (!plan.title?.trim()) issues.push('Goal title is missing');
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) issues.push('Plan has no executable tasks');
  const titles = new Set<string>();
  for (const task of plan.tasks ?? []) {
    const title = task.title?.trim().toLowerCase();
    if (!title) issues.push('Task title is missing');
    else if (titles.has(title)) issues.push(`Duplicate task: ${task.title}`);
    else titles.add(title);
    const config = task.recurrenceConfig ?? {};
    if (task.recurrenceType === 'SPECIFIC_WEEKDAYS'
      && (!config.weekdays?.length || config.weekdays.some((day) => day < 0 || day > 6))) {
      issues.push(`${task.title} has invalid weekdays`);
    }
    if (task.recurrenceType === 'TIMES_PER_WEEK'
      && (!config.timesPerWeek || config.timesPerWeek < 1 || config.timesPerWeek > 7)) {
      issues.push(`${task.title} has invalid weekly frequency`);
    }
    if (task.recurrenceType === 'EVERY_X_DAYS'
      && (!config.intervalDays || config.intervalDays < 1 || config.intervalDays > 90)) {
      issues.push(`${task.title} has an invalid interval`);
    }
    if (task.estimatedMinutes !== null && task.estimatedMinutes !== undefined
      && (task.estimatedMinutes < 1 || task.estimatedMinutes > 600)) {
      issues.push(`${task.title} has an impossible duration`);
    }
  }
  if (plan.deadline && plan.deadline <= today) issues.push('Deadline is not in the future');
  const score = Math.max(0, 100 - issues.length * 20);
  return { score: issues.length ? Math.min(score, 50) : score, criticalFailure: issues.length > 0, issues };
}

/** Benchmark-scoring topics read from the runtime lexicon (offline scoring
 *  policy, not core readiness). */
const statedTopicsForScoring = (goalText: string): QuestionTopic[] => {
  const patterns = portMemo(getRuntimeKnowledge(), 'stated-topic-patterns', () =>
    getRuntimeKnowledge()
      .getLexicon('stated-topic-pattern')
      .patterns.filter(({ entry }) => entry.role)
      .map(({ entry, regex }) => ({ topic: entry.role as QuestionTopic, pattern: regex })),
  );
  const text = goalText.toLowerCase();
  return patterns.filter(({ pattern }) => pattern.test(text)).map(({ topic }) => topic);
};

export const planningSufficiencyForScoring = (goalText: string) => {
  const known = statedTopicsForScoring(goalText);
  const enough = known.length >= 2;
  return {
    enough,
    known,
    questionRange: enough ? { min: 0, max: 0 } : { min: 1, max: 2 },
  };
};
export function scoreInterviewQuality(goalText: string, interview: InterviewItem[] = []): InterviewQuality {
  const initial = planningSufficiencyForScoring(goalText);
  const issues: string[] = [];
  let score: number;
  if (initial.enough) {
    score = interview.length === 0 ? 10 : interview.length === 1 ? 4 : 0;
    if (interview.length) issues.push('A detailed goal was interviewed unnecessarily');
  } else {
    score = interview.length === 1 ? 10 : interview.length === 2 ? 8 : interview.length === 0 ? 0 : 3;
    if (interview.length === 0) issues.push('An ambiguous goal generated without one useful clarification');
    if (interview.length > 2) issues.push('The interview became a questionnaire');
  }

  const seen = new Set<string>(initial.known);
  for (const item of interview) {
    const topic = questionTopic(
      item.question.prompt,
      item.question.type as Parameters<typeof questionTopic>[1],
      item.question.options,
    );
    if (topic === 'OTHER' || topic === 'MOTIVATION') {
      score -= 2;
      issues.push(`Question may not materially change the plan: ${item.question.prompt}`);
    } else if (seen.has(topic)) {
      score -= 3;
      issues.push(`Question repeats an already-settled variable: ${topic}`);
    }
    seen.add(topic);
  }
  return { score: Math.max(0, score), issues, expectedQuestions: initial.questionRange };
}

export function evaluateUsefulness(
  goalText: string,
  plan: QualityPlan,
  interview: InterviewItem[] = [],
  answerText = '',
): UsefulnessEvaluation {
  const planQuality = scorePlanQuality(goalText, plan, answerText);
  const interviewQuality = scoreInterviewQuality(goalText, interview);
  return {
    ...planQuality,
    interviewEfficiency: interviewQuality.score,
    usefulnessScore: planQuality.planScore + interviewQuality.score,
    interview: interviewQuality,
  };
}

export function passesQualityGates(input: {
  criticalFailure: boolean;
  structuralScore: number;
  usefulnessScore: number;
}): boolean {
  return !input.criticalFailure && input.structuralScore >= 90 && input.usefulnessScore >= 75;
}
