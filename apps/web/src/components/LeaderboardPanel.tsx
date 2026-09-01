import { useState } from 'react';
import { api } from '../lib/api';
import type { LeaderboardEntry } from '../lib/types';
import { Avatar, ErrorState, Skeleton, useAsync } from './ui';

const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * The two leaderboard modes.
 *
 * Daily is "who is doing best today". Average is "who has been most consistent",
 * built only from finished days — so nobody is marked down at 09:00 for a task
 * scheduled at 20:00.
 */
export default function LeaderboardPanel({ goalId }: { goalId: string }) {
  const [mode, setMode] = useState<'daily' | 'average'>('daily');

  const { data, loading, error, reload } = useAsync(
    () =>
      api.get<{ mode: string; today: string; entries: LeaderboardEntry[] }>(
        `/goals/${goalId}/leaderboard?mode=${mode}`,
      ),
    [goalId, mode],
  );

  return (
    <div className="card shadow-card p-5">
      <div className="tab-strip mb-4" role="tablist" aria-label="Leaderboard mode">
        {(['daily', 'average'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className="tab-item"
          >
            {m === 'daily' ? 'Daily' : 'Average'}
          </button>
        ))}
      </div>

      <p className="mb-4" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {mode === 'daily'
          ? "Who's doing best today, based on today's scheduled tasks."
          : 'Average of every finished day since each person joined.'}
      </p>

      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height={46} />
          <Skeleton height={46} />
          <Skeleton height={46} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : data && data.entries.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {data.entries.map((entry) => (
            <LeaderboardRow key={entry.participantId} entry={entry} mode={mode} />
          ))}
        </div>
      ) : (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No participants yet.</p>
      )}
    </div>
  );
}

export function LeaderboardRow({
  entry,
  mode,
}: {
  entry: LeaderboardEntry;
  mode: 'daily' | 'average';
}) {
  const medal = entry.rank <= 3 ? MEDALS[entry.rank - 1] : null;

  return (
    <div
      className="flex items-center gap-2.5 py-2.5 px-3 rounded-xl"
      style={{
        background: entry.isMe ? 'var(--accent-wash)' : 'transparent',
        border: `1px solid ${entry.isMe ? 'var(--accent-line)' : 'transparent'}`,
      }}
    >
      <span
        style={{
          fontSize: medal ? 15 : 11,
          width: 24,
          textAlign: 'center',
          fontWeight: 500,
          color: 'var(--text-muted)',
        }}
      >
        {medal ?? entry.rank}
      </span>

      <Avatar emoji={entry.avatarEmoji} size={30} />

      <span
        className="flex-1 min-w-0 truncate"
        style={{
          fontSize: '0.85rem',
          fontWeight: entry.isMe ? 500 : 400,
          color: 'var(--text)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {entry.isMe ? 'You' : entry.name}
      </span>

      {entry.percent === null ? (
        // Nothing scheduled — never shown as 0%, which would read as failure.
        <span style={{ fontSize: '0.75rem', color: 'var(--text-faint)', fontStyle: 'italic' }}>
          No tasks today
        </span>
      ) : (
        <>
          {mode === 'daily' && (
            <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>
              {entry.completed}/{entry.required}
            </span>
          )}
          <span
            style={{
              fontSize: '0.82rem',
              fontWeight: 500,
              color: entry.isMe ? 'var(--text)' : 'var(--text-muted)',
              minWidth: 44,
              textAlign: 'right',
            }}
          >
            {Math.round(entry.percent)}%
          </span>
        </>
      )}

      {entry.currentStreak > 0 && (
        <span style={{ fontSize: 11, color: 'var(--text-body)', fontWeight: 500, minWidth: 30 }}>
          🔥{entry.currentStreak}
        </span>
      )}
    </div>
  );
}
