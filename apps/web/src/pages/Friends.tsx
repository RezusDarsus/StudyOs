import { useState } from 'react';
import { Check, Search, UserMinus, UserPlus, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Avatar, Badge, EmptyState, ErrorState, Skeleton, useAsync, useToast } from '../components/ui';
import { ApiError, api } from '../lib/api';
import type { Friend, FriendState } from '../lib/types';

interface SearchResult {
  id: string;
  name: string;
  avatarEmoji: string;
  level: number;
  state: FriendState;
  friendshipId: string | null;
}

interface RequestRow {
  id: string;
  user: { id: string; name: string; avatarEmoji: string; level: number };
  createdAt: string;
}

interface Invitation {
  id: string;
  goal: { id: string; title: string; description: string; participantCount: number };
  inviter: { id: string; name: string; avatarEmoji: string };
}

export default function Friends() {
  const { push } = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const friends = useAsync(() => api.get<{ friends: Friend[] }>('/friends'), []);
  const requests = useAsync(
    () => api.get<{ incoming: RequestRow[]; outgoing: RequestRow[] }>('/friend-requests'),
    [],
  );
  const invitations = useAsync(
    () => api.get<{ invitations: Invitation[] }>('/goal-invitations'),
    [],
  );

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const data = await api.get<{ users: SearchResult[] }>(
        `/friends/search?q=${encodeURIComponent(q)}`,
      );
      setResults(data.users);
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Search failed', 'error');
    } finally {
      setSearching(false);
    }
  }

  async function act(fn: () => Promise<unknown>, message: string) {
    try {
      await fn();
      push(message);
      friends.reload();
      requests.reload();
      invitations.reload();
      if (results) setResults(null);
      setQuery('');
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Something went wrong', 'error');
    }
  }

  return (
    <div className="p-5 sm:p-6 lg:p-8 max-w-4xl mx-auto">
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
          Friends
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: 4 }}>
          Productivity is better together.
        </p>
      </div>

      <form className="relative mb-6" onSubmit={search}>
        <Search
          size={17}
          className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none"
          style={{ color: 'var(--text-faint)' }}
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email"
          aria-label="Search for people"
          className="w-full pl-11 pr-4 py-3 text-sm"
        />
      </form>

      {/* --------------------------------------------------- search results */}
      {searching && <Skeleton height={70} radius={10} />}
      {results && !searching && (
        <section className="mb-7">
          <h2 className="mb-3" style={sectionTitle}>
            Search results
          </h2>
          {results.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Nobody matched that. Try their exact email address.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {results.map((user) => (
                <div key={user.id} className="card shadow-card flex items-center gap-3 p-3.5">
                  <Avatar emoji={user.avatarEmoji} size={38} />
                  <div className="flex-1 min-w-0">
                    <div className="truncate" style={nameStyle}>
                      {user.name}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>Level {user.level}</div>
                  </div>
                  {user.state === 'NONE' && (
                    <button
                      className="btn-secondary px-3.5 py-2 text-sm flex items-center gap-1.5"
                      onClick={() => act(() => api.post('/friend-requests', { userId: user.id }), 'Request sent')}
                    >
                      <UserPlus size={14} /> Add
                    </button>
                  )}
                  {user.state === 'REQUEST_SENT' && <Badge tone="neutral">Request sent</Badge>}
                  {user.state === 'FRIENDS' && <Badge tone="primary">Friends</Badge>}
                  {user.state === 'REQUEST_RECEIVED' && user.friendshipId && (
                    <button
                      className="btn-primary px-3.5 py-2 text-sm"
                      onClick={() =>
                        act(
                          () => api.post(`/friend-requests/${user.friendshipId}/accept`),
                          'You are now friends',
                        )
                      }
                    >
                      Accept
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ------------------------------------------------- goal invitations */}
      {invitations.data && invitations.data.invitations.length > 0 && (
        <section className="mb-7">
          <h2 className="mb-3" style={sectionTitle}>
            Goal invitations
          </h2>
          <div className="flex flex-col gap-2">
            {invitations.data.invitations.map((invite) => (
              <div key={invite.id} className="card shadow-card p-4">
                <div className="flex items-center gap-3 mb-3">
                  <Avatar emoji={invite.inviter.avatarEmoji} size={36} />
                  <div className="min-w-0">
                    <div style={{ fontSize: '0.88rem', color: 'var(--text)' }}>
                      <strong style={{ fontFamily: 'var(--font-sans)' }}>{invite.inviter.name}</strong>{' '}
                      invited you to
                    </div>
                    <div className="truncate" style={nameStyle}>
                      {invite.goal.title}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    className="btn-primary flex-1 py-2.5 text-sm"
                    onClick={() => act(() => api.post(`/goal-invitations/${invite.id}/accept`), 'Joined 🎉')}
                  >
                    Join
                  </button>
                  <button
                    className="btn-ghost flex-1 py-2.5 text-sm"
                    onClick={() => act(() => api.post(`/goal-invitations/${invite.id}/decline`), 'Declined')}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ----------------------------------------------- incoming requests */}
      {requests.data && requests.data.incoming.length > 0 && (
        <section className="mb-7">
          <h2 className="mb-3" style={sectionTitle}>
            Friend requests
          </h2>
          <div className="flex flex-col gap-2">
            {requests.data.incoming.map((request) => (
              <div key={request.id} className="card shadow-card flex items-center gap-3 p-3.5">
                <Avatar emoji={request.user.avatarEmoji} size={38} />
                <div className="flex-1 min-w-0">
                  <div className="truncate" style={nameStyle}>
                    {request.user.name}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>
                    Level {request.user.level}
                  </div>
                </div>
                <button
                  aria-label={`Accept request from ${request.user.name}`}
                  className="btn-primary flex items-center justify-center"
                  style={{ width: 38, height: 38 }}
                  onClick={() =>
                    act(() => api.post(`/friend-requests/${request.id}/accept`), 'You are now friends')
                  }
                >
                  <Check size={16} />
                </button>
                <button
                  aria-label={`Decline request from ${request.user.name}`}
                  className="btn-ghost flex items-center justify-center"
                  style={{ width: 38, height: 38 }}
                  onClick={() => act(() => api.post(`/friend-requests/${request.id}/decline`), 'Declined')}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------ friend list */}
      <section>
        <h2 className="mb-3" style={sectionTitle}>
          Your friends
        </h2>

        {friends.loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton height={70} radius={10} />
            <Skeleton height={70} radius={10} />
          </div>
        ) : friends.error ? (
          <ErrorState message={friends.error} onRetry={friends.reload} />
        ) : friends.data && friends.data.friends.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {friends.data.friends.map((friend) => (
              <div key={friend.id} className="card shadow-card p-4 flex items-center gap-3">
                <Link to={`/app/profile/${friend.id}`}>
                  <Avatar emoji={friend.avatarEmoji} size={44} />
                </Link>
                <div className="flex-1 min-w-0">
                  <Link to={`/app/profile/${friend.id}`} className="truncate block" style={nameStyle}>
                    {friend.name}
                  </Link>
                  <div className="flex items-center gap-2.5 mt-1 flex-wrap">
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Lv.{friend.level}</span>
                    {friend.currentStreak > 0 && (
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-body)', fontWeight: 500 }}>
                        🔥 {friend.currentStreak}
                      </span>
                    )}
                    <span style={{ fontSize: '0.72rem', color: 'var(--text)', fontWeight: 500 }}>
                      {friend.sharedGoals} shared
                    </span>
                  </div>
                </div>
                <button
                  aria-label={`Remove ${friend.name}`}
                  title="Remove friend"
                  className="flex items-center justify-center rounded-lg flex-shrink-0"
                  style={{ width: 34, height: 34, color: 'var(--text-faint)', border: '1px solid var(--hairline)' }}
                  onClick={() => {
                    if (window.confirm(`Remove ${friend.name} from your friends?`)) {
                      act(() => api.del(`/friends/${friend.id}`), 'Friend removed');
                    }
                  }}
                >
                  <UserMinus size={15} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            emoji="👋"
            title="Productivity is better together."
            body="Invite friends and start improving together. Search for someone by name or email above."
          />
        )}
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

const nameStyle = {
  fontFamily: 'var(--font-sans)',
  fontWeight: 500,
  fontSize: '0.9rem',
  color: 'var(--text)',
} as const;
