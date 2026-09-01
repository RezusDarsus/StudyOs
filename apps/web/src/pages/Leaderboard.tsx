import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import LeaderboardPanel from '../components/LeaderboardPanel';
import { EmptyState, ErrorState, Skeleton, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { CATEGORY_EMOJI, type GoalSummary } from '../lib/types';

/**
 * Leaderboards live inside the challenge they belong to. This page is a shortcut
 * to them, not a separate global ranking — there is deliberately no worldwide
 * board in Phase 1.
 */
export default function Leaderboard() {
  const { data, loading, error, reload } = useAsync(
    () => api.get<{ goals: GoalSummary[] }>('/goals?status=ACTIVE'),
    [],
  );

  const shared = data?.goals.filter((g) => g.participantCount > 1) ?? [];
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!selected && shared.length > 0) setSelected(shared[0].id);
  }, [shared, selected]);

  return (
    <div className="p-5 sm:p-6 lg:p-8 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1
          style={{
            fontFamily: 'var(--font-sans)',
            fontWeight: 600,
            fontSize: 'clamp(1.4rem, 2.5vw, 1.75rem)',
            color: 'var(--text)',
            letterSpacing: '-0.02em',
          }}
        >
          Leaderboard
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: 4 }}>
          See how you're doing against everyone in your shared challenges.
        </p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton height={44} radius={10} />
          <Skeleton height={240} radius={10} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : shared.length === 0 ? (
        <EmptyState
          emoji="🏆"
          title="No shared challenges yet"
          body="Leaderboards appear once you're in a goal with other people. Invite a friend to one of your goals, or join a public challenge."
          action={
            <Link to="/app/discover" className="btn-primary inline-block px-5 py-2.5 text-sm">
              Browse challenges
            </Link>
          }
        />
      ) : (
        <>
          <div className="flex gap-2 mb-5 overflow-x-auto pb-1" role="group" aria-label="Choose a challenge">
            {shared.map((goal) => {
              const active = selected === goal.id;
              return (
                <button
                  key={goal.id}
                  onClick={() => setSelected(goal.id)}
                  aria-pressed={active}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-xl whitespace-nowrap"
                  style={{
                    background: active ? 'var(--surface-3)' : 'var(--surface)',
                    border: `1px solid ${active ? 'var(--hairline-strong)' : 'var(--hairline)'}`,
                    color: active ? 'var(--text)' : 'var(--text-body)',
                    fontWeight: 500,
                    fontSize: '0.82rem',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <span aria-hidden="true">{CATEGORY_EMOJI[goal.category]}</span>
                  {goal.title}
                </button>
              );
            })}
          </div>

          {selected && <LeaderboardPanel goalId={selected} />}

          {selected && (
            <div className="text-center mt-4">
              <Link
                to={`/app/goals/${selected}`}
                className="text-sm"
                style={{ color: 'var(--text)', fontWeight: 500, fontFamily: 'var(--font-sans)' }}
              >
                Open challenge →
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}
