import { ArrowLeft, ArrowRight, PenLine } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Skeleton, UpMarker, useAsync } from '../components/ui';
import { api } from '../lib/api';
import type { CopilotStatus } from '../lib/types';

/**
 * The fork in the road for goal creation.
 *
 * Manual creation is always available and always complete on its own — the AI is
 * an option, never a requirement. If the Copilot is not configured, this screen
 * simply does not offer it.
 */
export default function CreateGoalChoice() {
  const navigate = useNavigate();
  const { data, loading } = useAsync(() => api.get<CopilotStatus>('/copilot/status'), []);

  return (
    <div className="product-page goal-choice-page">
      <Link
        to="/app/goals"
        className="flex items-center gap-2 mb-6"
        style={{ color: 'var(--text-muted)', fontSize: '0.875rem', fontWeight: 400 }}
      >
        <ArrowLeft size={15} /> Back to goals
      </Link>

      <p className="product-eyebrow">Shape a new momentum trail</p>
      <h1
        style={{
          fontFamily: 'var(--font-sans)',
          fontWeight: 600,
          fontSize: 'clamp(2rem, 4vw, 2.6rem)',
          color: 'var(--text)',
          letterSpacing: '-0.02em',
        }}
      >
        How would you like to create your goal?
      </h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: 6, marginBottom: 26 }}>
        Start with a conversation or take direct control. You can inspect and change every detail before anything goes live.
      </p>

      {/* --------------------------------------------- resume an interview */}
      {!loading && data?.resumable?.length ? (
        <div className="mb-5">
          {data.resumable.slice(0, 2).map((session) => (
            <button
              key={session.id}
              onClick={() => navigate(`/app/goals/new/ai/${session.id}`)}
              className="card card-hover shadow-card w-full p-4 flex items-center gap-3 text-left mb-2"
              style={{ background: 'var(--surface-3)', borderColor: 'var(--hairline-strong)' }}
            >
              <span style={{ fontSize: 20 }} aria-hidden="true">
                ⏳
              </span>
              <span className="flex-1 min-w-0">
                <span
                  className="block truncate"
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontWeight: 500,
                    fontSize: '0.9rem',
                    color: 'var(--text)',
                  }}
                >
                  Continue “{session.initialGoalText}”
                </span>
                <span className="block" style={{ fontSize: '0.75rem', color: 'var(--text-body)' }}>
                  {session.questionCount} question{session.questionCount === 1 ? '' : 's'} answered
                </span>
              </span>
              <ArrowRight size={16} style={{ color: 'var(--text-muted)' }} />
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        {loading ? (
          <Skeleton height={150} radius={10} />
        ) : data?.enabled ? (
          <button
            onClick={() => navigate('/app/goals/new/ai')}
            className="creation-path creation-path--ai text-left"
            style={{ borderColor: 'var(--hairline-strong)' }}
          >
            <div className="flex items-start gap-4">
              <UpMarker size={52} />
              <span className="flex-1">
                <span
                  className="block"
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontWeight: 600,
                    fontSize: '1.1rem',
                    color: 'var(--text)',
                  }}
                >
                  Shape it with Copilot
                </span>
                <span
                  className="block mt-1.5"
                  style={{ fontSize: '0.88rem', color: 'var(--text-body)', lineHeight: 1.55 }}
                >
                  A short guided interview becomes an editable plan. You see why each task was chosen before you commit.
                </span>
              </span>
              <ArrowRight size={18} style={{ color: 'var(--text-muted)', marginTop: 4 }} />
            </div>
          </button>
        ) : null}

        <button
          onClick={() => navigate('/app/goals/new/manual')}
          className="creation-path creation-path--manual text-left"
        >
          <div className="flex items-start gap-4">
            <span
              className="flex items-center justify-center rounded-2xl flex-shrink-0"
              style={{ width: 52, height: 52, background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
            >
              <PenLine size={22} style={{ color: 'var(--text-body)' }} />
            </span>
            <span className="flex-1">
              <span
                className="block"
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontWeight: 600,
                  fontSize: '1.1rem',
                  color: 'var(--text)',
                }}
              >
                Create manually
              </span>
              <span
                className="block mt-1.5"
                style={{ fontSize: '0.88rem', color: 'var(--text-body)', lineHeight: 1.55 }}
              >
                Set the goal, tasks and schedule yourself. Full control, no questions asked.
              </span>
            </span>
            <ArrowRight size={18} style={{ color: 'var(--text-faint)', marginTop: 4 }} />
          </div>
        </button>
      </div>

      {!loading && !data?.enabled && (
        <p className="mt-5 text-center" style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>
          The AI Copilot isn't configured on this server, so goals are created manually.
        </p>
      )}
    </div>
  );
}
