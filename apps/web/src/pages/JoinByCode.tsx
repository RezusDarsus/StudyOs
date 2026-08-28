import { useEffect, useState } from 'react';
import { ArrowRight, Users, Zap } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ErrorState, Skeleton, useAsync, useToast } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CATEGORY_EMOJI, CATEGORY_LABEL, type GoalCategory } from '../lib/types';

interface JoinPreview {
  goal: {
    id: string;
    title: string;
    description: string;
    category: GoalCategory;
    visibility: 'PRIVATE' | 'PUBLIC';
    participantCount: number;
    taskCount: number;
    startDate: string;
    deadline: string | null;
    ownerName: string;
    ownerAvatar: string;
  };
  alreadyJoined: boolean;
}

const PENDING_KEY = 'goalify:pendingJoinCode';

/**
 * The landing page for a shared invite link.
 *
 * Works signed out — someone arriving from Facebook can see what they're being
 * invited to before deciding to sign up. The code is stashed so that after
 * registering they land straight back here and join in one tap.
 */
export default function JoinByCode() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { push } = useToast();
  const [joining, setJoining] = useState(false);

  const { data, loading, error } = useAsync(
    () => api.get<JoinPreview>(`/join/${encodeURIComponent(code)}`),
    [code],
  );

  // After signing in, finish the join automatically.
  useEffect(() => {
    if (!user || authLoading) return;
    if (sessionStorage.getItem(PENDING_KEY) === code) {
      sessionStorage.removeItem(PENDING_KEY);
      void join();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authLoading, code]);

  async function join() {
    if (!user) {
      sessionStorage.setItem(PENDING_KEY, code);
      navigate('/register');
      return;
    }
    setJoining(true);
    try {
      const result = await api.post<{ goalId: string; alreadyJoined: boolean }>(
        `/join/${encodeURIComponent(code)}`,
      );
      push(result.alreadyJoined ? "You're already in this one" : 'You joined 🎉');
      navigate(`/app/goals/${result.goalId}`, { replace: true });
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not join', 'error');
    } finally {
      setJoining(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-10"
      style={{ background: '#f5f4ff' }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at 50% 0%, rgba(124,58,237,0.08) 0%, transparent 60%)',
        }}
      />

      <div className="w-full max-w-md relative">
        <Link to="/" className="flex items-center justify-center gap-2.5 mb-7">
          <div
            className="flex items-center justify-center rounded-xl"
            style={{
              width: 36,
              height: 36,
              background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
              boxShadow: '0 4px 12px rgba(124,58,237,0.35)',
            }}
          >
            <Zap size={18} fill="white" color="white" />
          </div>
          <span
            style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1.1rem', color: '#1a1635' }}
          >
            One Up
          </span>
        </Link>

        {loading ? (
          <div className="card shadow-card-lg p-6 flex flex-col gap-3">
            <Skeleton height={28} width="70%" />
            <Skeleton height={60} />
            <Skeleton height={44} radius={12} />
          </div>
        ) : error ? (
          <>
            <ErrorState message={error} />
            <div className="text-center mt-4">
              <Link to="/" className="btn-ghost inline-block px-5 py-2.5 text-sm">
                Go to One Up
              </Link>
            </div>
          </>
        ) : data ? (
          <div className="card shadow-card-lg p-6">
            <p
              className="text-center mb-5"
              style={{ fontSize: '0.85rem', color: '#8b88b0' }}
            >
              <span aria-hidden="true">{data.goal.ownerAvatar}</span>{' '}
              <strong style={{ color: '#1a1635', fontFamily: 'Plus Jakarta Sans' }}>
                {data.goal.ownerName}
              </strong>{' '}
              invited you to join
            </p>

            <div className="flex items-start gap-3.5 mb-4">
              <div
                className="flex items-center justify-center rounded-2xl flex-shrink-0"
                style={{
                  width: 52,
                  height: 52,
                  fontSize: 24,
                  background: '#f0ebff',
                  border: '1px solid #ddd0ff',
                }}
                aria-hidden="true"
              >
                {CATEGORY_EMOJI[data.goal.category]}
              </div>
              <div className="min-w-0">
                <h1
                  style={{
                    fontFamily: 'Plus Jakarta Sans',
                    fontWeight: 800,
                    fontSize: '1.35rem',
                    color: '#1a1635',
                    letterSpacing: '-0.02em',
                    lineHeight: 1.25,
                  }}
                >
                  {data.goal.title}
                </h1>
                <div style={{ fontSize: '0.78rem', color: '#8b88b0', marginTop: 3 }}>
                  {CATEGORY_LABEL[data.goal.category]}
                </div>
              </div>
            </div>

            {data.goal.description && (
              <p className="mb-4" style={{ fontSize: '0.88rem', color: '#6b688f', lineHeight: 1.6 }}>
                {data.goal.description}
              </p>
            )}

            <div
              className="flex items-center gap-4 mb-5 px-3.5 py-3 rounded-xl flex-wrap"
              style={{ background: '#f5f4ff', border: '1px solid #e8e6f5' }}
            >
              <span
                className="flex items-center gap-1.5"
                style={{ fontSize: '0.8rem', color: '#4b4870', fontWeight: 600 }}
              >
                <Users size={14} /> {data.goal.participantCount}{' '}
                {data.goal.participantCount === 1 ? 'person' : 'people'}
              </span>
              <span style={{ fontSize: '0.8rem', color: '#4b4870', fontWeight: 600 }}>
                {data.goal.taskCount} {data.goal.taskCount === 1 ? 'task' : 'tasks'}
              </span>
              {data.goal.deadline && (
                <span style={{ fontSize: '0.8rem', color: '#4b4870', fontWeight: 600 }}>
                  until {data.goal.deadline}
                </span>
              )}
            </div>

            {data.alreadyJoined ? (
              <button
                className="btn-secondary w-full py-3.5 text-sm"
                onClick={() => navigate(`/app/goals/${data.goal.id}`)}
              >
                You're already in — open it
              </button>
            ) : (
              <button
                className="btn-primary w-full py-3.5 text-sm flex items-center justify-center gap-2"
                onClick={join}
                disabled={joining}
              >
                {joining ? 'Joining…' : user ? 'Join this goal' : 'Sign up & join'}
                {!joining && <ArrowRight size={15} />}
              </button>
            )}

            {!user && (
              <p className="text-center mt-4" style={{ fontSize: '0.8rem', color: '#8b88b0' }}>
                Already have an account?{' '}
                <Link
                  to="/login"
                  onClick={() => sessionStorage.setItem(PENDING_KEY, code)}
                  style={{ color: '#7c3aed', fontWeight: 700, fontFamily: 'Plus Jakarta Sans' }}
                >
                  Log in
                </Link>
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Small entry point so someone can type a code they were given verbally. */
export function EnterCodeCard() {
  const [code, setCode] = useState('');
  const navigate = useNavigate();

  return (
    <form
      className="card shadow-card p-4 flex flex-col sm:flex-row sm:items-center gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (clean) navigate(`/join/${clean}`);
      }}
    >
      <div className="flex-1">
        <div
          style={{
            fontFamily: 'Plus Jakarta Sans',
            fontWeight: 700,
            fontSize: '0.9rem',
            color: '#1a1635',
          }}
        >
          Have an invite code?
        </div>
        <div style={{ fontSize: '0.78rem', color: '#8b88b0', marginTop: 2 }}>
          Enter it to join a friend's goal.
        </div>
      </div>
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABCD2345"
          aria-label="Invite code"
          maxLength={12}
          className="px-3.5 py-2.5 text-sm"
          style={{
            width: 150,
            letterSpacing: '0.14em',
            fontFamily: 'Plus Jakarta Sans',
            fontWeight: 700,
            textTransform: 'uppercase',
          }}
        />
        <button type="submit" className="btn-secondary px-4 py-2.5 text-sm">
          Join
        </button>
      </div>
    </form>
  );
}
