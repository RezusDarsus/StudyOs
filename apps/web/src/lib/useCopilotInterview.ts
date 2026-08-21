import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import type { CopilotQuestion, GoalDraft, InterviewTurn } from './types';

export interface Bubble {
  role: 'assistant' | 'user';
  text: string;
}

/** What the interview is currently waiting on. */
export type InterviewPhase = 'OPENING' | 'RESUMING' | 'INTERVIEWING' | 'READY' | 'DONE';

export type AnswerHandler = (value: unknown, label: string, skipped?: boolean) => void;

interface Options {
  /** Rebuild a session the user walked away from. */
  resumeSessionId?: string;
  /** Surface a failure — both callers show a toast. */
  onError(message: string): void;
  /** The session already produced a draft; the caller decides where to send them. */
  onResumedDraft?(draftId: string): void;
  /** The session could not be rebuilt at all. */
  onResumeFailed?(): void;
}

interface SessionSnapshot {
  sessionId: string;
  status: string;
  initialGoalText: string;
  questionCount: number;
  canGenerate: boolean;
  context: Record<string, unknown>;
  draftId: string | null;
  messages: Array<{ role: string; content: string }>;
  question: CopilotQuestion | null;
}

function messageOf(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback;
}

/**
 * The Copilot interview, independent of how it is drawn.
 *
 * The full-page builder and the floating widget both call this. The widget is a
 * different surface onto the same conversation — not a second AI implementation —
 * so a session started in one can be finished in the other.
 */
export function useCopilotInterview({
  resumeSessionId,
  onError,
  onResumedDraft,
  onResumeFailed,
}: Options) {
  const [phase, setPhase] = useState<InterviewPhase>(resumeSessionId ? 'RESUMING' : 'OPENING');
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [turn, setTurn] = useState<InterviewTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<GoalDraft | null>(null);

  // Latest values for the async callbacks below. Without these, a request that
  // started a render ago would answer using a stale session or question id.
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // The callers pass fresh closures every render; a ref keeps the resume effect
  // from re-firing and replaying the whole conversation.
  const handlers = useRef({ onError, onResumedDraft, onResumeFailed });
  handlers.current = { onError, onResumedDraft, onResumeFailed };

  const applyTurn = useCallback((next: InterviewTurn) => {
    setTurn(next);
    setPhase(next.canGenerate && !next.question ? 'READY' : 'INTERVIEWING');
    if (next.assistantMessage) {
      setBubbles((prev) => [...prev, { role: 'assistant', text: next.assistantMessage }]);
    }
  }, []);

  const reset = useCallback(() => {
    setPhase('OPENING');
    setBubbles([]);
    setTurn(null);
    setDraft(null);
    setBusy(false);
    setGenerating(false);
  }, []);

  useEffect(() => {
    if (!resumeSessionId) return;
    let cancelled = false;
    setPhase('RESUMING');

    api
      .get<SessionSnapshot>(`/copilot/goal-sessions/${resumeSessionId}`)
      .then((data) => {
        if (cancelled) return;
        if (data.draftId) {
          handlers.current.onResumedDraft?.(data.draftId);
          return;
        }
        setBubbles(
          data.messages.map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            text: m.content,
          })),
        );
        setTurn({
          sessionId: data.sessionId,
          status: data.status,
          assistantMessage: '',
          question: data.question,
          questionCount: data.questionCount,
          estimatedTotal: Math.max(data.questionCount + 1, 5),
          context: data.context,
          canGenerate: data.canGenerate,
        });
        setPhase(data.canGenerate && !data.question ? 'READY' : 'INTERVIEWING');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        handlers.current.onError(messageOf(err, 'Could not reopen that conversation'));
        handlers.current.onResumeFailed?.();
      });

    return () => {
      cancelled = true;
    };
  }, [resumeSessionId]);

  const begin = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (text.length < 3) return;
      setBusy(true);
      setBubbles([{ role: 'user', text }]);
      try {
        const next = await api.post<InterviewTurn>('/copilot/goal-sessions', { goal: text });
        applyTurn(next);
      } catch (err) {
        setBubbles([]);
        setPhase('OPENING');
        handlers.current.onError(messageOf(err, 'Could not reach the Copilot'));
      } finally {
        setBusy(false);
      }
    },
    [applyTurn],
  );

  const answer: AnswerHandler = useCallback(
    async (value, label, skipped = false) => {
      const current = turnRef.current;
      if (!current?.question || busyRef.current) return;
      const questionId = current.question.id;

      setBusy(true);
      setBubbles((prev) => [...prev, { role: 'user', text: label }]);
      setTurn({ ...current, question: null });

      try {
        const next = await api.post<InterviewTurn>(
          `/copilot/goal-sessions/${current.sessionId}/answers`,
          { questionId, answer: value, skipped },
        );
        applyTurn(next);
      } catch (err) {
        // The answer is kept server-side; let them retry rather than lose the thread.
        handlers.current.onError(messageOf(err, 'Something went wrong'));
        setTurn(current);
        setBubbles((prev) => prev.slice(0, -1));
      } finally {
        setBusy(false);
      }
    },
    [applyTurn],
  );

  /** Builds the draft. Returns it so the caller can preview it or navigate. */
  const generate = useCallback(async (): Promise<GoalDraft | null> => {
    const current = turnRef.current;
    if (!current) return null;
    setGenerating(true);
    try {
      const { draft: built } = await api.post<{ draft: GoalDraft }>(
        `/copilot/goal-sessions/${current.sessionId}/generate`,
        {},
      );
      setDraft(built);
      setPhase('DONE');
      return built;
    } catch (err) {
      handlers.current.onError(messageOf(err, 'Could not build the plan'));
      return null;
    } finally {
      setGenerating(false);
    }
  }, []);

  /** Abandons the session server-side. Saving for later is simply not calling this. */
  const discard = useCallback(async () => {
    const current = turnRef.current;
    if (current) await api.del(`/copilot/goal-sessions/${current.sessionId}`).catch(() => {});
    reset();
  }, [reset]);

  return {
    phase,
    bubbles,
    turn,
    draft,
    question: turn?.question ?? null,
    busy,
    generating,
    canGenerate: Boolean(turn?.canGenerate),
    progress: turn ? Math.min(100, (turn.questionCount / turn.estimatedTotal) * 100) : 0,
    begin,
    answer,
    generate,
    discard,
    reset,
  };
}

export type CopilotInterviewState = ReturnType<typeof useCopilotInterview>;
