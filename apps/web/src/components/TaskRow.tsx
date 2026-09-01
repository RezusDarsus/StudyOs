import { useState } from 'react';
import { Check, Clock, Gauge, TrendingUp } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from './ui';
import {
  DIFFICULTY_LABEL,
  DIFFICULTY_OPTIONS,
  formatTarget,
  type DifficultyRating,
  type TodayTask,
} from '../lib/types';

/**
 * A single completable task. Completion is optimistic so the tap feels instant,
 * and rolls back if the server rejects it.
 *
 * State is never signalled by colour alone: a completed task gets a check glyph,
 * strikethrough text and an accessible pressed state as well as the tint.
 */
export default function TaskRow({
  task,
  onChanged,
}: {
  task: TodayTask;
  onChanged?: (task: TodayTask, delta: number) => void;
}) {
  const [status, setStatus] = useState(task.status);
  const [busy, setBusy] = useState(false);
  const [justEarned, setJustEarned] = useState<number | null>(null);
  const [rating, setRating] = useState<DifficultyRating | null>(task.feedback ?? null);
  const { push } = useToast();

  const completed = status === 'COMPLETED';

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = completed ? 'PENDING' : 'COMPLETED';
    setStatus(next);

    try {
      if (next === 'COMPLETED') {
        const result = await api.post<{ reward: number; unlocked?: string[] }>(
          `/task-occurrences/${task.occurrenceId}/complete`,
        );
        if (result.reward > 0) {
          setJustEarned(result.reward);
          setTimeout(() => setJustEarned(null), 700);
        }
        push(result.reward > 0 ? `Move settled · +${result.reward}` : 'Move settled');
        onChanged?.({ ...task, status: 'COMPLETED' }, 1);
      } else {
        await api.post(`/task-occurrences/${task.occurrenceId}/undo`);
        onChanged?.({ ...task, status: 'PENDING' }, -1);
      }
    } catch (err) {
      setStatus(task.status);
      push(err instanceof Error ? err.message : 'Could not update that task', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    // A div, not a fragment: the difficulty strip belongs to this row, and nesting a
    // second set of buttons inside the completion button would be invalid markup and
    // unusable with a keyboard.
    <div className="rounded-xl" style={{ background: completed ? 'var(--surface-2)' : 'var(--surface)', border: '1px solid var(--hairline)' }}>
      <button
        onClick={toggle}
        disabled={busy}
        aria-pressed={completed}
        className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-left transition-all"
        style={{
          background: 'transparent',
          border: 'none',
          opacity: busy ? 0.75 : 1,
          cursor: busy ? 'wait' : 'pointer',
          // Comfortable touch target on mobile.
          minHeight: 52,
        }}
      >
        <span
          className={`flex items-center justify-center rounded-full flex-shrink-0 ${completed ? 'animate-check-in' : ''}`}
          style={{
            width: 24,
            height: 24,
            background: completed ? 'var(--accent)' : 'transparent',
            border: completed ? 'none' : '2px solid var(--hairline-strong)',
            color: 'var(--accent-ink)',
          }}
          aria-hidden="true"
        >
          {completed && <Check size={14} strokeWidth={3.5} />}
        </span>

        <span className="flex-1 min-w-0">
          <span
            className="block truncate"
            style={{
              fontSize: '0.9rem',
              fontWeight: completed ? 400 : 500,
              fontFamily: 'var(--font-sans)',
              color: completed ? 'var(--text-muted)' : 'var(--text)',
              textDecoration: completed ? 'line-through' : 'none',
            }}
          >
            {task.title}
            {/* The target this day asked for. Part of the task's name as far as the
                user is concerned — "walk" and "walk 20 min" are different jobs. */}
            {task.progression && (
              <span
                className="ml-2 whitespace-nowrap"
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: completed ? 'var(--text-muted)' : 'var(--text-body)',
                  textDecoration: 'none',
                }}
              >
                {formatTarget(task.progression.target, task.progression)}
              </span>
            )}
          </span>
          {(task.reminderTime || task.progression) && (
            <span
              className="flex items-center gap-1.5 mt-0.5"
              style={{ fontSize: '0.7rem', color: 'var(--text-faint)' }}
            >
              {task.reminderTime && (
                <span className="flex items-center gap-1">
                  <Clock size={10} /> {task.reminderTime}
                </span>
              )}
              {task.reminderTime && task.progression && <span aria-hidden="true">·</span>}
              {task.progression && (
                <span className="flex items-center gap-1">
                  <TrendingUp size={10} /> {task.progression.stageLabel}
                </span>
              )}
            </span>
          )}
        </span>

        <span className="relative flex-shrink-0">
          <span style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>
            +{task.reward}
          </span>
          {justEarned !== null && (
            // The standing reward is quiet metadata; only the moment of earning
            // is worth the accent, and it fades on its own.
            <span
              className="absolute right-0 -top-1 animate-coin-pop pointer-events-none"
              style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--green)' }}
            >
              +{justEarned}
            </span>
          )}
        </span>

        <span className="sr-only">{completed ? 'Completed' : 'Not completed'}</span>
      </button>

      {/*
        * Asked only after the task is done, because that is the only point at which
        * the user actually knows the answer. A rating already given stays reachable
        * even if they undo the completion — an accidental tap should not become
        * permanent just because it can no longer be seen.
        */}
      {(completed || rating !== null) && (
        <DifficultyStrip
          occurrenceId={task.occurrenceId}
          rating={rating}
          onRated={setRating}
        />
      )}
    </div>
  );
}

/**
 * "How did that feel?" — three answers, and nothing else happens.
 *
 * Collapsed to a single quiet line until asked for. Three permanent buttons under
 * every finished task would turn a list of eight into a wall of controls and imply
 * the user owes the app an answer, which they do not.
 *
 * Deliberately does not call `onChanged`: a rating moves no score, earns no coins
 * and changes no plan, so the page around it has nothing to redraw. Whether a run of
 * "too hard" is worth acting on is decided later, out loud, with the user.
 */
function DifficultyStrip({
  occurrenceId,
  rating,
  onRated,
}: {
  occurrenceId: string;
  rating: DifficultyRating | null;
  onRated: (rating: DifficultyRating | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { push } = useToast();

  async function choose(next: DifficultyRating) {
    if (busy) return;
    setBusy(true);
    const previous = rating;
    onRated(next); // Optimistic, like completion — the tap should feel instant.
    try {
      await api.post(`/task-occurrences/${occurrenceId}/feedback`, { rating: next });
      setOpen(false);
    } catch (err) {
      onRated(previous);
      push(err instanceof Error ? err.message : 'Could not save that', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="px-3.5 pb-2.5 -mt-1">
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5"
          style={{
            fontSize: '0.7rem',
            fontWeight: 500,
            color: rating ? 'var(--text-muted)' : 'var(--text-faint)',
            background: 'none',
            border: 'none',
            padding: '2px 0',
            cursor: 'pointer',
          }}
        >
          {rating ? (
            <>
              {/* The rating in words, not as a coloured dot. */}
              <Gauge size={11} aria-hidden="true" />
              Felt {DIFFICULTY_LABEL[rating].toLowerCase()} · change
            </>
          ) : (
            'How did that feel?'
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      className="px-3.5 pb-3 pt-1 flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label="How did that feel?"
    >
      {DIFFICULTY_OPTIONS.map((option) => {
        const chosen = option.rating === rating;
        return (
          <button
            key={option.rating}
            onClick={() => choose(option.rating)}
            disabled={busy}
            aria-pressed={chosen}
            className="inline-flex items-center gap-1 rounded-full"
            style={{
              fontSize: '0.7rem',
              fontWeight: 500,
              padding: '5px 10px',
              background: chosen ? 'var(--accent)' : 'var(--surface-2)',
              color: chosen ? 'var(--accent-ink)' : 'var(--text-body)',
              border: `1px solid ${chosen ? 'var(--accent)' : 'var(--hairline)'}`,
              cursor: busy ? 'wait' : 'pointer',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {/* The glyph carries the choice as well as the fill does. */}
            {chosen && <Check size={10} strokeWidth={3.5} aria-hidden="true" />}
            {option.label}
          </button>
        );
      })}
      <button
        onClick={() => setOpen(false)}
        style={{
          fontSize: '0.7rem',
          color: 'var(--text-faint)',
          background: 'none',
          border: 'none',
          padding: '5px 4px',
          cursor: 'pointer',
        }}
      >
        {rating ? 'Done' : 'Not now'}
      </button>
    </div>
  );
}
