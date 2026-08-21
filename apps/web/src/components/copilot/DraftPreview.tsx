import { ArrowUpRight, Clock, Repeat, TrendingUp } from 'lucide-react';
import {
  CATEGORY_EMOJI,
  CATEGORY_LABEL,
  describeDraftLadder,
  describeDraftRecurrence,
  type GoalDraft,
} from '../../lib/types';

/**
 * A draft at a glance, for the widget's narrow column.
 *
 * Intentionally read-only. Editing tasks, changing visibility and confirming all
 * live on the full review screen, which is where the user can actually see the
 * whole plan before it becomes a real goal.
 */
export default function DraftPreview({
  draft,
  onOpenFull,
}: {
  draft: GoalDraft;
  onOpenFull: () => void;
}) {
  const shown = draft.tasks.slice(0, 3);
  const hidden = draft.tasks.length - shown.length;

  return (
    <div>
      <div
        className="px-4 py-3.5 rounded-xl"
        style={{ background: '#f0ebff', border: '1px solid #ddd0ff' }}
      >
        <div className="flex items-start gap-2.5">
          <span style={{ fontSize: 20 }} aria-hidden="true">
            {CATEGORY_EMOJI[draft.category]}
          </span>
          <div className="min-w-0">
            <div
              style={{
                fontFamily: 'Plus Jakarta Sans',
                fontWeight: 800,
                fontSize: '0.95rem',
                color: '#1a1635',
                lineHeight: 1.35,
              }}
            >
              {draft.title}
            </div>
            <div style={{ fontSize: '0.72rem', color: '#7c3aed', fontWeight: 600, marginTop: 2 }}>
              {CATEGORY_LABEL[draft.category]}
              {draft.deadline ? ` · by ${draft.deadline}` : ''}
            </div>
          </div>
        </div>
        {draft.rationale && (
          <p style={{ fontSize: '0.82rem', color: '#4b4870', lineHeight: 1.55, marginTop: 10 }}>
            {draft.rationale}
          </p>
        )}
      </div>

      <div
        style={{
          fontSize: '0.72rem',
          fontWeight: 700,
          color: '#6b688f',
          letterSpacing: '0.05em',
          fontFamily: 'Plus Jakarta Sans',
          margin: '14px 0 8px',
        }}
      >
        {draft.tasks.length} {draft.tasks.length === 1 ? 'TASK' : 'TASKS'}
      </div>

      <div className="flex flex-col gap-2">
        {shown.map((task) => (
          <div
            key={task.id}
            className="px-3.5 py-3 rounded-xl"
            style={{ background: '#fff', border: '1px solid #e8e6f5' }}
          >
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#1a1635', lineHeight: 1.4 }}>
              {task.title}
            </div>
            <div className="flex items-center gap-3 mt-1.5" style={{ fontSize: '0.72rem', color: '#8b88b0' }}>
              <span className="inline-flex items-center gap-1">
                <Repeat size={11} /> {describeDraftRecurrence(task)}
              </span>
              {task.estimatedMinutes && (
                <span className="inline-flex items-center gap-1">
                  <Clock size={11} /> {task.estimatedMinutes} min
                </span>
              )}
            </div>
            {task.progression && (
              // Shown here because the amount changing over time is part of what the
              // user is agreeing to. A plan that quietly grows is not the plan they read.
              <div
                className="inline-flex items-center gap-1 mt-2 px-2 py-1 rounded-md"
                style={{ background: '#f5f4ff', color: '#7c3aed', fontSize: '0.7rem', fontWeight: 600 }}
              >
                <TrendingUp size={11} aria-hidden="true" />
                Builds up: {describeDraftLadder(task.progression)}
              </div>
            )}
          </div>
        ))}
        {hidden > 0 && (
          <p style={{ fontSize: '0.75rem', color: '#8b88b0', paddingLeft: 2 }}>
            + {hidden} more {hidden === 1 ? 'task' : 'tasks'}
          </p>
        )}
      </div>

      <button
        className="btn-primary w-full mt-4 py-3 text-sm flex items-center justify-center gap-2"
        onClick={onOpenFull}
      >
        Open full plan <ArrowUpRight size={15} />
      </button>
      <p className="mt-2.5 text-center" style={{ fontSize: '0.72rem', color: '#b8b5d5', lineHeight: 1.5 }}>
        Nothing is created yet. You review and confirm the plan first.
      </p>
    </div>
  );
}
