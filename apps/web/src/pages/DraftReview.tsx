import { Fragment, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Clock,
  MessageSquare,
  Pencil,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge, ErrorState, Modal, Skeleton, useAsync, useToast } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { describeCopilotError } from '../lib/copilot-errors';
import { newOperationId } from '../lib/operation-id';
import { canSubmit } from '../lib/slash';
import {
  CATEGORY_EMOJI,
  CATEGORY_LABEL,
  describeDraftLadder,
  describeDraftRecurrence,
  formatTarget,
  type DraftProgression,
  type DraftTask,
  type GoalDraft,
} from '../lib/types';

/**
 * The review step. A draft is a proposal — nothing exists in the product until
 * the user presses Create Goal, and that is stated plainly on screen.
 */
export default function DraftReview() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { push } = useToast();

  const { data, loading, error, reload, setData } = useAsync(
    () => api.get<{ draft: GoalDraft; assumptions?: string[] }>(`/copilot/goal-drafts/${id}`),
    [id],
  );

  const [busy, setBusy] = useState<null | 'confirm' | 'regenerate' | 'edit'>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [editing, setEditing] = useState<DraftTask | null>(null);
  const [feedback, setFeedback] = useState<boolean | null>(null);

  const draft = data?.draft;
  const assumptions = data?.assumptions ?? [];

  async function confirm() {
    setBusy('confirm');    try {
      const result = await api.post<{ goalId: string }>(`/copilot/goal-drafts/${id}/confirm`, {
      operationId: newOperationId(),
    });
      push('Goal created 🎉');
      navigate(`/app/goals/${result.goalId}`, { replace: true });
    } catch (err) {
      push(describeCopilotError(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function setVisibility(visibility: 'PRIVATE' | 'PUBLIC') {
    if (!draft || draft.visibility === visibility) return;
    setBusy('edit');
    try {
      const result = await api.patch<{ draft: GoalDraft }>(`/copilot/goal-drafts/${id}`, {
        visibility,
      });
      setData(result);
      push(visibility === 'PUBLIC' ? 'Anyone can now discover this goal' : 'Goal set to private');
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not change visibility', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    if (!draft?.sessionId) return;
    setBusy('regenerate');
    try {
      const result = await api.post<{ draft: GoalDraft }>(
        `/copilot/goal-sessions/${draft.sessionId}/generate`,
        { regenerate: true },
      );
      push('Here’s another take');
      navigate(`/app/goals/drafts/${result.draft.id}`, { replace: true });
    } catch (err) {
      push(describeCopilotError(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    if (!window.confirm('Discard this plan?')) return;
    await api.post(`/copilot/goal-drafts/${id}/discard`, {}).catch(() => {});
    navigate('/app/goals', { replace: true });
  }

  async function rate(useful: boolean) {
    setFeedback(useful);
    await api.post(`/copilot/goal-drafts/${id}/feedback`, { useful }).catch(() => {});
  }

  if (loading) {
    return (
      <div className="product-page draft-review-page flex flex-col gap-4">
        <Skeleton height={120} radius={10} />
        <Skeleton height={220} radius={10} />
      </div>
    );
  }

  if (error || !draft) {
    return (
      <div className="product-page draft-review-page">
        <ErrorState message={error ?? 'That plan is not available'} onRetry={reload} />
      </div>
    );
  }

  if (draft.status === 'CONFIRMED' && draft.createdGoalId) {
    navigate(`/app/goals/${draft.createdGoalId}`, { replace: true });
    return null;
  }

  return (
    <div className="product-page draft-review-page">
      <button
        onClick={() => navigate('/app/goals')}
        className="flex items-center gap-2 mb-5"
        style={{ color: 'var(--text-muted)', fontSize: '0.875rem', fontWeight: 400 }}
      >
        <ArrowLeft size={15} /> Back to goals
      </button>

      <div className="flex items-center gap-2 mb-5">
        <Sparkles size={18} style={{ color: 'var(--text-muted)' }} />
        <h1
          style={{
            fontFamily: 'var(--font-sans)',
            fontWeight: 600,
            fontSize: 'clamp(1.3rem, 2.5vw, 1.65rem)',
            color: 'var(--text)',
            letterSpacing: '-0.02em',
          }}
        >
          Your plan, with the reasoning visible
        </h1>
      </div>

      {/* --------------------------------------------------------- goal */}
      <div className="card draft-plan-hero p-5 mb-4">
        <div className="flex items-start gap-3.5">
          <span
            className="flex items-center justify-center rounded-2xl flex-shrink-0"
            style={{ width: 50, height: 50, fontSize: 24, background: 'var(--surface-3)', border: '1px solid var(--hairline-strong)' }}
            aria-hidden="true"
          >
            {CATEGORY_EMOJI[draft.category]}
          </span>
          <div className="min-w-0 flex-1">
            <h2
              style={{
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
                fontSize: '1.2rem',
                color: 'var(--text)',
                lineHeight: 1.3,
              }}
            >
              {draft.title}
            </h2>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge tone="neutral">{CATEGORY_LABEL[draft.category]}</Badge>
              {(['PRIVATE', 'PUBLIC'] as const).map((visibility) => (
                <button
                  key={visibility}
                  type="button"
                  aria-pressed={draft.visibility === visibility}
                  disabled={busy !== null}
                  onClick={() => void setVisibility(visibility)}
                  className="px-2.5 py-1 rounded-lg"
                  style={{
                    border: `1px solid ${draft.visibility === visibility ? 'var(--accent)' : 'var(--hairline)'}`,
                    background: draft.visibility === visibility ? 'var(--surface-3)' : 'var(--surface)',
                    color: draft.visibility === visibility ? 'var(--text)' : 'var(--text-muted)',
                    fontSize: '0.72rem',
                    fontWeight: 500,
                  }}
                >
                  {visibility === 'PRIVATE' ? '🔒 Private' : '🌍 Public'}
                </button>
              ))}
              {draft.deadline && <Badge tone="warning">by {draft.deadline}</Badge>}
            </div>
          </div>
        </div>
        {draft.description && (
          <p className="mt-3.5" style={{ fontSize: '0.88rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
            {draft.description}
          </p>
        )}
      </div>

      {/* ---------------------------------------------------- rationale */}
      <div
        className="rounded-2xl p-5 mb-4"
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--hairline-strong)',
        }}
      >
        <div
          style={{
            fontSize: '0.72rem',
            fontWeight: 500,
            color: 'var(--text-body)',
            letterSpacing: '0.06em',
            fontFamily: 'var(--font-sans)',
            marginBottom: 8,
          }}
        >
          WHY THIS PLAN FITS YOU
        </div>
        <p style={{ fontSize: '0.9rem', color: 'var(--text)', lineHeight: 1.65 }}>{draft.rationale}</p>
      </div>

      {/* -------------------------------------------------- assumptions */}
      {assumptions.length > 0 && (
        <div
          className="rounded-2xl p-5 mb-4"
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--hairline)',
          }}
        >
          <div
            style={{
              fontSize: '0.72rem',
              fontWeight: 500,
              color: 'var(--text-body)',
              letterSpacing: '0.06em',
              fontFamily: 'var(--font-sans)',
              marginBottom: 8,
            }}
          >
            WHAT THE PLAN ASSUMES
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {assumptions.map((line, i) => (
              <li
                key={i}
                style={{ fontSize: '0.82rem', color: 'var(--text-body)', lineHeight: 1.55, marginTop: i === 0 ? 0 : 6 }}
              >
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* -------------------------------------------------------- tasks */}
      <h3
        className="mb-3"
        style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: '1rem', color: 'var(--text)' }}
      >
        Your tasks
      </h3>

      <div className="flex flex-col gap-3 mb-5">
        {draft.tasks.map((task) => (
          <div key={task.id} className="card shadow-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontWeight: 500,
                    fontSize: '0.95rem',
                    color: 'var(--text)',
                  }}
                >
                  {task.title}
                </div>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <Badge tone="primary">{describeDraftRecurrence(task)}</Badge>
                  {task.estimatedMinutes && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {task.estimatedMinutes} min
                    </span>
                  )}
                  {task.preferredTime && (
                    <span
                      className="flex items-center gap-1"
                      style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
                    >
                      <Clock size={11} /> {task.preferredTime}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setEditing(task)}
                aria-label={`Edit ${task.title}`}
                className="flex items-center justify-center rounded-lg flex-shrink-0"
                style={{ width: 34, height: 34, color: 'var(--text-muted)', border: '1px solid var(--hairline)' }}
              >
                <Pencil size={14} />
              </button>
            </div>

            {task.progression && <LadderPreview progression={task.progression} />}

            {task.reason && (
              <div
                className="mt-3 px-3 py-2.5 rounded-xl"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
              >
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 500,
                    color: 'var(--text)',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  Why this?
                </span>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-body)', marginTop: 3, lineHeight: 1.5 }}>
                  {task.reason}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------ actions */}
      <button
        className="btn-primary w-full py-3.5 text-sm flex items-center justify-center gap-2 mb-3"
        onClick={confirm}
        disabled={busy !== null}
      >
        <Check size={16} />
        {busy === 'confirm' ? 'Creating…' : 'Create Goal'}
      </button>

      <div className="grid grid-cols-2 gap-2.5 mb-3">
        <button
          className="btn-secondary py-2.5 text-sm flex items-center justify-center gap-2"
          onClick={() => setChatOpen(true)}
          disabled={busy !== null}
        >
          <MessageSquare size={14} /> Ask Copilot
        </button>
        <button
          className="btn-ghost py-2.5 text-sm flex items-center justify-center gap-2"
          onClick={regenerate}
          disabled={busy !== null || !draft.sessionId}
        >
          <RefreshCw size={14} /> {busy === 'regenerate' ? 'Rebuilding…' : 'Regenerate'}
        </button>
      </div>

      <button
        className="btn-ghost w-full py-2.5 text-sm flex items-center justify-center gap-2"
        onClick={discard}
        style={{ color: 'var(--red)' }}
        disabled={busy !== null}
      >
        <Trash2 size={14} /> Discard
      </button>

      <p className="text-center mt-4" style={{ fontSize: '0.75rem', color: 'var(--text-faint)' }}>
        Nothing is created until you press Create Goal.
      </p>

      {/* ----------------------------------------------------- feedback */}
      <div className="flex items-center justify-center gap-3 mt-6">
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Was this plan useful?</span>
        <button
          onClick={() => rate(true)}
          aria-label="Yes, useful"
          className="flex items-center justify-center rounded-lg"
          style={{
            width: 34,
            height: 34,
            border: '1px solid var(--hairline)',
            background: feedback === true ? 'var(--surface-3)' : 'var(--surface)',
            color: feedback === true ? 'var(--text)' : 'var(--text-faint)',
          }}
        >
          <ThumbsUp size={14} />
        </button>
        <button
          onClick={() => rate(false)}
          aria-label="No, not useful"
          className="flex items-center justify-center rounded-lg"
          style={{
            width: 34,
            height: 34,
            border: '1px solid var(--hairline)',
            background: feedback === false ? 'var(--red-tint)' : 'var(--surface)',
            color: feedback === false ? 'var(--red)' : 'var(--text-faint)',
          }}
        >
          <ThumbsDown size={14} />
        </button>
      </div>

      <CopilotEditModal
        draftId={id}
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        onUpdated={(next) => setData({ draft: next })}
      />

      <TaskEditModal
        draftId={id}
        draft={draft}
        task={editing}
        onClose={() => setEditing(null)}
        onUpdated={(next) => setData({ draft: next })}
      />
    </div>
  );
}

/**
 * The proposed build-up, shown before the user agrees to it.
 *
 * A plan whose amounts grow later is a different plan from a flat one, so it is
 * spelled out here rather than discovered in week three. The starting rung is named
 * in words as well as highlighted — the highlight alone would leave anyone who
 * cannot distinguish it guessing which number they start on.
 */
function LadderPreview({ progression }: { progression: DraftProgression }) {
  const { stages } = progression;
  const holds = [...new Set(stages.map((stage) => stage.minDays))].sort((a, b) => a - b);
  const holdText =
    holds.length === 1
      ? `at least ${holds[0]} days`
      : `at least ${holds[0]}–${holds[holds.length - 1]} days`;

  return (
    <div
      className="mt-3 px-3 py-2.5 rounded-xl"
      style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
    >
      <span
        className="inline-flex items-center gap-1.5"
        style={{
          fontSize: '0.7rem',
          fontWeight: 500,
          color: 'var(--text)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <TrendingUp size={12} aria-hidden="true" />
        Builds up over time
      </span>

      <div className="flex items-center gap-1 mt-2 flex-wrap">
        {stages.map((stage, i) => (
          <Fragment key={i}>
            {i > 0 && <ChevronRight size={12} style={{ color: 'var(--text-faint)' }} aria-hidden="true" />}
            <span
              className="px-2 py-1 rounded-md"
              style={{
                fontSize: '0.75rem',
                fontWeight: 500,
                background: i === 0 ? 'var(--accent)' : 'var(--surface)',
                color: i === 0 ? 'var(--accent-ink)' : 'var(--text-body)',
                border: i === 0 ? '1px solid var(--accent)' : '1px solid var(--hairline)',
              }}
            >
              {formatTarget(stage.target, progression)}
            </span>
          </Fragment>
        ))}
      </div>

      <p style={{ fontSize: '0.78rem', color: 'var(--text-body)', marginTop: 8, lineHeight: 1.5 }}>
        You start at {formatTarget(stages[0].target, progression)}. Each step holds for {holdText} and
        only moves up when you’re keeping up — never automatically.
      </p>
    </div>
  );
}

/** Natural-language editing: "make Saturday a rest day". */
function CopilotEditModal({
  draftId,
  open,
  onClose,
  onUpdated,
}: {
  draftId: string;
  open: boolean;
  onClose: () => void;
  onUpdated: (draft: GoalDraft) => void;
}) {
  const { push } = useToast();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  // What the backend actually applied — the model's prose can overclaim.
  const [applied, setApplied] = useState<string[]>([]);

  const suggestions = [
    'Make it a bit easier',
    'Make Saturday a rest day',
    'Shorten the sessions',
    'Add one more task',
  ];

  async function send() {
    if (!canSubmit(message)) return;
    setBusy(true);
    setReply(null);
    try {
      const result = await api.post<{
        draft: GoalDraft;
        assistantMessage: string;
        applied: string[];
      }>(`/copilot/goal-drafts/${draftId}/copilot-edit`, { message: message.trim(), operationId: newOperationId() });
      onUpdated(result.draft);
      setReply(result.assistantMessage);
      setApplied(result.applied ?? []);
      setMessage('');
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not apply that change', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Ask Copilot to change something">
      {reply && (
        <div
          className="mb-4 px-3.5 py-3 rounded-xl"
          style={{ background: 'var(--surface-3)', border: '1px solid var(--hairline-strong)', fontSize: '0.88rem', color: 'var(--text)' }}
        >
          {reply}
          {applied.length > 0 && (
            <ul className="mt-2.5" style={{ fontSize: '0.78rem', color: 'var(--text-body)' }}>
              {applied.map((change, i) => (
                <li key={i} style={{ marginTop: 2 }}>
                  ✓ {change}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-3">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => setMessage(s)}
            className="px-3 py-1.5 rounded-full"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--hairline)',
              color: 'var(--text-body)',
              fontSize: '0.75rem',
              fontWeight: 500,
            }}
          >
            {s}
          </button>
        ))}
      </div>

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        placeholder="e.g. Make the walks 30 minutes instead"
        className="w-full px-4 py-3 text-sm resize-none"
        autoFocus
      />

      <button
        className="btn-primary w-full mt-3 py-3 text-sm"
        onClick={send}
        disabled={busy || !canSubmit(message)}
        style={{ opacity: busy || !canSubmit(message) ? 0.5 : 1 }}
      >
        {busy ? 'Updating your plan…' : 'Apply change'}
      </button>
    </Modal>
  );
}

/** Editing by hand — the AI is never required to change a draft. */
function TaskEditModal({
  draftId,
  draft,
  task,
  onClose,
  onUpdated,
}: {
  draftId: string;
  draft: GoalDraft;
  task: DraftTask | null;
  onClose: () => void;
  onUpdated: (draft: GoalDraft) => void;
}) {
  const { push } = useToast();
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState<string>('');
  const [time, setTime] = useState('');
  const [timesPerWeek, setTimesPerWeek] = useState<string>('');
  const [dropLadder, setDropLadder] = useState(false);
  const [busy, setBusy] = useState(false);

  // Seed the form whenever a different task is opened.
  const seededFor = useState<string | null>(null);
  if (task && seededFor[0] !== task.id) {
    seededFor[1](task.id);
    setTitle(task.title);
    setMinutes(task.estimatedMinutes ? String(task.estimatedMinutes) : '');
    setTime(task.preferredTime ?? '');
    setTimesPerWeek(
      task.recurrenceType === 'TIMES_PER_WEEK' ? String(task.recurrenceConfig.timesPerWeek ?? 3) : '',
    );
    setDropLadder(false);
  }

  // A minutes ladder decides the session length itself — its first rung is what the
  // task starts at. Leaving the field editable would accept a number the server then
  // overrides, so it is locked with the reason stated instead of silently ignored.
  const minutesSetByLadder =
    task?.progression?.metricType === 'MINUTES' && !dropLadder;

  async function save() {
    if (!task) return;
    setBusy(true);
    try {
      const tasks = draft.tasks.map((t) =>
        t.id === task.id
          ? {
              id: t.id,
              title: title.trim() || t.title,
              description: t.description,
              recurrenceType: t.recurrenceType,
              recurrenceConfig:
                t.recurrenceType === 'TIMES_PER_WEEK' && timesPerWeek
                  ? { timesPerWeek: Math.min(7, Math.max(1, Number(timesPerWeek))) }
                  : t.recurrenceConfig,
              estimatedMinutes: minutes ? Number(minutes) : null,
              preferredTime: time || null,
              reason: t.reason,
              // Only sent when the user asked to drop it. Omitting the key leaves the
              // build-up as it was — it is not something this form can author.
              ...(dropLadder ? { progression: null } : {}),
            }
          : {
              id: t.id,
              title: t.title,
              description: t.description,
              recurrenceType: t.recurrenceType,
              recurrenceConfig: t.recurrenceConfig,
              estimatedMinutes: t.estimatedMinutes,
              preferredTime: t.preferredTime,
              reason: t.reason,
            },
      );
      const result = await api.patch<{ draft: GoalDraft }>(`/copilot/goal-drafts/${draftId}`, {
        tasks,
      });
      onUpdated(result.draft);
      push('Task updated');
      onClose();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!task || draft.tasks.length <= 1) {
      push('A plan needs at least one task', 'error');
      return;
    }
    setBusy(true);
    try {
      const tasks = draft.tasks
        .filter((t) => t.id !== task.id)
        .map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          recurrenceType: t.recurrenceType,
          recurrenceConfig: t.recurrenceConfig,
          estimatedMinutes: t.estimatedMinutes,
          preferredTime: t.preferredTime,
          reason: t.reason,
        }));
      const result = await api.patch<{ draft: GoalDraft }>(`/copilot/goal-drafts/${draftId}`, {
        tasks,
      });
      onUpdated(result.draft);
      push('Task removed');
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const label = {
    fontSize: '0.8rem',
    fontWeight: 500,
    color: 'var(--text-body)',
    display: 'block',
    marginBottom: 6,
    fontFamily: 'var(--font-sans)',
  } as const;

  return (
    <Modal
      open={task !== null}
      onClose={onClose}
      title="Edit task"
      footer={
        <>
          <button className="btn-ghost px-4 py-2.5 text-sm" onClick={remove} style={{ color: 'var(--red)' }}>
            Remove
          </button>
          <button className="btn-primary px-4 py-2.5 text-sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <label htmlFor="dt-title" style={label}>
        Task name
      </label>
      <input
        id="dt-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full px-4 py-3 text-sm mb-4"
      />

      {task?.recurrenceType === 'TIMES_PER_WEEK' && (
        <>
          <label htmlFor="dt-tpw" style={label}>
            Times per week
          </label>
          <input
            id="dt-tpw"
            type="number"
            min={1}
            max={7}
            value={timesPerWeek}
            onChange={(e) => setTimesPerWeek(e.target.value)}
            className="w-full px-4 py-3 text-sm mb-4"
          />
        </>
      )}

      <label htmlFor="dt-min" style={label}>
        Minutes per session
      </label>
      <input
        id="dt-min"
        type="number"
        min={1}
        max={600}
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
        disabled={minutesSetByLadder}
        className="w-full px-4 py-3 text-sm"
        style={minutesSetByLadder ? { background: 'var(--surface-2)', color: 'var(--text-muted)' } : undefined}
      />
      {minutesSetByLadder ? (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '6px 0 16px', lineHeight: 1.5 }}>
          Set by the build-up below — this is its first step.
        </p>
      ) : (
        <div style={{ height: 16 }} />
      )}

      {task?.progression && (
        <div
          className="px-3.5 py-3 rounded-xl mb-4"
          style={{
            background: dropLadder ? 'var(--surface)' : 'var(--surface-2)',
            border: `1px solid ${dropLadder ? 'var(--hairline)' : 'var(--hairline-strong)'}`,
          }}
        >
          <div
            className="flex items-center gap-1.5"
            style={{
              fontSize: '0.8rem',
              fontWeight: 500,
              color: dropLadder ? 'var(--text-muted)' : 'var(--text)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <TrendingUp size={13} aria-hidden="true" />
            Build-up: {describeDraftLadder(task.progression)}
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-body)', marginTop: 4, lineHeight: 1.5 }}>
            {dropLadder
              ? `Will be removed when you save. The task stays, at ${formatTarget(
                  task.progression.stages[0].target,
                  task.progression,
                )} every time.`
              : 'Keeps the same amount growing step by step, only when you’re keeping up.'}
          </p>
          <button
            onClick={() => setDropLadder(!dropLadder)}
            className="mt-2"
            style={{
              fontSize: '0.78rem',
              fontWeight: 500,
              color: dropLadder ? 'var(--green)' : 'var(--red)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {dropLadder ? 'Keep the build-up' : 'Remove the build-up'}
          </button>
        </div>
      )}

      <label htmlFor="dt-time" style={label}>
        Reminder time
      </label>
      <input
        id="dt-time"
        type="time"
        value={time}
        onChange={(e) => setTime(e.target.value)}
        className="w-full px-4 py-3 text-sm"
      />
    </Modal>
  );
}
