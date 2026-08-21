import { useState } from 'react';
import { ArrowLeft, Calendar, Gauge, LogOut, Plus, Settings, Share2, Sparkles, Trash2, TrendingUp, UserPlus, Users } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import TaskRow from '../components/TaskRow';
import {
  Avatar,
  Badge,
  ErrorState,
  Modal,
  PrivacyBadge,
  ProgressCircle,
  Skeleton,
  useAsync,
  useToast,
} from '../components/ui';
import Leaderboard from '../components/LeaderboardPanel';
import { AddTaskModal, EditGoalModal } from '../components/GoalManage';
import ShareGoalModal from '../components/ShareGoalModal';
import ProgressionModal from '../components/ProgressionPanel';
import AdjustmentOffers from '../components/AdjustmentOffers';
import { useCopilot, useCopilotGoalContext } from '../components/copilot/CopilotProvider';
import { ApiError, api } from '../lib/api';
import {
  CATEGORY_EMOJI,
  CATEGORY_LABEL,
  describeDifficulty,
  describeRecurrence,
  formatTarget,
  type Friend,
  type GoalDetailResponse,
  type TodayTask,
} from '../lib/types';

const TABS = ['Overview', 'Tasks', 'Leaderboard', 'Participants'] as const;

export default function GoalDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { push } = useToast();

  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [joining, setJoining] = useState(false);

  const { data, loading, error, reload } = useAsync(
    () => api.get<GoalDetailResponse>(`/goals/${id}`),
    [id],
  );

  const today = useAsync(
    () => api.get<{ groups: Array<{ goalId: string; tasks: TodayTask[] }> }>('/today'),
    [id],
  );

  // Lets the floating Copilot offer to talk about *this* goal instead of asking
  // which one. Only for goals the user is actually in.
  const copilot = useCopilot();
  useCopilotGoalContext(
    data?.goal.isParticipant ? { id: data.goal.id, title: data.goal.title } : null,
  );

  if (loading) {
    return (
      <div className="p-5 sm:p-6 lg:p-8 max-w-4xl mx-auto flex flex-col gap-4">
        <Skeleton height={40} width={180} />
        <Skeleton height={150} radius={16} />
        <Skeleton height={220} radius={16} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-5 sm:p-6 lg:p-8 max-w-4xl mx-auto">
        <ErrorState
          message={
            error.toLowerCase().includes('not found')
              ? "This goal doesn't exist, or you don't have access to it."
              : error
          }
          onRetry={reload}
        />
        <div className="text-center mt-4">
          <Link to="/app/goals" className="btn-ghost inline-block px-5 py-2.5 text-sm">
            Back to my goals
          </Link>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { goal, tasks, participants, me, history } = data;
  const isChallenge = goal.participantCount > 1;
  const todayTasks = today.data?.groups.find((g) => g.goalId === goal.id)?.tasks ?? [];

  async function join() {
    setJoining(true);
    try {
      await api.post(`/goals/${goal.id}/join`);
      push('You joined the challenge 🎉');
      reload();
      today.reload();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not join', 'error');
    } finally {
      setJoining(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${goal.title}"? This cannot be undone.`)) return;
    try {
      await api.del(`/goals/${goal.id}`);
      push('Goal deleted');
      navigate('/app/goals', { replace: true });
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not delete', 'error');
    }
  }

  async function leave() {
    if (!window.confirm(`Leave "${goal.title}"? Your progress is kept if you rejoin later.`)) return;
    try {
      await api.post(`/goals/${goal.id}/leave`);
      push('You left the goal');
      navigate('/app/goals', { replace: true });
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not leave', 'error');
    }
  }

  return (
    <div className="p-5 sm:p-6 lg:p-8 max-w-4xl mx-auto">
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-2 mb-5"
        style={{ color: '#8b88b0', fontSize: '0.875rem', fontWeight: 500 }}
      >
        <ArrowLeft size={15} /> Back
      </button>

      {/* ------------------------------------------------------- header */}
      <div className="card shadow-card p-5 sm:p-6 mb-5">
        <div className="flex items-start gap-4">
          <div
            className="flex items-center justify-center rounded-2xl flex-shrink-0"
            style={{ width: 56, height: 56, fontSize: 26, background: '#f0ebff', border: '1px solid #ddd0ff' }}
            aria-hidden="true"
          >
            {CATEGORY_EMOJI[goal.category]}
          </div>

          <div className="flex-1 min-w-0">
            <h1
              style={{
                fontFamily: 'Plus Jakarta Sans',
                fontWeight: 800,
                fontSize: 'clamp(1.25rem, 2.5vw, 1.6rem)',
                color: '#1a1635',
                letterSpacing: '-0.02em',
              }}
            >
              {goal.title}
            </h1>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge tone="neutral">{CATEGORY_LABEL[goal.category]}</Badge>
              <PrivacyBadge visibility={goal.visibility} />
              {isChallenge && <Badge tone="primary">👥 {goal.participantCount} participants</Badge>}
              {goal.deadline && (
                <Badge tone="warning">
                  <Calendar size={11} /> {goal.deadline}
                </Badge>
              )}
            </div>
          </div>

          {me && (
            <div className="hidden sm:block flex-shrink-0">
              <ProgressCircle value={me.progress.percent}>
                <span
                  style={{
                    fontFamily: 'Plus Jakarta Sans',
                    fontWeight: 800,
                    fontSize: '0.95rem',
                    color: '#7c3aed',
                  }}
                >
                  {Math.round(me.progress.percent)}%
                </span>
              </ProgressCircle>
            </div>
          )}
        </div>

        {goal.description && (
          <p className="mt-4" style={{ fontSize: '0.9rem', color: '#6b688f', lineHeight: 1.6 }}>
            {goal.description}
          </p>
        )}

        {goal.visibility === 'PRIVATE' && (
          <p
            className="mt-4 px-3.5 py-2.5 rounded-xl"
            style={{ background: '#f5f4ff', border: '1px solid #e8e6f5', fontSize: '0.8rem', color: '#6b688f' }}
          >
            🔒 Only you and invited participants can see this goal and its progress.
          </p>
        )}

        {/* stats */}
        {me && (
          <div className="grid grid-cols-3 gap-3 mt-5">
            {[
              { label: 'Current streak', value: `🔥 ${me.streak.current}`, color: '#f97316' },
              { label: 'Best streak', value: `${me.streak.best}`, color: '#1a1635' },
              {
                label: 'Tasks done',
                value: `${me.progress.completedOccurrences}/${me.progress.totalOccurrences}`,
                color: '#7c3aed',
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl px-3 py-3 text-center"
                style={{ background: '#f5f4ff', border: '1px solid #e8e6f5' }}
              >
                <div
                  style={{
                    fontFamily: 'Plus Jakarta Sans',
                    fontWeight: 800,
                    fontSize: '1.05rem',
                    color: stat.color,
                  }}
                >
                  {stat.value}
                </div>
                <div style={{ fontSize: '0.7rem', color: '#8b88b0', marginTop: 2 }}>{stat.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* actions */}
        <div className="flex gap-2.5 mt-5 flex-wrap">
          {!goal.isParticipant && goal.visibility === 'PUBLIC' && (
            <button className="btn-primary px-5 py-2.5 text-sm" onClick={join} disabled={joining}>
              {joining ? 'Joining…' : 'Join Challenge'}
            </button>
          )}
          {goal.isParticipant && (
            <button
              className="btn-secondary px-4 py-2.5 text-sm flex items-center gap-2"
              onClick={() =>
                copilot.open({ view: 'goal', goalId: goal.id, goalTitle: goal.title })
              }
            >
              <Sparkles size={15} /> Ask Copilot
            </button>
          )}
          {goal.isParticipant && (
            <button
              className="btn-secondary px-4 py-2.5 text-sm flex items-center gap-2"
              onClick={() => setInviteOpen(true)}
            >
              <UserPlus size={15} /> Invite Friends
            </button>
          )}
          {goal.isOwner && (
            <button
              className="btn-secondary px-4 py-2.5 text-sm flex items-center gap-2"
              onClick={() => setShareOpen(true)}
            >
              <Share2 size={15} /> Share link
            </button>
          )}
          {goal.isOwner && (
            <button
              className="btn-ghost px-4 py-2.5 text-sm flex items-center gap-2"
              onClick={() => setEditOpen(true)}
            >
              <Settings size={15} /> Settings
            </button>
          )}
          {goal.isParticipant && !goal.isOwner && (
            <button
              className="btn-ghost px-4 py-2.5 text-sm flex items-center gap-2"
              onClick={leave}
            >
              <LogOut size={15} /> Leave
            </button>
          )}
          {goal.isOwner && (
            <button
              className="btn-ghost px-4 py-2.5 text-sm flex items-center gap-2"
              onClick={remove}
              style={{ color: '#c8253c' }}
            >
              <Trash2 size={15} /> Delete
            </button>
          )}
        </div>
      </div>

      {/* -------------------------------------------------------- tabs */}
      <div className="flex gap-2 mb-5 overflow-x-auto" role="tablist" aria-label="Goal sections">
        {TABS.filter((t) => t !== 'Leaderboard' || isChallenge).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className="px-4 py-2 rounded-xl text-sm whitespace-nowrap"
            style={{
              background: tab === t ? '#f0ebff' : '#fff',
              border: `1px solid ${tab === t ? '#ddd0ff' : '#e8e6f5'}`,
              color: tab === t ? '#7c3aed' : '#6b688f',
              fontWeight: 700,
              fontFamily: 'Plus Jakarta Sans',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ---------------------------------------------------- overview */}
      {tab === 'Overview' && (
        <div className="flex flex-col gap-5">
          {goal.isParticipant && (
            <div className="card shadow-card p-5">
              <h2
                className="mb-3.5"
                style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: '1rem', color: '#1a1635' }}
              >
                Today's Tasks
              </h2>
              {todayTasks.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {todayTasks.map((task) => (
                    <TaskRow
                      key={task.occurrenceId}
                      task={task}
                      onChanged={() => {
                        reload();
                        today.reload();
                      }}
                    />
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: '0.85rem', color: '#8b88b0' }}>
                  Nothing scheduled today — this one's a rest day.
                </p>
              )}
            </div>
          )}

          {me && history.length > 0 && (
            <div className="card shadow-card p-5">
              <h2
                className="mb-4"
                style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: '1rem', color: '#1a1635' }}
              >
                Progress History
              </h2>
              <div className="flex gap-1.5 flex-wrap">
                {history.map((day) => {
                  const neutral = day.percent === null;
                  const done = !neutral && day.completed >= day.required;
                  return (
                    <div
                      key={day.day}
                      className="flex flex-col items-center gap-1"
                      title={
                        neutral
                          ? `${day.day}: no tasks scheduled`
                          : `${day.day}: ${day.completed}/${day.required}`
                      }
                    >
                      <div
                        className="flex items-center justify-center rounded-lg"
                        style={{
                          width: 30,
                          height: 30,
                          background: neutral ? '#f5f4ff' : done ? '#f0ebff' : '#ffeef0',
                          border: `1px solid ${neutral ? '#e8e6f5' : done ? '#ddd0ff' : '#ffd3d9'}`,
                          fontSize: 12,
                          color: neutral ? '#b8b5d5' : done ? '#7c3aed' : '#c8253c',
                          fontWeight: 700,
                        }}
                      >
                        {/* Never colour alone — a glyph carries the same meaning. */}
                        {neutral ? '–' : done ? '✓' : '✕'}
                      </div>
                      <span style={{ fontSize: 9, color: '#b8b5d5' }}>{day.day.slice(8)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-4 mt-4 flex-wrap" style={{ fontSize: '0.75rem', color: '#8b88b0' }}>
                <span>✓ Completed</span>
                <span>✕ Missed</span>
                <span>– Rest day</span>
              </div>
            </div>
          )}

          {!goal.isParticipant && (
            <div className="card shadow-card p-5">
              <h2
                className="mb-3"
                style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: '1rem', color: '#1a1635' }}
              >
                What you'll do
              </h2>
              <TaskList tasks={tasks} />
              <p className="mt-4" style={{ fontSize: '0.82rem', color: '#8b88b0' }}>
                Created by {goal.owner.name} · {goal.participantCount}{' '}
                {goal.participantCount === 1 ? 'participant' : 'participants'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------- tasks */}
      {tab === 'Tasks' && (
        <div className="card shadow-card p-5">
          {/* Above the list, because it is about the list. Renders nothing at all
              unless the user's own ratings have actually said something. */}
          {goal.isParticipant && <AdjustmentOffers goalId={goal.id} onChanged={reload} />}
          <TaskList tasks={tasks} isOwner={goal.isOwner} onChanged={reload} />
          {goal.isOwner && (
            <button
              className="w-full mt-3 py-3.5 rounded-xl flex items-center justify-center gap-2"
              style={{
                border: '1.5px dashed #ddd0ff',
                background: '#fdfcff',
                color: '#8b88b0',
                fontWeight: 700,
                fontSize: '0.85rem',
                fontFamily: 'Plus Jakarta Sans',
              }}
              onClick={() => setAddTaskOpen(true)}
            >
              <Plus size={15} /> Add a task
            </button>
          )}
        </div>
      )}

      {/* ------------------------------------------------- leaderboard */}
      {tab === 'Leaderboard' && <Leaderboard goalId={goal.id} />}

      {/* ------------------------------------------------ participants */}
      {tab === 'Participants' && (
        <div className="card shadow-card p-5">
          <div className="flex flex-col gap-2">
            {participants.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
                style={{
                  background: p.isMe ? '#f0ebff' : 'transparent',
                  border: `1px solid ${p.isMe ? '#ddd0ff' : 'transparent'}`,
                }}
              >
                <Avatar emoji={p.avatarEmoji} size={34} />
                <div className="flex-1 min-w-0">
                  <div
                    className="truncate"
                    style={{
                      fontSize: '0.9rem',
                      fontWeight: p.isMe ? 700 : 600,
                      color: p.isMe ? '#7c3aed' : '#1a1635',
                      fontFamily: 'Plus Jakarta Sans',
                    }}
                  >
                    {p.name} {p.isMe && <span style={{ fontWeight: 500 }}>(you)</span>}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: '#b8b5d5' }}>Joined {p.joinedOn}</div>
                </div>
                {p.role === 'OWNER' && <Badge tone="primary">Owner</Badge>}
              </div>
            ))}
          </div>

          {goal.isParticipant && (
            <button
              className="btn-secondary w-full mt-4 py-3 text-sm flex items-center justify-center gap-2"
              onClick={() => setInviteOpen(true)}
            >
              <Users size={15} /> Invite more friends
            </button>
          )}
        </div>
      )}

      <InviteModal
        goalId={goal.id}
        goalTitle={goal.title}
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
      />

      {goal.isOwner && (
        <>
          <ShareGoalModal
            goalId={goal.id}
            goalTitle={goal.title}
            initialCode={goal.inviteCode}
            open={shareOpen}
            onClose={() => setShareOpen(false)}
            onChanged={reload}
          />
          <EditGoalModal
            goal={goal}
            open={editOpen}
            onClose={() => setEditOpen(false)}
            onSaved={reload}
          />
          <AddTaskModal
            goalId={goal.id}
            open={addTaskOpen}
            onClose={() => setAddTaskOpen(false)}
            onSaved={() => {
              reload();
              today.reload();
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * The goal's tasks as definitions rather than as today's to-do list. Tasks that
 * climb a ladder say where they currently stand, and the owner can open the full
 * progression from here.
 */
function TaskList({
  tasks,
  isOwner = false,
  onChanged,
}: {
  tasks: GoalDetailResponse['tasks'];
  isOwner?: boolean;
  onChanged?: () => void;
}) {
  // One modal for the whole list, so only the task actually being looked at gets
  // fetched.
  const [openTask, setOpenTask] = useState<GoalDetailResponse['tasks'][number] | null>(null);
  const [stale, setStale] = useState(false);

  if (tasks.length === 0) {
    return <p style={{ fontSize: '0.85rem', color: '#8b88b0' }}>No tasks yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center gap-3 px-3.5 py-3 rounded-xl"
          style={{ background: '#fdfcff', border: '1px solid #e8e6f5' }}
        >
          <div className="flex-1 min-w-0">
            <div
              className="truncate"
              style={{ fontSize: '0.88rem', fontWeight: 600, color: '#1a1635', fontFamily: 'Plus Jakarta Sans' }}
            >
              {task.title}
              {/* The target the task is asking for at the moment — the same
                  wording as on the day's own task row. */}
              {task.progression?.currentTarget !== null && task.progression && (
                <span
                  className="ml-2 whitespace-nowrap"
                  style={{ fontSize: '0.75rem', fontWeight: 800, color: '#7c3aed' }}
                >
                  {formatTarget(task.progression.currentTarget!, task.progression)}
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.72rem', color: '#b8b5d5', marginTop: 1 }}>
              {describeRecurrence(task)}
              {task.reminderTime ? ` · ${task.reminderTime}` : ''}
            </div>
            {/* What the user has been saying about this task, in their words. An
                observation only — it is stated, never acted on, and the sentence
                itself carries the meaning so the tint is only reinforcement. */}
            {task.difficulty && describeDifficulty(task.difficulty) && (
              <div
                className="flex items-center gap-1 mt-1"
                style={{
                  fontSize: '0.72rem',
                  color:
                    task.difficulty.signal === 'TOO_EASY' || task.difficulty.signal === 'TOO_HARD'
                      ? '#7c3aed'
                      : '#8b88b0',
                }}
              >
                <Gauge size={11} aria-hidden="true" />
                {describeDifficulty(task.difficulty)}
              </div>
            )}
          </div>

          {/* Owners get here whether or not a ladder exists — the modal offers to
              set one up. Everyone else only sees the button when there is
              something to look at. Deliberately terse: on a narrow screen the
              task's own name matters more than this, and the full "Stage 2 of 4"
              is spelled out in the panel and on the day's task row. */}
          {(task.progression || isOwner) && (
            <button
              onClick={() => setOpenTask(task)}
              title={
                task.progression
                  ? `${task.progression.stageLabel} — open progression`
                  : 'Add a progression'
              }
              aria-label={
                task.progression
                  ? `${task.progression.stageLabel} of ${task.title} — open progression`
                  : `Add a progression to ${task.title}`
              }
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 flex-shrink-0"
              style={{
                background: task.progression ? '#f0ebff' : '#f5f4ff',
                color: task.progression ? '#7c3aed' : '#8b88b0',
                border: `1px solid ${task.progression ? '#ddd0ff' : '#e8e6f5'}`,
                fontSize: 11,
                fontWeight: 700,
                fontFamily: 'Plus Jakarta Sans',
              }}
            >
              <TrendingUp size={11} />
              {task.progression
                ? `${task.progression.currentStageIndex + 1}/${task.progression.stageCount}`
                : // No ladder yet, so there is no number to show. The glyph alone
                  // keeps a long task name from being clipped on a phone; the
                  // words are on the button's label and its tooltip.
                  <Plus size={11} />}
            </button>
          )}

          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#f59e0b' }}>
            +{task.reward}🪙
          </span>
        </div>
      ))}

      {openTask && (
        <ProgressionModal
          open
          taskId={openTask.id}
          taskTitle={openTask.title}
          isOwner={isOwner}
          onClose={() => {
            setOpenTask(null);
            // Refetching the goal puts the page back into its loading state, which
            // would tear the modal down mid-read. So the chip's "Stage 2 of 4" is
            // brought up to date once the user is done looking.
            if (stale) {
              setStale(false);
              onChanged?.();
            }
          }}
          onChanged={() => setStale(true)}
        />
      )}
    </div>
  );
}

function InviteModal({
  goalId,
  goalTitle,
  open,
  onClose,
}: {
  goalId: string;
  goalTitle: string;
  open: boolean;
  onClose: () => void;
}) {
  const { push } = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { data, loading } = useAsync(() => api.get<{ friends: Friend[] }>('/friends'), [open]);

  async function invite() {
    setBusy(true);
    try {
      const result = await api.post<{ invited: string[] }>(`/goals/${goalId}/invite`, {
        userIds: selected,
      });
      push(
        result.invited.length === 1
          ? 'Invitation sent'
          : `${result.invited.length} invitations sent`,
      );
      setSelected([]);
      onClose();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not send invitations', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Invite friends to ${goalTitle}`}
      footer={
        <>
          <button className="btn-ghost px-4 py-2.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary px-4 py-2.5 text-sm"
            onClick={invite}
            disabled={busy || selected.length === 0}
            style={{ opacity: busy || selected.length === 0 ? 0.5 : 1 }}
          >
            {busy ? 'Sending…' : `Invite ${selected.length || ''}`}
          </button>
        </>
      }
    >
      {loading ? (
        <Skeleton height={120} />
      ) : data && data.friends.length > 0 ? (
        <div className="flex flex-col gap-2">
          {data.friends.map((friend) => {
            const on = selected.includes(friend.id);
            return (
              <button
                key={friend.id}
                aria-pressed={on}
                onClick={() =>
                  setSelected(on ? selected.filter((x) => x !== friend.id) : [...selected, friend.id])
                }
                className="flex items-center gap-3 px-3.5 py-3 rounded-xl text-left"
                style={{
                  background: on ? '#f0ebff' : '#fdfcff',
                  border: `1.5px solid ${on ? '#7c3aed' : '#e8e6f5'}`,
                }}
              >
                <Avatar emoji={friend.avatarEmoji} size={34} />
                <span className="flex-1" style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1a1635' }}>
                  {friend.name}
                </span>
                <span
                  className="flex items-center justify-center rounded-full"
                  style={{
                    width: 20,
                    height: 20,
                    background: on ? '#7c3aed' : 'transparent',
                    border: on ? 'none' : '2px solid #ddd0ff',
                    color: '#fff',
                    fontSize: 11,
                  }}
                  aria-hidden="true"
                >
                  {on && '✓'}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p style={{ fontSize: '0.88rem', color: '#6b688f', lineHeight: 1.6 }}>
          You don't have any friends yet. Add some from the Friends page, then invite them here.
        </p>
      )}
    </Modal>
  );
}
