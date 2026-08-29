export type FixtureKind = 'vague' | 'detailed' | 'conflicting' | 'unrealistic';

export interface RealWorldFixture {
  /** Stable label for benchmark reports and for the no-special-casing guard. */
  name: string;
  /** The goal, in the user's own words. */
  goalText: string;
  /** Alias of goalText — existing benchmarks and tests read `prompt`. */
  prompt: string;
  intent: string[];
  questions: { min: number; max: number };
  /** What the readiness gate should make of it before any question is asked. */
  kind: FixtureKind;
}

interface FixtureSpec {
  name: string;
  goalText: string;
  intent: string[];
  questions: { min: number; max: number };
  kind: FixtureKind;
}

const SPECS: FixtureSpec[] = [
  { name: 'vague fitness goal', goalText: 'I want to get fitter', intent: ['fitness', 'exercise', 'walk', 'strength', 'cardio'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'vague weight loss', goalText: 'I want to lose weight', intent: ['weight', 'nutrition', 'exercise', 'meal'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'vague java goal', goalText: 'learn Java', intent: ['java', 'code', 'program'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'read more books', goalText: 'read more books', intent: ['read', 'book', 'page'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'save money', goalText: 'save money', intent: ['save', 'budget', 'transfer'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'fix sleep schedule', goalText: 'I want to fix my sleep schedule', intent: ['sleep', 'bedtime', 'wake'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'prepare for an exam', goalText: 'prepare for an exam', intent: ['study', 'exam', 'revise'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'run a marathon', goalText: 'run a marathon', intent: ['run', 'marathon', 'training'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'get better at chess', goalText: 'get better at chess', intent: ['chess', 'tactics', 'game'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'learn English speaking', goalText: 'I want to learn English speaking', intent: ['english', 'vocabulary', 'speaking'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'be more productive', goalText: 'be more productive', intent: ['focus', 'planning', 'prioritize'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'go to the gym', goalText: 'go to the gym', intent: ['gym', 'strength', 'workout'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'drink more water', goalText: 'drink more water', intent: ['water', 'drink', 'hydration'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'build my portfolio', goalText: 'build my portfolio', intent: ['portfolio', 'project', 'publish'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'find a job', goalText: 'find a job', intent: ['job', 'resume', 'application', 'interview'], questions: { min: 1, max: 2 }, kind: 'vague' },
  {
    name: '5 km in 8 weeks',
    goalText: 'I want to run 5 km without stopping in 8 weeks. I can train Monday, Wednesday and Saturday for 30–45 minutes.',
    intent: ['run', '5 km', 'training'],
    questions: { min: 0, max: 0 },
    kind: 'detailed',
  },
  // ---------------------------------------------------------- new scenarios
  { name: 'build muscle', goalText: 'I want to build muscle', intent: ['muscle', 'strength', 'gym'], questions: { min: 1, max: 2 }, kind: 'vague' },
  {
    name: '10K race in 12 weeks',
    goalText: 'I want to run a 10K race in 12 weeks. I can train Monday, Wednesday, Friday and Sunday for 45 minutes.',
    intent: ['run', '10K', 'race', 'training'],
    questions: { min: 0, max: 0 },
    kind: 'detailed',
  },
  {
    name: 'Java interview prep',
    goalText: 'I have a Java interview coming up and already know Core Java and OOP. I can study Monday, Wednesday, Friday and Saturday for 90 minutes.',
    intent: ['java', 'interview', 'study'],
    questions: { min: 0, max: 0 },
    kind: 'detailed',
  },
  {
    name: 'save $5,000 in 10 months',
    goalText: 'I want to save $5,000 in 10 months. I can deposit $500 on the 1st of each month, and I review my budget every Saturday.',
    intent: ['save', 'deposit', 'monthly cap'],
    questions: { min: 0, max: 0 },
    kind: 'detailed',
  },
  { name: 'university exam in 3 weeks', goalText: 'I have a university exam in 3 weeks and want to be prepared', intent: ['exam', 'study', 'university'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'build a SaaS side project', goalText: 'I want to build a SaaS side project', intent: ['saas', 'project', 'build'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'practice guitar', goalText: 'I want to practice guitar', intent: ['guitar', 'practice', 'music'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'reduce social media', goalText: 'I want to reduce my social media use', intent: ['social media', 'focus', 'habit'], questions: { min: 1, max: 2 }, kind: 'vague' },
  { name: 'write my thesis', goalText: 'I want to write my thesis', intent: ['thesis', 'writing', 'research'], questions: { min: 1, max: 2 }, kind: 'vague' },
  {
    name: 'conflicting weekly availability',
    goalText: 'I want to train three different days a week, but the only day I can train is Tuesday.',
    intent: ['training', 'conflict', 'availability'],
    questions: { min: 1, max: 2 },
    kind: 'conflicting',
  },
  {
    name: 'unrealistic Japanese timeline',
    goalText: 'I want to be fluent in Japanese in 7 days',
    intent: ['japanese', 'fluency', 'timeline'],
    questions: { min: 1, max: 2 },
    kind: 'unrealistic',
  },
];

export const REAL_WORLD_FIXTURES: RealWorldFixture[] = SPECS.map((spec) => ({
  ...spec,
  prompt: spec.goalText,
}));
