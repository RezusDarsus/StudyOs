export interface RealWorldFixture {
  prompt: string;
  intent: string[];
  questions: { min: number; max: number };
}

export const REAL_WORLD_FIXTURES: RealWorldFixture[] = [
  { prompt: 'I want to get fitter', intent: ['fitness', 'exercise', 'walk', 'strength', 'cardio'], questions: { min: 1, max: 2 } },
  { prompt: 'I want to lose weight', intent: ['weight', 'nutrition', 'exercise', 'meal'], questions: { min: 1, max: 2 } },
  { prompt: 'learn Java', intent: ['java', 'code', 'program'], questions: { min: 1, max: 2 } },
  { prompt: 'read more books', intent: ['read', 'book', 'page'], questions: { min: 1, max: 2 } },
  { prompt: 'save money', intent: ['save', 'budget', 'transfer'], questions: { min: 1, max: 2 } },
  { prompt: 'sleep better', intent: ['sleep', 'bedtime', 'wake'], questions: { min: 1, max: 2 } },
  { prompt: 'prepare for an exam', intent: ['study', 'exam', 'revise'], questions: { min: 1, max: 2 } },
  { prompt: 'run a marathon', intent: ['run', 'marathon', 'training'], questions: { min: 1, max: 2 } },
  { prompt: 'get better at chess', intent: ['chess', 'tactics', 'game'], questions: { min: 1, max: 2 } },
  { prompt: 'learn English', intent: ['english', 'vocabulary', 'speaking'], questions: { min: 1, max: 2 } },
  { prompt: 'be more productive', intent: ['focus', 'planning', 'prioritize'], questions: { min: 1, max: 2 } },
  { prompt: 'go to the gym', intent: ['gym', 'strength', 'workout'], questions: { min: 1, max: 2 } },
  { prompt: 'drink more water', intent: ['water', 'drink', 'hydration'], questions: { min: 1, max: 2 } },
  { prompt: 'build my portfolio', intent: ['portfolio', 'project', 'publish'], questions: { min: 1, max: 2 } },
  { prompt: 'find a job', intent: ['job', 'resume', 'application', 'interview'], questions: { min: 1, max: 2 } },
  {
    prompt: 'I want to run 5 km without stopping in 8 weeks. I can train Monday, Wednesday and Saturday for 30–45 minutes.',
    intent: ['run', '5 km', 'training'],
    questions: { min: 0, max: 0 },
  },
];
