import { useCallback, useState } from 'react';
import { ApiError, api } from './api';
import { canSubmit } from './slash';
import type { GoalCopilotAnswer } from './types';

export interface GoalCopilotEntry {
  question: string;
  answer: GoalCopilotAnswer;
}

/** Things people actually ask, offered as one-tap starters. */
export const GOAL_QUICK_ASKS = [
  'How am I doing?',
  'Make this easier',
  'Why am I falling behind?',
  'Give me one more rest day',
];

/**
 * Asking the Copilot about a goal that already exists.
 *
 * It explains and *proposes*. Nothing is applied automatically: changing a live
 * schedule affects future occurrences and the user's streak, so any change stays
 * a separate, explicit decision. Past history is never rewritten.
 *
 * Shared by the goal detail dialog and the floating widget — one implementation,
 * two surfaces.
 */
export function useGoalCopilot(goalId: string, onError: (message: string) => void) {
  const [entries, setEntries] = useState<GoalCopilotEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(
    async (text: string) => {
      // A slash is a normal character here: "am I hitting 5/7 days?" is a fair
      // question, so anything non-empty is sent through verbatim.
      if (!canSubmit(text) || busy) return null;
      const question = text.trim();
      setBusy(true);
      try {
        const answer = await api.post<GoalCopilotAnswer>(`/goals/${goalId}/copilot`, {
          message: question,
          history: entries.slice(-4).flatMap((entry) => [
            { role: 'user', content: entry.question },
            { role: 'assistant', content: entry.answer.analysis.explanation },
          ]),
        });
        setEntries((prev) => [...prev, { question, answer }]);
        return answer;
      } catch (err) {
        onError(err instanceof ApiError ? err.message : 'The Copilot could not answer');
        return null;
      } finally {
        setBusy(false);
      }
    },
    // `onError` is a fresh closure each render in both callers; excluding it
    // keeps `ask` stable, and it is only ever read at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [goalId, busy, entries],
  );

  const clear = useCallback(() => setEntries([]), []);

  return { entries, latest: entries[entries.length - 1] ?? null, busy, ask, clear };
}
