import { useState } from 'react';
import { Download, Pencil, Trash2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import {
  Avatar,
  Badge,
  ErrorState,
  Modal,
  PrivacyBadge,
  ProgressBar,
  Skeleton,
  useAsync,
  useToast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import AiMemoryPanel from '../components/AiMemoryPanel';
import RegistrationIpPanel from '../components/RegistrationIpPanel';
import { CATEGORY_EMOJI, type CurrentUser, type GoalCategory, type PublicProfile } from '../lib/types';

interface ProfileGoal {
  id: string;
  title: string;
  category: GoalCategory;
  status: string;
  visibility: 'PRIVATE' | 'PUBLIC';
  progress: number;
  streak: number;
}

interface ProfileResponse {
  // Another user's profile omits the private fields, so the public shape is what
  // this screen is allowed to rely on.
  user: PublicProfile | null;
  isSelf: boolean;
  activeGoals: ProfileGoal[];
  completedGoals: ProfileGoal[];
  hiddenPrivateGoals: number;
  achievements: Array<{
    code: string;
    title: string;
    description: string;
    icon: string;
    unlockedAt: string;
  }>;
}

const EMOJI_CHOICES = ['🐱', '🦊', '🐼', '🐧', '🦉', '🐨', '🐯', '🦁', '🐸', '🐙', '🦄', '🐝'];

export default function Profile() {
  const { id } = useParams();
  const { data, loading, error, reload } = useAsync(
    () => api.get<ProfileResponse>(id ? `/users/${id}` : '/profile'),
    [id],
  );
  const [editing, setEditing] = useState(false);
  const { logout, user: currentUser } = useAuth();
  const { push } = useToast();

  async function exportData() {
    try {
      const data = await api.get<unknown>('/account/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `one-up-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      push('Your data export is ready');
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not export your data', 'error');
    }
  }

  async function deleteAccount() {
    if (!window.confirm('Permanently delete your account and all of its data? This cannot be undone.')) return;
    if (!window.confirm('Are you absolutely sure? Your goals and progress will be permanently deleted.')) return;
    try {
      await api.del('/account');
      await logout().catch(() => undefined);
      window.location.assign('/');
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not delete your account', 'error');
    }
  }

  if (loading) {
    return (
      <div className="p-5 sm:p-6 lg:p-8 max-w-3xl mx-auto flex flex-col gap-4">
        <Skeleton height={150} radius={10} />
        <Skeleton height={200} radius={10} />
      </div>
    );
  }

  if (error || !data?.user) {
    return (
      <div className="p-5 sm:p-6 lg:p-8 max-w-3xl mx-auto">
        <ErrorState message={error ?? 'That profile is not available'} onRetry={reload} />
      </div>
    );
  }

  const { user, isSelf, activeGoals, completedGoals, achievements, hiddenPrivateGoals } = data;

  return (
    <div className="p-5 sm:p-6 lg:p-8 max-w-3xl mx-auto">
      {/* ------------------------------------------------------- header */}
      <div className="card shadow-card p-5 sm:p-6 mb-5">
        <div className="flex items-start gap-4">
          <Avatar emoji={user.avatarEmoji} size={64} ring />
          <div className="flex-1 min-w-0">
            <h1
              className="truncate"
              style={{
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
                fontSize: 'clamp(1.25rem, 2.5vw, 1.55rem)',
                color: 'var(--text)',
                letterSpacing: '-0.02em',
              }}
            >
              {user.name}
            </h1>
            {user.bio && (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-body)', marginTop: 4, lineHeight: 1.55 }}>
                {user.bio}
              </p>
            )}
            <div className="flex items-center gap-2 mt-2.5 flex-wrap">
              <Badge tone="primary">Level {user.level}</Badge>
              <Badge tone="warning">🪙 {user.totalCoins.toLocaleString()}</Badge>
              {user.bestStreak > 0 && <Badge tone="neutral">🔥 Best {user.bestStreak}</Badge>}
            </div>
          </div>
          {isSelf && (
            <button
              className="btn-ghost flex items-center gap-2 px-3.5 py-2 text-sm flex-shrink-0"
              onClick={() => setEditing(true)}
            >
              <Pencil size={14} /> <span className="hidden sm:inline">Edit</span>
            </button>
          )}
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between mb-1.5">
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500 }}>
              Level {user.level}
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {user.intoLevel} / {user.perLevel} to level {user.level + 1}
            </span>
          </div>
          <ProgressBar value={user.percent} height={8} />
        </div>
      </div>

      {/* -------------------------------------------------------- goals */}
      <Section title={isSelf ? 'Active goals' : 'Public goals'}>
        {activeGoals.length > 0 ? (
          <div className="flex flex-col gap-2">
            {activeGoals.map((goal) => (
              <ProfileGoalRow key={goal.id} goal={goal} />
            ))}
          </div>
        ) : (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            {isSelf ? 'No active goals yet.' : 'No public goals to show.'}
          </p>
        )}
        {hiddenPrivateGoals > 0 && (
          <p className="mt-3" style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>
            🔒 {hiddenPrivateGoals} private{' '}
            {hiddenPrivateGoals === 1 ? 'goal is' : 'goals are'} hidden.
          </p>
        )}
      </Section>

      {completedGoals.length > 0 && (
        <Section title="Completed goals">
          <div className="flex flex-col gap-2">
            {completedGoals.map((goal) => (
              <ProfileGoalRow key={goal.id} goal={goal} />
            ))}
          </div>
        </Section>
      )}

      {/* ------------------------------------------------- achievements */}
      <Section title="Achievements">
        {achievements.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {achievements.map((a) => (
              <div
                key={a.code}
                className="rounded-xl p-3.5 text-center"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
                title={a.description}
              >
                <div style={{ fontSize: 24 }} aria-hidden="true">
                  {a.icon}
                </div>
                <div
                  className="mt-1.5"
                  style={{
                    fontSize: '0.78rem',
                    fontWeight: 500,
                    color: 'var(--text)',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  {a.title}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            {isSelf ? 'Complete your first task to start unlocking these.' : 'No achievements yet.'}
          </p>
        )}
      </Section>

      {/* Only ever shown on your own profile — this is your data, not public. */}
      {isSelf && <AiMemoryPanel />}
      {isSelf && currentUser?.isAdmin && <RegistrationIpPanel />}

      {isSelf && (
        <Section title="Your data">
          <div className="flex flex-col sm:flex-row gap-2">
            <button className="btn-ghost flex items-center justify-center gap-2 px-4 py-2.5 text-sm" onClick={exportData}>
              <Download size={15} /> Export my data
            </button>
            <button className="btn-ghost flex items-center justify-center gap-2 px-4 py-2.5 text-sm" style={{ color: 'var(--red)' }} onClick={deleteAccount}>
              <Trash2 size={15} /> Delete account
            </button>
            <a className="btn-ghost flex items-center justify-center px-4 py-2.5 text-sm" href="mailto:support@goalify.app">
              Contact support
            </a>
          </div>
        </Section>
      )}

      {isSelf && <EditProfileModal open={editing} onClose={() => setEditing(false)} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2
        className="mb-3"
        style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: '1rem', color: 'var(--text)' }}
      >
        {title}
      </h2>
      <div className="card shadow-card p-4">{children}</div>
    </section>
  );
}

function ProfileGoalRow({ goal }: { goal: ProfileGoal }) {
  return (
    <Link to={`/app/goals/${goal.id}`} className="flex items-center gap-3 px-2 py-2.5 rounded-xl">
      <span style={{ fontSize: 19 }} aria-hidden="true">
        {CATEGORY_EMOJI[goal.category]}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="truncate"
            style={{
              fontSize: '0.88rem',
              fontWeight: 500,
              color: 'var(--text)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {goal.title}
          </span>
          <PrivacyBadge visibility={goal.visibility} />
        </div>
        <div className="mt-1.5">
          <ProgressBar value={goal.progress} height={4} />
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)' }}>
          {Math.round(goal.progress)}%
        </div>
        {goal.streak > 0 && (
          <div style={{ fontSize: '0.7rem', color: 'var(--text-body)', fontWeight: 500 }}>🔥{goal.streak}</div>
        )}
      </div>
    </Link>
  );
}

function EditProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, setUser } = useAuth();
  const { push } = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [avatarEmoji, setAvatarEmoji] = useState(user?.avatarEmoji ?? '🐱');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const result = await api.patch<{ user: CurrentUser }>('/profile', { name, bio, avatarEmoji });
      setUser(result.user);
      push('Profile updated');
      onClose();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit profile"
      footer={
        <>
          <button className="btn-ghost px-4 py-2.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary px-4 py-2.5 text-sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <label htmlFor="profile-name" style={labelStyle}>
        Name
      </label>
      <input
        id="profile-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full px-4 py-3 text-sm mb-4"
      />

      <label htmlFor="profile-bio" style={labelStyle}>
        Bio
      </label>
      <textarea
        id="profile-bio"
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        rows={3}
        placeholder="A line about what you're working on."
        className="w-full px-4 py-3 text-sm resize-none mb-4"
      />

      <label style={labelStyle}>Avatar</label>
      <div className="flex flex-wrap gap-2">
        {EMOJI_CHOICES.map((emoji) => (
          <button
            key={emoji}
            onClick={() => setAvatarEmoji(emoji)}
            aria-pressed={avatarEmoji === emoji}
            aria-label={`Avatar ${emoji}`}
            className="rounded-xl flex items-center justify-center"
            style={{
              width: 44,
              height: 44,
              fontSize: 20,
              background: avatarEmoji === emoji ? 'var(--surface-3)' : 'var(--surface-2)',
              border: `1px solid ${avatarEmoji === emoji ? 'var(--accent)' : 'var(--hairline)'}`,
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
    </Modal>
  );
}

const labelStyle = {
  fontSize: '0.8rem',
  fontWeight: 500,
  color: 'var(--text-body)',
  display: 'block',
  marginBottom: 6,
  fontFamily: 'var(--font-sans)',
} as const;
