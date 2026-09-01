import { Sparkles, X } from 'lucide-react';
import { Badge, Skeleton, useAsync, useToast } from './ui';
import { ApiError, api } from '../lib/api';
import { CATEGORY_LABEL, type GoalCategory } from '../lib/types';

interface StoredPreference {
  id: string;
  key: string;
  value: string;
  scope: 'GLOBAL' | 'CATEGORY';
  category: GoalCategory | null;
  confidence: number;
}

/** Turn `preferred_activity` / `walking` into something a person can read. */
function humanise(pref: StoredPreference) {
  const key = pref.key
    .replace(/^preferred_/, '')
    .replace(/^disliked_/, '')
    .replace(/_/g, ' ');
  const value = pref.value.replace(/_/g, ' ');
  const negative = pref.key.startsWith('disliked');
  return { label: `${key}: ${value}`, negative };
}

/**
 * "What Goalify remembers about you."
 *
 * The Copilot carries preferences between goals, so the user has to be able to
 * see exactly what it thinks it knows — and delete anything wrong or stale.
 * Invisible memory is how an assistant starts making confident, wrong guesses.
 */
export default function AiMemoryPanel() {
  const { push } = useToast();
  const { data, loading, reload } = useAsync(
    () => api.get<{ preferences: StoredPreference[] }>('/copilot/preferences'),
    [],
  );

  async function forget(pref: StoredPreference) {
    try {
      await api.del(`/copilot/preferences/${pref.id}`);
      push('Forgotten');
      reload();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not remove that', 'error');
    }
  }

  async function forgetAll() {
    if (!data?.preferences.length) return;
    if (!window.confirm('Forget everything the Copilot has learned about you?')) return;
    await Promise.all(
      data.preferences.map((p) => api.del(`/copilot/preferences/${p.id}`).catch(() => {})),
    );
    push('Cleared');
    reload();
  }

  // Group by category so the list reads as sections rather than a flat dump.
  const groups = new Map<string, StoredPreference[]>();
  for (const pref of data?.preferences ?? []) {
    const key = pref.scope === 'CATEGORY' && pref.category ? CATEGORY_LABEL[pref.category] : 'General';
    groups.set(key, [...(groups.get(key) ?? []), pref]);
  }

  return (
    <section className="mb-5">
      <div className="flex items-center justify-between mb-3">
        <h2
          className="flex items-center gap-2"
          style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: '1rem', color: 'var(--text)' }}
        >
          <Sparkles size={15} style={{ color: 'var(--text-muted)' }} />
          What the Copilot remembers
        </h2>
        {(data?.preferences.length ?? 0) > 0 && (
          <button
            onClick={forgetAll}
            className="text-sm"
            style={{ color: 'var(--red)', fontWeight: 500, fontFamily: 'var(--font-sans)' }}
          >
            Forget all
          </button>
        )}
      </div>

      <div className="card shadow-card p-4">
        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton height={30} />
            <Skeleton height={30} />
          </div>
        ) : (data?.preferences.length ?? 0) === 0 ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Nothing yet. As you create goals with the Copilot, it remembers durable
            preferences — like the activities you enjoy or when you prefer to work — and
            reuses them next time. You can delete any of them here.
          </p>
        ) : (
          <>
            {[...groups.entries()].map(([groupName, prefs]) => (
              <div key={groupName} className="mb-4 last:mb-0">
                <div
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 500,
                    color: 'var(--text-muted)',
                    letterSpacing: '0.06em',
                    fontFamily: 'var(--font-sans)',
                    marginBottom: 8,
                  }}
                >
                  {groupName.toUpperCase()}
                </div>
                <div className="flex flex-col gap-1.5">
                  {prefs.map((pref) => {
                    const { label, negative } = humanise(pref);
                    return (
                      <div
                        key={pref.id}
                        className="flex items-center gap-2.5 px-3 py-2 rounded-xl"
                        style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
                      >
                        <span aria-hidden="true" style={{ fontSize: 13 }}>
                          {negative ? '✕' : '✓'}
                        </span>
                        <span
                          className="flex-1 min-w-0 truncate"
                          style={{ fontSize: '0.85rem', color: 'var(--text)' }}
                        >
                          {label}
                        </span>
                        {pref.confidence < 0.85 && <Badge tone="neutral">unsure</Badge>}
                        <button
                          onClick={() => forget(pref)}
                          aria-label={`Forget ${label}`}
                          title="Forget this"
                          className="flex items-center justify-center rounded-lg flex-shrink-0"
                          style={{ width: 28, height: 28, color: 'var(--text-faint)' }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="mt-3" style={{ fontSize: '0.75rem', color: 'var(--text-faint)', lineHeight: 1.5 }}>
              These carry over to new goals so the Copilot does not ask the same things
              twice. Delete anything that is wrong or no longer true.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
