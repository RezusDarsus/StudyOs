import { ArrowRight, CircleDollarSign, Plus, Sparkles, UsersRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import TaskRow from '../components/TaskRow';
import { EmptyState, ErrorState, Skeleton, UpMarker, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CATEGORY_LABEL, type GoalSummary, type TodayResponse } from '../lib/types';
import { useState } from 'react';
import './Dashboard.css';

export default function Dashboard() {
  const { user } = useAuth();
  const today = useAsync(() => api.get<TodayResponse>('/today'), []);
  const goals = useAsync(() => api.get<{ goals: GoalSummary[] }>('/goals?status=ACTIVE'), []);
  const [delta, setDelta] = useState(0);
  const [coinDelta, setCoinDelta] = useState(0);
  const summary = today.data?.summary;
  const completed = Math.max(0, (summary?.completed ?? 0) + delta);
  const required = summary?.required ?? 0;
  const percent = required === 0 ? 0 : Math.min(100, Math.round((completed / required) * 100));
  const remaining = Math.max(0, required - completed);
  const groups = today.data?.groups ?? [];
  const hasTasks = groups.some((group) => group.tasks.length > 0);
  const hasGoals = !!goals.data?.goals.length;
  const heading = today.loading ? 'Getting your day ready…' : today.error ? 'Your day is unavailable.' : !hasTasks ? 'Room to breathe.' : remaining === 0 ? 'Today, well done.' : 'One move at a time.';

  return (
    <div className="product-page dashboard-page">
      <header className="product-page-header">
        <div>
          <p className="product-eyebrow">Your day{user?.name ? ` · ${user.name}` : ''}</p>
          <h1>A little progress, today.</h1>
          <p>Pick a move. Give it your attention. Make it count.</p>
        </div>
        <Link to="/app/goals/new" className="btn-secondary product-new-goal"><Plus size={17} /> New goal</Link>
      </header>

      <div className="dashboard-layout">
        <section className="dashboard-primary" aria-labelledby="today-heading">
          <div className="challenge-window daily-window">
            <div className="challenge-rail" aria-hidden="true"><span>TODAY</span><i /><i /><i /></div>
            <div className="challenge-body">
              <div className="daily-window-head">
                <div><p className="product-eyebrow">Daily focus</p><h2 id="today-heading">{heading}</h2></div>
                <UpMarker size={40} />
              </div>
              {!today.loading && !today.error && hasTasks && <div className="daily-progress">
                <div className="daily-progress-copy" aria-live="polite"><span><strong>{completed} of {required}</strong> complete</span><span>{remaining > 0 ? `${remaining} left today` : 'Day complete'}</span></div>
                <div className="momentum-track" role="progressbar" aria-label="Today's plan" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${completed} of ${required} moves complete`}><span style={{ width: `${percent}%` }} />{[0, 33, 66, 100].map((threshold) => <i aria-hidden="true" key={threshold} className={completed > 0 && percent >= threshold ? 'is-settled' : ''} />)}</div>
              </div>}
              {today.loading ? <div className="dashboard-task-stack" role="status" aria-label="Loading today's tasks"><Skeleton height={96} /><Skeleton height={74} /></div> : today.error ? <ErrorState message={today.error} onRetry={today.reload} /> : hasTasks ? (
                <div className="dashboard-task-stack">{groups.filter((group) => group.tasks.length).map((group) => <div key={group.goalId} className="goal-task-group">
                  <div className="goal-task-group__head"><Link to={`/app/goals/${group.goalId}`}><span className="goal-glyph">{CATEGORY_LABEL[group.category].slice(0, 1)}</span>{group.goalTitle}</Link><span className="trail-count">{group.streak} day streak</span></div>
                  {group.tasks.map((task) => <TaskRow key={task.occurrenceId} task={task} onChanged={(t, d) => { setDelta((prev) => prev + d); setCoinDelta((prev) => prev + d * t.reward); }} />)}
                </div>)}</div>
              ) : goals.loading ? <div role="status" aria-label="Checking your goals"><Skeleton height={160} /></div> : goals.error ? <ErrorState message="Your tasks loaded, but we couldn’t check your goals." onRetry={goals.reload} /> : <EmptyState emoji="" title={hasGoals ? 'Nothing scheduled today' : 'A first move starts with a goal'} body={hasGoals ? 'Your goals are still here. Enjoy the breathing room, or open a goal to review its schedule.' : 'Choose something you want to work toward. Start small; you can build from there.'} action={<Link className="btn-primary px-5 py-3" to={hasGoals ? '/app/goals' : '/app/goals/new'}>{hasGoals ? 'Review my goals' : 'Shape my first goal'}</Link>} />}
            </div>
          </div>

          {hasGoals && <section className="active-goals-section" aria-labelledby="active-goals-heading">
            <div className="section-row-heading"><div><p className="product-eyebrow">Longer horizon</p><h2 id="active-goals-heading">Goals in motion</h2></div><Link to="/app/goals">View all <ArrowRight size={14} /></Link></div>
            <div className="goal-rail">{goals.data!.goals.slice(0, 3).map((goal) => <GoalRow key={goal.id} goal={goal} />)}</div>
          </section>}
          {hasTasks && goals.error && <ErrorState message="Your goals couldn’t be loaded." onRetry={goals.reload} />}
        </section>

        <aside className="dashboard-context" aria-label="Your wider picture">
          <section className="dashboard-note"><p className="product-eyebrow">At your pace</p><h2>Small is a good start.</h2><p>Your list comes from your goal schedules. Choose what fits now; check in after each completed move.</p><Link to="/app/goals">Review your plans <ArrowRight size={15} /></Link></section>
          <section className="dashboard-earned" aria-label="Rewards today"><CircleDollarSign size={20} /><div>{today.loading ? <span>Loading rewards…</span> : today.error ? <span>Rewards unavailable</span> : <><strong>{(summary?.coinsToday ?? 0) + coinDelta}</strong><span>coins earned today</span></>}</div><Link to="/app/rewards" aria-label="View rewards"><ArrowRight size={18} /></Link></section>
          <FriendActivity />
          <div className="dashboard-copilot"><Sparkles size={18} /><p>Have something new in mind?</p><Link to="/app/goals/new/ai">Plan a new goal with Copilot <ArrowRight size={14} /></Link></div>
        </aside>
      </div>
    </div>
  );
}

function GoalRow({ goal }: { goal: GoalSummary }) {
  const progress = Math.min(100, Math.max(0, Math.round(goal.progress)));
  return <Link to={`/app/goals/${goal.id}`} className="goal-rail-row"><span className="goal-glyph">{CATEGORY_LABEL[goal.category].slice(0, 1)}</span><span className="goal-rail-copy"><strong>{goal.title}</strong><small>{Math.max(0, goal.todayRequired - goal.todayCompleted)} left today · {goal.participantCount > 1 ? `${goal.participantCount} people` : 'Private goal'}</small></span><span className="goal-rail-progress" aria-label={`${progress}% complete`}><i><b style={{ width: `${progress}%` }} /></i><em>{progress}%</em></span></Link>;
}

function FriendActivity() {
  const { data, loading, error, reload } = useAsync(() => api.get<{ friends: Array<{ id: string; name: string; currentStreak: number; sharedGoals: number }> }>('/friends'), []);
  return <section className="friend-field"><div className="section-row-heading compact"><div><p className="product-eyebrow">Better together</p><h2>Alongside you</h2></div><Link to="/app/friends" aria-label="View friends"><ArrowRight size={18} /></Link></div>{loading ? <Skeleton height={120} /> : error ? <div className="dashboard-friends-error"><p>Friends couldn’t be loaded.</p><button onClick={reload}>Try again</button></div> : data?.friends.length ? data.friends.slice(0, 3).map((friend) => <div key={friend.id} className="friend-signal"><span className="friend-avatar">{friend.name.slice(0, 2).toUpperCase()}</span><span><strong>{friend.name}</strong><small>{friend.sharedGoals ? `${friend.sharedGoals} shared goal${friend.sharedGoals === 1 ? '' : 's'}` : `${friend.currentStreak} day streak`}</small></span></div>) : <div className="friend-empty"><UsersRound size={22} /><p>A little encouragement goes a long way. Invite someone when you’re ready.</p><Link to="/app/friends">Find a friend</Link></div>}</section>;
}
