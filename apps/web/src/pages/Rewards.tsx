import { ErrorState, ProgressBar, Skeleton, useAsync } from '../components/ui';
import { api } from '../lib/api';
import type { Achievement } from '../lib/types';

interface RewardsResponse {
  level: number;
  intoLevel: number;
  perLevel: number;
  percent: number;
  totalCoins: number;
  transactions: Array<{
    id: string;
    amount: number;
    reason: string;
    goalTitle: string | null;
    createdAt: string;
  }>;
  achievements: Achievement[];
}

const REASON_LABEL: Record<string, string> = {
  TASK_COMPLETED: 'Task completed',
  TASK_UNDONE: 'Task undone',
  ACHIEVEMENT: 'Achievement unlocked',
  GOAL_COMPLETED: 'Goal completed',
};

export default function Rewards() {
  const { data, loading, error, reload } = useAsync(() => api.get<RewardsResponse>('/rewards'), []);

  if (loading) {
    return (
      <div className="p-5 sm:p-6 lg:p-8 max-w-3xl mx-auto flex flex-col gap-4">
        <Skeleton height={140} radius={10} />
        <Skeleton height={220} radius={10} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-5 sm:p-6 lg:p-8 max-w-3xl mx-auto">
        <ErrorState message={error ?? 'Could not load rewards'} onRetry={reload} />
      </div>
    );
  }

  const unlocked = data.achievements.filter((a) => a.unlockedAt);
  const locked = data.achievements.filter((a) => !a.unlockedAt);

  return (
    <div className="p-5 sm:p-6 lg:p-8 max-w-3xl mx-auto">
      <h1
        className="mb-6"
        style={{
          fontFamily: 'var(--font-sans)',
          fontWeight: 600,
          fontSize: 'clamp(1.4rem, 2.5vw, 1.75rem)',
          color: 'var(--text)',
          letterSpacing: '-0.02em',
        }}
      >
        Rewards
      </h1>

      {/* ------------------------------------------------------- balance */}
      <div
        className="rounded-2xl p-6 mb-6 shadow-card"
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--hairline-strong)',
        }}
      >
        <div className="flex items-center gap-3 mb-4">
          <span style={{ fontSize: 34 }} aria-hidden="true">
            🪙
          </span>
          <div>
            <div
              style={{
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
                fontSize: '2rem',
                color: 'var(--text)',
                letterSpacing: '-0.042em',
                lineHeight: 1,
              }}
            >
              {data.totalCoins.toLocaleString()}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-body)', marginTop: 2 }}>coins earned</div>
          </div>
        </div>

        <div className="flex items-center justify-between mb-1.5">
          <span style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--text)' }}>
            Level {data.level}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {data.intoLevel} / {data.perLevel} to level {data.level + 1}
          </span>
        </div>
        <ProgressBar value={data.percent} height={10} />
      </div>

      {/* -------------------------------------------------- achievements */}
      <section className="mb-6">
        <h2 className="mb-3" style={sectionTitle}>
          Achievements ({unlocked.length}/{data.achievements.length})
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[...unlocked, ...locked].map((a) => {
            const isUnlocked = Boolean(a.unlockedAt);
            return (
              <div
                key={a.code}
                className="card p-4 text-center"
                style={{
                  background: isUnlocked ? 'var(--surface)' : 'var(--surface-2)',
                  borderColor: isUnlocked ? 'var(--hairline-strong)' : 'var(--hairline)',
                  opacity: isUnlocked ? 1 : 0.65,
                }}
              >
                <div style={{ fontSize: 28, filter: isUnlocked ? 'none' : 'grayscale(1)' }} aria-hidden="true">
                  {a.icon}
                </div>
                <div
                  className="mt-2"
                  style={{
                    fontSize: '0.82rem',
                    fontWeight: 500,
                    color: 'var(--text)',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  {a.title}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
                  {a.description}
                </div>
                <div
                  className="mt-2"
                  style={{ fontSize: '0.72rem', fontWeight: 500, color: isUnlocked ? 'var(--green)' : 'var(--text-faint)' }}
                >
                  {/* Locked/unlocked is stated in words, not just by dimming. */}
                  {isUnlocked ? '✓ Unlocked' : `Locked · +${a.reward}🪙`}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------------------------------------------------- history */}
      <section>
        <h2 className="mb-3" style={sectionTitle}>
          Recent activity
        </h2>
        <div className="card shadow-card p-2">
          {data.transactions.length === 0 ? (
            <p className="px-3 py-4" style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Complete a task to start earning.
            </p>
          ) : (
            data.transactions.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: '0.85rem', color: 'var(--text)' }}>
                    {REASON_LABEL[t.reason] ?? t.reason}
                  </div>
                  {t.goalTitle && (
                    <div className="truncate" style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>
                      {t.goalTitle}
                    </div>
                  )}
                </div>
                <span
                  style={{
                    fontSize: '0.82rem',
                    fontWeight: 500,
                    color: t.amount >= 0 ? 'var(--green)' : 'var(--red)',
                  }}
                >
                  {t.amount >= 0 ? '+' : ''}
                  {t.amount}🪙
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

const sectionTitle = {
  fontFamily: 'var(--font-sans)',
  fontWeight: 500,
  fontSize: '1rem',
  color: 'var(--text)',
} as const;
