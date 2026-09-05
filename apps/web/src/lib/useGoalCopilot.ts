import { useCallback, useEffect, useRef, useState } from 'react';
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
  const inFlight = useRef(false);
  const epoch = useRef(0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  // Keep the same operation ID after an ambiguous network failure. The server
  // can then replay the committed result without recording a second event.
  const consumptionOperations = useRef(new Map<string, { id: string; pending: boolean; done: boolean }>());
  // Durable state the user created through the action cards. Server events are
  // the source of truth; this set only keeps the UI honest between renders.
  const [consumedIdentities, setConsumedIdentities] = useState<Set<string>>(new Set());

  useEffect(() => {
    epoch.current++;
    inFlight.current = false;
    consumptionOperations.current.clear();
    setEntries([]);
    setConsumedIdentities(new Set());
    setBusy(false);
    return () => { epoch.current++; };
  }, [goalId]);

  const ask = useCallback(
    async (text: string) => {
      // A slash is a normal character here: "am I hitting 5/7 days?" is a fair
      // question, so anything non-empty is sent through verbatim.
      if (!canSubmit(text) || inFlight.current) return null;
      inFlight.current = true;
      const operation = epoch.current;
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
        if (operation !== epoch.current) return null;
        setEntries((prev) => [...prev, { question, answer }]);
        return answer;
      } catch (err) {
        if (operation === epoch.current) errorHandler.current(err instanceof ApiError ? err.message : 'The Copilot could not answer');
        return null;
      } finally {
        if (operation === epoch.current) {
          inFlight.current = false;
          setBusy(false);
        }
      }
    },
    [goalId, entries],
  );

  /**
   * Mark one recommended item as consumed (Stage 2). The server derives the
   * durable event from the structured entity fields; the operationId makes a
   * network retry a no-op rather than a second fact.
   */
  const markConsumed = useCallback(
    async (item: StructuredRecommendation): Promise<RecommendationActionResult | null> => {
      const identity = recommendationIdentity(item);
      const operation = epoch.current;
      const claim = consumptionOperations.current.get(identity) ?? { id: newOperationId(), pending: false, done: false };
      if (claim.pending || claim.done) return null;
      claim.pending = true;
      consumptionOperations.current.set(identity, claim);
      try {
        const result = await api.post<RecommendationActionResult>('/recommendations/events', {
          action: 'mark_consumed',
          operationId: claim.id,
          entityType: item.entityType,
          displayName: item.displayName,
          attribution: item.attribution ?? null,
          goalId,
        });
        if (operation !== epoch.current) return null;
        claim.done = true;
        setConsumedIdentities((prev) => new Set(prev).add(identity));
        return result;
      } catch (err) {
        if (operation === epoch.current) errorHandler.current(err instanceof ApiError ? err.message : 'The Copilot could not save that');
        return null;
      } finally {
        claim.pending = false;
      }
    },
    [goalId],
  );

  const clear = useCallback(() => {
    epoch.current++;
    inFlight.current = false;
    setBusy(false);
    setEntries([]);
    // Clearing chat does not undo durable "used" actions or their retry IDs.
  }, []);

  return { entries, latest: entries[entries.length - 1] ?? null, busy, ask, markConsumed, consumedIdentities, clear };
}
