import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, Skeleton, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useNotifications } from '../lib/notifications';
import type { CurrentUser, Notification } from '../lib/types';

const ICONS: Record<Notification['type'], string> = {
  REMINDER: '⏰',
  FRIEND: '👥',
  PROGRESS: '📈',
  LEADERBOARD: '🏆',
  ACHIEVEMENT: '🎖️',
  MORNING_SUMMARY: '🌅',
  EVENING_INCOMPLETE: '🌙',
};

type TimeKey = 'morningTime' | 'eveningTime';

const SETTINGS = [
  { key: 'taskReminders', label: 'Task reminders' },
  { key: 'morningSummary', label: 'Morning summary', time: 'morningTime' as TimeKey },
  { key: 'eveningCheck', label: 'Evening check-in', time: 'eveningTime' as TimeKey },
  { key: 'friendActivity', label: 'Friend activity' },
  { key: 'leaderboardUpdates', label: 'Leaderboard updates' },
  { key: 'achievements', label: 'Achievements' },
] as const;

function timeAgo(iso: string) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

export default function Notifications() {
  const { notifications, unread, loading, error, live, reload, markRead } = useNotifications();

  // Which rows were unread when the user looked at them. Opening this page is the read
  // receipt, and clearing the badge that instant is the point — but it would also erase the
  // only cue for what is new, so remember it here and keep highlighting those rows.
  const seenUnread = useRef(new Set<string>());

  useEffect(() => {
    if (unread === 0) return;
    for (const n of notifications) if (!n.readAt) seenUnread.current.add(n.id);
    void markRead();
  }, [unread, notifications, markRead]);

  return (
    <div className="p-5 sm:p-6 lg:p-8 max-w-2xl mx-auto">
      <div className="flex items-baseline justify-between gap-3 mb-6">
        <h1
          style={{
            fontFamily: 'Plus Jakarta Sans',
            fontWeight: 800,
            fontSize: 'clamp(1.4rem, 2.5vw, 1.75rem)',
            color: '#1a1635',
            letterSpacing: '-0.02em',
          }}
        >
          Notifications
        </h1>
        {/* Both states are normal, so both get words. A dot on its own would leave a
            colour-blind reader guessing, and "offline" would overstate a missing socket. */}
        <span
          className="flex items-center gap-1.5 flex-shrink-0"
          style={{ fontSize: '0.72rem', color: '#8b88b0' }}
        >
          <span
            className="rounded-full"
            style={{ width: 6, height: 6, background: live ? '#22c55e' : '#c9c6e0' }}
            aria-hidden="true"
          />
          {live ? 'Live' : 'Updates on refresh'}
        </span>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height={68} radius={16} />
          <Skeleton height={68} radius={16} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : notifications.length > 0 ? (
        <div className="flex flex-col gap-2 mb-9">
          {notifications.map((n) => {
            const isNew = !n.readAt || seenUnread.current.has(n.id);
            const body = (
              <div
                className="card shadow-card flex items-start gap-3 p-4"
                style={{
                  background: isNew ? '#fdfcff' : '#fff',
                  borderColor: isNew ? '#ddd0ff' : '#e8e6f5',
                }}
              >
                <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }} aria-hidden="true">
                  {ICONS[n.type]}
                </span>
                <div className="flex-1 min-w-0">
                  <div
                    style={{
                      fontSize: '0.88rem',
                      color: '#1a1635',
                      fontWeight: isNew ? 700 : 500,
                      fontFamily: 'Plus Jakarta Sans',
                    }}
                  >
                    {n.title}
                  </div>
                  {n.body && (
                    <div style={{ fontSize: '0.8rem', color: '#6b688f', marginTop: 2 }}>{n.body}</div>
                  )}
                  <div style={{ fontSize: '0.72rem', color: '#b8b5d5', marginTop: 3 }}>
                    {timeAgo(n.createdAt)}
                  </div>
                </div>
                {isNew && (
                  <span
                    className="rounded-full flex-shrink-0"
                    style={{ width: 8, height: 8, background: '#7c3aed', marginTop: 6 }}
                    aria-label="Unread"
                  />
                )}
              </div>
            );

            // An invitation notification points at a private goal before the recipient
            // has joined it. Send them to the invitation controls first; otherwise the
            // goal privacy gate correctly (but confusingly) renders a 404.
            const isGoalInvitation =
              n.type === 'FRIEND' &&
              (Boolean(n.data.invitationId) || n.title.toLowerCase().includes('invited you to'));
            const destination = isGoalInvitation
              ? '/app/friends'
              : n.data.goalId
                ? `/app/goals/${n.data.goalId}`
                : null;

            return destination ? (
              <Link key={n.id} to={destination}>
                {body}
              </Link>
            ) : (
              <div key={n.id}>{body}</div>
            );
          })}
        </div>
      ) : (
        <div className="mb-9">
          <EmptyState
            emoji="🔔"
            title="Nothing yet"
            body="Your daily summary, reminders, friend activity and achievements will show up here."
          />
        </div>
      )}

      <NotificationSettings />
    </div>
  );
}

function NotificationSettings() {
  const { user, setUser } = useAuth();
  const { push } = useToast();
  if (!user) return null;

  async function save(notifications: Partial<CurrentUser['notifications']>) {
    try {
      const result = await api.patch<{ user: CurrentUser }>('/profile', { notifications });
      if (result.user) setUser(result.user);
      return true;
    } catch {
      push('Could not save that setting', 'error');
      return false;
    }
  }

  return (
    <section>
      <h2
        className="mb-1"
        style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: '1rem', color: '#1a1635' }}
      >
        Notification settings
      </h2>
      {/* The times below are wall-clock in this timezone, so say which one it is: 08:00 means
          something different depending on the answer, and the user picked it on their profile. */}
      <p style={{ fontSize: '0.78rem', color: '#8b88b0', marginBottom: 12 }}>
        Daily times are in {user.timezone}.
      </p>
      <div className="card shadow-card p-2">
        {SETTINGS.map((setting) => {
          const { key, label } = setting;
          const time = 'time' in setting ? setting.time : undefined;
          const on = user.notifications[key];
          return (
            <div key={key} className="flex items-center justify-between gap-3 px-3 py-3">
              <span style={{ fontSize: '0.88rem', color: '#1a1635' }}>{label}</span>
              <div className="flex items-center gap-3">
                {time && <TimeField timeKey={time} label={label} enabled={on} onSave={save} />}
                <button
                  role="switch"
                  aria-checked={on}
                  aria-label={label}
                  onClick={() => save({ [key]: !on })}
                  className="relative rounded-full flex-shrink-0"
                  style={{
                    width: 44,
                    height: 26,
                    background: on ? 'linear-gradient(135deg, #7c3aed, #6d28d9)' : '#ede9f8',
                    transition: 'background .18s',
                  }}
                >
                  <span
                    className="absolute rounded-full"
                    style={{
                      width: 20,
                      height: 20,
                      top: 3,
                      left: on ? 21 : 3,
                      background: '#fff',
                      transition: 'left .18s',
                      boxShadow: '0 1px 3px rgba(0,0,0,.2)',
                    }}
                  />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * A time the user types rather than toggles, so it saves on blur and not on keystroke: a
 * native time input reports half-finished values while you are still in it, and the server
 * only accepts a complete HH:MM.
 */
function TimeField({
  timeKey,
  label,
  enabled,
  onSave,
}: {
  timeKey: TimeKey;
  label: string;
  enabled: boolean;
  onSave(notifications: Partial<CurrentUser['notifications']>): Promise<boolean>;
}) {
  const { user } = useAuth();
  const saved = user!.notifications[timeKey];
  const [value, setValue] = useState(saved);

  // Follow the profile when it changes elsewhere — a failed save reverts through here too.
  useEffect(() => setValue(saved), [saved]);

  return (
    <input
      type="time"
      value={value}
      aria-label={`${label} time`}
      disabled={!enabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={async () => {
        if (value === saved) return;
        // An emptied field is not a time. Put the saved one back rather than sending
        // something the server will refuse.
        if (!/^\d{2}:\d{2}$/.test(value)) return setValue(saved);
        if (!(await onSave({ [timeKey]: value }))) setValue(saved);
      }}
      className="px-2 py-1.5"
      style={{
        fontSize: '0.82rem',
        width: 104,
        opacity: enabled ? 1 : 0.45,
        cursor: enabled ? 'text' : 'not-allowed',
      }}
    />
  );
}
