import { useCallback, useState } from 'react';
import { ApiError, api } from './api';
import { canSubmit } from './slash';
import { newOperationId } from './operation-id';
import type { GoalCopilotAnswer, RecommendationActionResult, StructuredRecommendation } from './types';

export interface GoalCopilotEntry {
  question: string;
  answer: GoalCopilotAnswer;
}

/** Mirror of the server's Stage 1 identity: casefolded name + attribution. */
export function recommendationIdentity(
  item: Pick<StructuredRecommendation, 'displayName' | 'attribution'>,
): string {
  return `${item.displayName.trim().toLocaleLowerCase()}|${(item.attribution ?? '').trim().toLocaleLowerCase()}`;
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
  // Durable state the user created through the action cards. Server events are
  // the source of truth; this set only keeps the UI honest between renders.
  const [consumedIdentities, setConsumedIdentities] = useState<Set<string>>(new Set());

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
            {
              role: 'assistant',
              content: entry.answer.analysis.explanation,
              // Stage 1: the structured recommendations come back with the turn,
              // so "another one" can dedup from data instead of prose. Optional —
              // legacy responses simply leave it out.
              recommendations: entry.answer.analysis.recommendations,
            },
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

  /**
   * Mark one recommended item as consumed (Stage 2). The server derives the
   * durable event from the structured entity fields; the operationId makes a
   * network retry a no-op rather than a second fact.
   */
  const markConsumed = useCallback(
    async (item: StructuredRecommendation): Promise<RecommendationActionResult | null> => {
      const identity = recommendationIdentity(item);
      try {
        const result = await api.post<RecommendationActionResult>('/recommendations/events', {
          action: 'mark_consumed',
          operationId: newOperationId(),
          entityType: item.entityType,
          displayName: item.displayName,
          attribution: item.attribution ?? null,
          goalId,
        });
        setConsumedIdentities((prev) => new Set(prev).add(identity));
        return result;
      } catch (err) {
        onError(err instanceof ApiError ? err.message : 'The Copilot could not save that');
        return null;
      }
    },
    // `onError` is a fresh closure each render; see `ask` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [goalId],
  );

  const clear = useCallback(() => {
    setEntries([]);
    setConsumedIdentities(new Set());
  }, []);

  return { entries, latest: entries[entries.length - 1] ?? null, busy, ask, markConsumed, consumedIdentities, clear };
}
