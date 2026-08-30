import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import { describeCopilotError } from './copilot-errors';
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
  estimatedTotal: number;
  canGenerate: boolean;
  revision: number;
  context: Record<string, unknown>;
  draftId: string | null;
  messages: Array<{ role: string; content: string }>;
  question: CopilotQuestion | null;
}

function messageOf(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback;
}

export function interviewProgress(turn: InterviewTurn | null): number {
  if (!turn) return 0;
  if (turn.estimatedTotal <= 0) return turn.canGenerate ? 100 : 0;
  return Math.min(100, (turn.questionCount / turn.estimatedTotal) * 100);
}

/**
 * The one line beside the progress bar.
 *
 * A count against a moving target reads as churn — "3 of ~5" becoming "4 of ~6"
 * feels like losing ground — so the interview is described by what it is doing
 * instead. The non-interview phases have nothing to say: the surfaces show their
 * own opening, resuming and draft states.
 */
export function interviewPhaseLabel(phase: InterviewPhase, turn: InterviewTurn | null): string {
  if (phase === 'OPENING' || phase === 'RESUMING' || phase === 'DONE') return '';
  if (phase === 'READY') return 'Ready to build your plan';
  const count = turn?.questionCount ?? 0;
  if (count <= 1) return 'Understanding your goal';
  if (count <= 3) return 'Setting up your plan';
  return 'Almost ready';
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

  /**
   * Rebuilds local state from the server's snapshot of a session.
   *
   * The resume path and the stale-request recovery in generate() both come
   * through here, so a session reopened after the fact looks exactly like one
   * that was never left — including handing back a draft that already exists.
   */
  const adoptSnapshot = useCallback((data: SessionSnapshot) => {
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
      estimatedTotal: data.estimatedTotal,
      context: data.context,
      canGenerate: data.canGenerate,
      revision: data.revision,
    });
    setPhase(data.canGenerate && !data.question ? 'READY' : 'INTERVIEWING');
  }, []);

  useEffect(() => {
    if (!resumeSessionId) return;
    let cancelled = false;
    setPhase('RESUMING');

    api
      .get<SessionSnapshot>(`/copilot/goal-sessions/${resumeSessionId}`)
      .then((data) => {
        if (!cancelled) adoptSnapshot(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        handlers.current.onError(messageOf(err, 'Could not reopen that conversation'));
        handlers.current.onResumeFailed?.();
      });

    return () => {
      cancelled = true;
    };
  }, [resumeSessionId, adoptSnapshot]);

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
        handlers.current.onError(describeCopilotError(err));
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
        handlers.current.onError(describeCopilotError(err));
        setTurn(current);
        setBubbles((prev) => prev.slice(0, -1));
      } finally {
        setBusy(false);
      }
    },
    [applyTurn],
  );

  /**
   * Builds the draft. Returns it so the caller can preview it or navigate.
   *
   * `force` is the user insisting on a plan before the readiness gate says the
   * interview is worth planning from — the server still requires at least two
   * answered questions, and the response says what the plan rests on.
   */
  const generate = useCallback(
    async (opts?: { force?: boolean }): Promise<GoalDraft | null> => {
      const current = turnRef.current;
      if (!current) return null;
      setGenerating(true);
      try {
        const { draft: built } = await api.post<{ draft: GoalDraft }>(
          `/copilot/goal-sessions/${current.sessionId}/generate`,
          {
            regenerate: false,
            force: opts?.force ?? false,
            // Quoting the revision last seen lets the server refuse a plan built
            // from a picture the interview has already moved past.
            revision: turnRef.current?.revision,
          },
        );
        setDraft(built);
        setPhase('DONE');
        return built;
      } catch (err) {
        // The interview moved on under us — another tab answered a question, say.
        // Refetching puts the conversation back on the server's page and leaves
        // the session somewhere the next attempt can succeed from.
        if (err instanceof ApiError && err.code === 'STALE_REQUEST') {
          try {
            const data = await api.get<SessionSnapshot>(
              `/copilot/goal-sessions/${current.sessionId}`,
            );
            adoptSnapshot(data);
            return null;
          } catch {
            // The refetch is best-effort; the original failure is what is surfaced.
          }
        }
        // An unresolved frequency contradiction is not an error to report - it
        // comes with a question the user must answer. Adopting the snapshot
        // turns the stored question into the pending input, exactly like a
        // turn that asked it mid-interview.
        if (err instanceof ApiError && err.code === 'FREQUENCY_CONFLICT') {
          try {
            const data = await api.get<SessionSnapshot>(
              `/copilot/goal-sessions/${current.sessionId}`,
            );
            adoptSnapshot(data);
            return null;
          } catch {
            // Same best-effort contract as the stale-request recovery.
          }
        }
        handlers.current.onError(describeCopilotError(err));
        return null;
      } finally {
        setGenerating(false);
      }
    },
    [adoptSnapshot],
  );

  /** Builds from what the interview has, even though the gate would keep asking. */
  const forceGenerate = useCallback(() => generate({ force: true }), [generate]);

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
    progress: interviewProgress(turn),
    begin,
    answer,
    generate,
    forceGenerate,
    discard,
    reset,
  };
}

export type CopilotInterviewState = ReturnType<typeof useCopilotInterview>;
