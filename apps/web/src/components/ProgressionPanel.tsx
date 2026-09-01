// The progression view — the whole ladder, where the user stands on it, what the
// latest review concluded, and every change that has ever been made.
//
// Two product rules shape this file, and both are visible in the interface rather
// than only enforced on the server:
//
//  * Nothing here applies itself. A review is a read; a stage only moves when
//    someone presses a button, and the button says what it will do.
//  * Making a task harder when the numbers do not support it is possible, but it
//    is an override, and it is labelled as one. Making it easier never is.

import { useState } from 'react';
import { ChevronDown, Circle, Minus, Plus, TrendingUp } from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { Badge, ErrorState, Modal, ProgressBar, Skeleton, useAsync, useToast } from './ui';
import {
  METRIC_LABEL,
  formatTarget,
  type Progression,
  type ProgressionAction,
  type ProgressionDecision,
  type ProgressionMetric,
  type ProgressionReview,
} from '../lib/types';

interface Loaded {
  progression: Progression | null;
  review: ProgressionReview | null;
  history: ProgressionDecision[];
}

/** "11 Aug" from a YYYY-MM-DD day string, with no timezone drift. */
function shortDay(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export default function ProgressionModal({
  taskId,
  taskTitle,
  isOwner,
  open,
  onClose,
  onChanged,
}: {
  taskId: string;
  taskTitle: string;
  isOwner: boolean;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={taskTitle}>
      <ProgressionBody taskId={taskId} isOwner={isOwner} onChanged={onChanged} />
    </Modal>
  );
}

/**
 * Split from the modal so the fetch only happens once the modal is actually
 * opened — `Modal` renders nothing while closed, so this never mounts until then.
 */
function ProgressionBody({
  taskId,
  isOwner,
  onChanged,
}: {
  taskId: string;
  isOwner: boolean;
  onChanged?: () => void;
}) {
  const { data, loading, error, reload } = useAsync<Loaded>(async () => {
    // The plan and its history first, because this call succeeds even when there
    // is no ladder yet. The review is a second call and only makes sense if one
    // exists.
    const base = await api.get<{ progression: Progression | null; history: ProgressionDecision[] }>(
      `/tasks/${taskId}/progression`,
    );
    if (!base.progression) return { progression: null, review: null, history: [] };

    // A review scores *your* days, so someone who has not joined the goal has
    // nothing to score, and the server says so with a 400. Show them the ladder
    // without a verdict; anything else is a real failure and is reported.
    try {
      const reviewed = await api.get<{ progression: Progression; review: ProgressionReview }>(
        `/tasks/${taskId}/progression/review`,
      );
      return { progression: reviewed.progression, review: reviewed.review, history: base.history };
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        return { progression: base.progression, review: null, history: base.history };
      }
      throw err;
    }
  }, [taskId]);

  function afterChange() {
    reload();
    onChanged?.();
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton height={80} radius={10} />
        <Skeleton height={140} radius={10} />
      </div>
    );
  }
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  if (!data.progression) {
    return isOwner ? (
      <CreatePlanForm taskId={taskId} onCreated={afterChange} />
    ) : (
      <p style={{ fontSize: '0.88rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
        This task has no progression — it asks for the same thing every time.
      </p>
    );
  }

  const plan = data.progression;

  return (
    <div className="flex flex-col gap-5">
      <StageLadder plan={plan} />
      {data.review && (
        <ReviewCard
          taskId={taskId}
          plan={plan}
          review={data.review}
          isOwner={isOwner}
          onApplied={afterChange}
        />
      )}
      <HistoryList plan={plan} history={data.history} />
      {isOwner && <RemovePlan taskId={taskId} onRemoved={afterChange} />}
    </div>
  );
}

// ------------------------------------------------------------------- ladder

function StageLadder({ plan }: { plan: Progression }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3
          className="flex items-center gap-2"
          style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: '0.95rem', color: 'var(--text)' }}
        >
          <TrendingUp size={15} style={{ color: 'var(--text-muted)' }} /> {plan.stageLabel}
        </h3>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          since {shortDay(plan.stageStartedOn)}
        </span>
      </div>

      <ol className="flex flex-col">
        {plan.stages.map((stage, i) => {
          const done = stage.state === 'DONE';
          const current = stage.state === 'CURRENT';
          const last = i === plan.stages.length - 1;
          return (
            <li key={stage.stageIndex} className="flex gap-3">
              {/* marker + connector */}
              <div className="flex flex-col items-center" style={{ width: 24 }}>
                <span
                  className="flex items-center justify-center rounded-full flex-shrink-0"
                  style={{
                    width: 22,
                    height: 22,
                    background: current ? 'var(--accent)' : done ? 'var(--surface-3)' : 'var(--surface)',
                    border: current ? 'none' : `1px solid ${done ? 'var(--hairline-strong)' : 'var(--hairline)'}`,
                    color: current ? 'var(--accent-ink)' : done ? 'var(--text)' : 'var(--text-faint)',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                  aria-hidden="true"
                >
                  {/* A glyph, not just a tint: ✓ done, ● current, ○ still to come. */}
                  {done ? '✓' : current ? <Circle size={8} fill="var(--accent-ink)" strokeWidth={0} /> : '○'}
                </span>
                {!last && (
                  <span style={{ width: 2, flex: 1, minHeight: 18, background: done ? 'var(--hairline-strong)' : 'var(--hairline)' }} />
                )}
              </div>

              <div className="flex-1 min-w-0 pb-3">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span
                    style={{
                      fontFamily: 'var(--font-sans)',
                      fontWeight: current ? 600 : 500,
                      fontSize: current ? '0.95rem' : '0.88rem',
                      color: current ? 'var(--text)' : done ? 'var(--text-body)' : 'var(--text-muted)',
                    }}
                  >
                    {formatTarget(stage.target, plan)}
                  </span>
                  {current && <Badge tone="primary">Now</Badge>}
                  {done && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>Done</span>
                  )}
                </div>
                {stage.label && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: 1 }}>{stage.label}</div>
                )}
                {!done && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)', marginTop: 1 }}>
                    at least {stage.minDays} {stage.minDays === 1 ? 'day' : 'days'}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ------------------------------------------------------------------- review

/** Wording for a button that performs `action`, given where the ladder is. */
function actionLabel(action: ProgressionAction, plan: Progression) {
  const to = (index: number) => {
    const stage = plan.stages.find((s) => s.stageIndex === index);
    return stage ? formatTarget(stage.target, plan) : '';
  };
  switch (action) {
    case 'ADVANCE':
      return `Step up to ${to(plan.currentStageIndex + 1)}`;
    case 'REDUCE':
      return `Drop back to ${to(plan.currentStageIndex - 1)}`;
    default:
      return `Stay at ${to(plan.currentStageIndex)}`;
  }
}

function ReviewCard({
  taskId,
  plan,
  review,
  isOwner,
  onApplied,
}: {
  taskId: string;
  plan: Progression;
  review: ProgressionReview;
  isOwner: boolean;
  onApplied: () => void;
}) {
  const { push } = useToast();
  const [busy, setBusy] = useState<ProgressionAction | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);

  const canAdvance = plan.currentStageIndex < plan.stageCount - 1;
  const canReduce = plan.currentStageIndex > 0;

  async function decide(action: ProgressionAction, confirmed = false) {
    setBusy(action);
    try {
      const result = await api.post<{ applied: boolean; reason: string }>(
        `/tasks/${taskId}/progression/decision`,
        { action, confirmed },
      );
      // The server recomputes the verdict, so a request can come back refused.
      // Say so plainly rather than pretending it worked.
      push(result.applied ? 'Progression updated' : result.reason, result.applied ? 'success' : 'error');
      setOverrideOpen(false);
      onApplied();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not update the progression', 'error');
    } finally {
      setBusy(null);
    }
  }

  const judged =
    review.eligibleCount > 0
      ? `${review.completedCount} of ${review.eligibleCount} days done since ${shortDay(review.windowStart)}`
      : 'No finished days at this stage yet';

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}>
      <div className="flex items-center justify-between mb-2">
        <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: '0.85rem', color: 'var(--text)' }}>
          How it's going
        </span>
        <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '1rem', color: 'var(--text)' }}>
          {review.completionRate}%
        </span>
      </div>

      <ProgressBar value={review.completionRate} height={6} />

      <p className="mt-2" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        {judged} · {plan.advanceThreshold}% needed to step up
      </p>

      <p className="mt-3" style={{ fontSize: '0.85rem', color: 'var(--text)', lineHeight: 1.55 }}>
        {review.reason}
      </p>

      {!isOwner ? (
        <p className="mt-3" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
          The goal owner sets the pace for everyone, so only they can change the stage. These numbers
          are your own.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {/* The path the review itself recommends comes first and needs no
              confirming — the numbers already agree with it. */}
          {review.action === 'ADVANCE' && (
            <button
              className="btn-primary px-4 py-2.5 text-sm"
              onClick={() => decide('ADVANCE')}
              disabled={busy !== null}
            >
              {busy === 'ADVANCE' ? 'Updating…' : actionLabel('ADVANCE', plan)}
            </button>
          )}

          {review.action === 'REDUCE' && (
            <button
              className="btn-primary px-4 py-2.5 text-sm"
              onClick={() => decide('REDUCE')}
              disabled={busy !== null}
            >
              {busy === 'REDUCE' ? 'Updating…' : actionLabel('REDUCE', plan)}
            </button>
          )}

          {/* A big jump. The review deliberately refuses to decide this one, so the
              question is put to the user and their answer settles it either way. */}
          {review.action === 'ASK_USER' && (
            <div className="flex gap-2 flex-wrap">
              <button
                className="btn-primary px-4 py-2.5 text-sm"
                onClick={() => decide('ADVANCE', true)}
                disabled={busy !== null}
              >
                {busy === 'ADVANCE' ? 'Updating…' : `Yes, ${actionLabel('ADVANCE', plan).toLowerCase()}`}
              </button>
              <button
                className="btn-ghost px-4 py-2.5 text-sm"
                onClick={() => decide('STAY')}
                disabled={busy !== null}
              >
                Not yet
              </button>
            </div>
          )}

          {(review.action === 'ADVANCE' || review.action === 'REDUCE') && (
            <button
              className="btn-ghost px-4 py-2.5 text-sm"
              onClick={() => decide('STAY')}
              disabled={busy !== null}
            >
              {actionLabel('STAY', plan)}
            </button>
          )}

          {/* Everything else is an override, so it lives behind a disclosure and
              says out loud that the numbers don't back it. */}
          {(canAdvance || canReduce) && (
            <div className="mt-1">
              <button
                onClick={() => setOverrideOpen((v) => !v)}
                aria-expanded={overrideOpen}
                className="flex items-center gap-1.5"
                style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--text-muted)' }}
              >
                <ChevronDown
                  size={13}
                  style={{ transform: overrideOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }}
                />
                Change the stage myself
              </button>

              {overrideOpen && (
                <div
                  className="mt-2 rounded-xl p-3 flex flex-col gap-2"
                  style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
                >
                  {canReduce && (
                    <button
                      className="btn-secondary px-4 py-2.5 text-sm flex items-center justify-center gap-2"
                      onClick={() => decide('REDUCE')}
                      disabled={busy !== null}
                    >
                      <Minus size={14} /> {actionLabel('REDUCE', plan)}
                    </button>
                  )}
                  {canAdvance && (
                    <>
                      <button
                        className="btn-secondary px-4 py-2.5 text-sm flex items-center justify-center gap-2"
                        onClick={() => decide('ADVANCE', true)}
                        disabled={busy !== null}
                      >
                        <Plus size={14} /> {actionLabel('ADVANCE', plan)}
                      </button>
                      {review.action !== 'ADVANCE' && review.action !== 'ASK_USER' && (
                        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                          Stepping up now goes against the review above. It will be recorded as your
                          choice, with today's numbers next to it.
                        </p>
                      )}
                    </>
                  )}
                  <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Either way, days already past keep the target they asked for.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ history

function HistoryList({ plan, history }: { plan: Progression; history: ProgressionDecision[] }) {
  const [expanded, setExpanded] = useState(false);
  if (history.length === 0) return null;

  const shown = expanded ? history : history.slice(0, 3);

  return (
    <div>
      <h3
        className="mb-2.5"
        style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: '0.9rem', color: 'var(--text)' }}
      >
        Changes
      </h3>
      <div className="flex flex-col gap-2">
        {shown.map((d) => {
          const from = plan.stages.find((s) => s.stageIndex === d.fromStageIndex);
          const to = plan.stages.find((s) => s.stageIndex === d.toStageIndex);
          return (
            <div
              key={d.id}
              className="rounded-xl px-3.5 py-2.5"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: '0.8rem', color: 'var(--text)' }}
                >
                  {d.applied && from && to
                    ? `${formatTarget(from.target, plan)} → ${formatTarget(to.target, plan)}`
                    : d.action === 'STAY'
                      ? 'Kept the same'
                      : `${d.action.toLowerCase()} — not applied`}
                </span>
                {/* A row that never moved anything is a proposal, and says so. */}
                {!d.applied && <Badge tone="neutral">Proposal</Badge>}
                {d.source === 'COPILOT' && <Badge tone="primary">Copilot</Badge>}
                {d.source === 'USER' && <Badge tone="neutral">Your choice</Badge>}
              </div>
              <p className="mt-1" style={{ fontSize: '0.75rem', color: 'var(--text-body)', lineHeight: 1.5 }}>
                {d.reason}
              </p>
              <p className="mt-1" style={{ fontSize: '0.7rem', color: 'var(--text-faint)' }}>
                {shortDay(d.createdAt.slice(0, 10))} · {d.completedCount}/{d.eligibleCount} days ·{' '}
                {d.completionRate}%
              </p>
            </div>
          );
        })}
      </div>
      {history.length > 3 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-2"
          style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--text)' }}
        >
          {expanded ? 'Show less' : `Show all ${history.length}`}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- create

const METRICS: ProgressionMetric[] = ['MINUTES', 'REPS', 'DISTANCE_KM', 'PAGES', 'AMOUNT', 'COUNT'];

/**
 * Setting up a ladder by hand. The Copilot can propose one too, but the product
 * has to work without it, so this is the path that always exists.
 */
function CreatePlanForm({ taskId, onCreated }: { taskId: string; onCreated: () => void }) {
  const { push } = useToast();
  const [metricType, setMetricType] = useState<ProgressionMetric>('MINUTES');
  const [unitLabel, setUnitLabel] = useState('');
  const [minDays, setMinDays] = useState(7);
  const [targets, setTargets] = useState<string[]>(['', '']);
  const [busy, setBusy] = useState(false);

  const parsed = targets.map((t) => Number(t.trim()));
  const filled = parsed.every((n) => Number.isFinite(n) && n > 0);
  const climbing = parsed.every((n, i) => i === 0 || n > parsed[i - 1]);
  const valid = filled && climbing;

  async function create() {
    setBusy(true);
    try {
      await api.post(`/tasks/${taskId}/progression`, {
        metricType,
        unitLabel: unitLabel.trim() || undefined,
        stages: parsed.map((target) => ({ target, minDays })),
      });
      push('Progression added');
      onCreated();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not add the progression', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p style={{ fontSize: '0.85rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
        Make this task get harder on purpose — walk 15 minutes, then 20, then 25. It stays the same
        task, with the same reward and streak; only the target moves, and only when the numbers say
        you're ready.
      </p>

      <label className="flex flex-col gap-1.5">
        <span style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--text-body)' }}>What's growing</span>
        <select
          className="w-full px-4 py-3 text-sm"
          value={metricType}
          onChange={(e) => setMetricType(e.target.value as ProgressionMetric)}
        >
          {METRICS.map((m) => (
            <option key={m} value={m}>
              {METRIC_LABEL[m]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--text-body)' }}>
          Unit shown next to the number <span style={{ fontWeight: 400 }}>(optional)</span>
        </span>
        <input
          className="w-full px-4 py-3 text-sm"
          value={unitLabel}
          maxLength={16}
          placeholder="min"
          onChange={(e) => setUnitLabel(e.target.value)}
        />
      </label>

      <div className="flex flex-col gap-2">
        <span style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--text-body)' }}>
          The stages, easiest first
        </span>
        {targets.map((value, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className="flex items-center justify-center rounded-full flex-shrink-0"
              style={{
                width: 22,
                height: 22,
                background: 'var(--surface-3)',
                color: 'var(--text)',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {i + 1}
            </span>
            <input
              className="flex-1 px-4 py-3 text-sm"
              type="number"
              min={1}
              inputMode="numeric"
              value={value}
              placeholder={`${15 + i * 5}`}
              onChange={(e) =>
                setTargets(targets.map((t, index) => (index === i ? e.target.value : t)))
              }
            />
            {targets.length > 2 && (
              <button
                onClick={() => setTargets(targets.filter((_, index) => index !== i))}
                aria-label={`Remove stage ${i + 1}`}
                className="flex items-center justify-center rounded-lg flex-shrink-0"
                style={{ width: 34, height: 34, color: 'var(--text-muted)', border: '1px solid var(--hairline)' }}
              >
                <Minus size={14} />
              </button>
            )}
          </div>
        ))}
        {targets.length < 12 && (
          <button
            onClick={() => setTargets([...targets, ''])}
            className="py-2.5 rounded-xl flex items-center justify-center gap-2"
            style={{
              border: '1px dashed var(--hairline-strong)',
              background: 'var(--surface-2)',
              color: 'var(--text-muted)',
              fontWeight: 500,
              fontSize: '0.82rem',
            }}
          >
            <Plus size={14} /> Add a stage
          </button>
        )}
        {!climbing && filled && (
          <p style={{ fontSize: '0.75rem', color: 'var(--red)' }}>
            Each stage has to ask for more than the one before it.
          </p>
        )}
      </div>

      <label className="flex flex-col gap-1.5">
        <span style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--text-body)' }}>
          Hold each stage for at least
        </span>
        <div className="flex items-center gap-2">
          <input
            className="px-4 py-3 text-sm"
            style={{ width: 90 }}
            type="number"
            min={1}
            max={90}
            value={minDays}
            onChange={(e) => setMinDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
          />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-body)' }}>days</span>
        </div>
      </label>

      <button
        className="btn-primary px-4 py-3 text-sm"
        onClick={create}
        disabled={busy || !valid}
        style={{ opacity: busy || !valid ? 0.5 : 1 }}
      >
        {busy ? 'Adding…' : 'Add progression'}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------- remove

function RemovePlan({ taskId, onRemoved }: { taskId: string; onRemoved: () => void }) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (
      !window.confirm(
        'Remove the progression? The task keeps working, and days already past keep the target they asked for.',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.del(`/tasks/${taskId}/progression`);
      push('Progression removed');
      onRemoved();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not remove the progression', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={remove}
      disabled={busy}
      className="self-start"
      style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--red)' }}
    >
      {busy ? 'Removing…' : 'Remove progression'}
    </button>
  );
}
