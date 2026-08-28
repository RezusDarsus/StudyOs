import { useState } from 'react';
import { Modal, useToast } from './ui';
import { ApiError, api } from '../lib/api';
import {
  CATEGORY_EMOJI,
  CATEGORY_LABEL,
  WEEKDAY_LABEL,
  type GoalCategory,
  type GoalDetailResponse,
  type GoalStatus,
  type GoalVisibility,
  type RecurrenceType,
} from '../lib/types';

const labelStyle = {
  fontSize: '0.8rem',
  fontWeight: 700,
  color: '#4b4870',
  display: 'block',
  marginBottom: 6,
  fontFamily: 'Plus Jakarta Sans',
} as const;

/** Owner-only settings: rename, re-describe, change privacy, pause or complete. */
export function EditGoalModal({
  goal,
  open,
  onClose,
  onSaved,
}: {
  goal: GoalDetailResponse['goal'];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { push } = useToast();
  const [title, setTitle] = useState(goal.title);
  const [description, setDescription] = useState(goal.description);
  const [category, setCategory] = useState<GoalCategory>(goal.category);
  const [visibility, setVisibility] = useState<GoalVisibility>(goal.visibility);
  const [status, setStatus] = useState<GoalStatus>(goal.status);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/goals/${goal.id}`, { title, description, category, visibility, status });
      push('Goal updated');
      onSaved();
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
      title="Goal settings"
      footer={
        <>
          <button className="btn-ghost px-4 py-2.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary px-4 py-2.5 text-sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <label htmlFor="edit-title" style={labelStyle}>
        Goal name
      </label>
      <input
        id="edit-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full px-4 py-3 text-sm mb-4"
      />

      <label htmlFor="edit-desc" style={labelStyle}>
        Description
      </label>
      <textarea
        id="edit-desc"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        className="w-full px-4 py-3 text-sm resize-none mb-4"
      />

      <label htmlFor="edit-category" style={labelStyle}>
        Category
      </label>
      <select
        id="edit-category"
        value={category}
        onChange={(e) => setCategory(e.target.value as GoalCategory)}
        className="w-full px-4 py-3 text-sm mb-4"
      >
        {(Object.keys(CATEGORY_LABEL) as GoalCategory[]).map((key) => (
          <option key={key} value={key}>
            {CATEGORY_EMOJI[key]} {CATEGORY_LABEL[key]}
          </option>
        ))}
      </select>

      <label style={labelStyle}>Privacy</label>
      <div className="flex gap-2 mb-4">
        {(['PRIVATE', 'PUBLIC'] as const).map((value) => (
          <button
            key={value}
            onClick={() => setVisibility(value)}
            aria-pressed={visibility === value}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm"
            style={{
              background: visibility === value ? '#f0ebff' : '#fdfcff',
              border: `1.5px solid ${visibility === value ? '#7c3aed' : '#e8e6f5'}`,
              color: visibility === value ? '#7c3aed' : '#6b688f',
              fontWeight: 700,
              fontFamily: 'Plus Jakarta Sans',
            }}
          >
            {value === 'PRIVATE' ? '🔒 Private' : '🌍 Public'}
          </button>
        ))}
      </div>

      <label htmlFor="edit-status" style={labelStyle}>
        Status
      </label>
      <select
        id="edit-status"
        value={status}
        onChange={(e) => setStatus(e.target.value as GoalStatus)}
        className="w-full px-4 py-3 text-sm"
      >
        <option value="ACTIVE">Active</option>
        <option value="PAUSED">Paused — stop showing tasks for now</option>
        <option value="COMPLETED">Completed</option>
        <option value="ARCHIVED">Archived</option>
      </select>
    </Modal>
  );
}

/** Add another recurring task to a goal that already exists. */
export function AddTaskModal({
  goalId,
  open,
  onClose,
  onSaved,
}: {
  goalId: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { push } = useToast();
  const [title, setTitle] = useState('');
  const [recurrenceType, setRecurrenceType] = useState<RecurrenceType>('EVERY_DAY');
  const [weekdays, setWeekdays] = useState<number[]>([1, 3, 5]);
  const [timesPerWeek, setTimesPerWeek] = useState(3);
  const [intervalDays, setIntervalDays] = useState(2);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [intervalMonths, setIntervalMonths] = useState(2);
  const [reward, setReward] = useState(10);
  const [reminderTime, setReminderTime] = useState('');
  const [busy, setBusy] = useState(false);

  function config() {
    if (recurrenceType === 'SPECIFIC_WEEKDAYS') return { weekdays };
    if (recurrenceType === 'TIMES_PER_WEEK') return { timesPerWeek };
    if (recurrenceType === 'EVERY_X_DAYS') return { intervalDays };
    if (recurrenceType === 'MONTHLY') return { dayOfMonth };
    if (recurrenceType === 'EVERY_X_MONTHS') return { intervalMonths, dayOfMonth };
    return {};
  }

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.post(`/goals/${goalId}/tasks`, {
        title: title.trim(),
        recurrenceType,
        recurrenceConfig: config(),
        reward,
        reminderTime: reminderTime || null,
      });
      push('Task added');
      setTitle('');
      onSaved();
      onClose();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not add the task', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a task"
      footer={
        <>
          <button className="btn-ghost px-4 py-2.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary px-4 py-2.5 text-sm"
            onClick={save}
            disabled={busy || !title.trim()}
            style={{ opacity: busy || !title.trim() ? 0.5 : 1 }}
          >
            {busy ? 'Adding…' : 'Add task'}
          </button>
        </>
      }
    >
      <label htmlFor="task-title" style={labelStyle}>
        Task name
      </label>
      <input
        id="task-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Stretch for 10 minutes"
        className="w-full px-4 py-3 text-sm mb-4"
        autoFocus
      />

      <label htmlFor="task-recurrence" style={labelStyle}>
        Repeats
      </label>
      <select
        id="task-recurrence"
        value={recurrenceType}
        onChange={(e) => setRecurrenceType(e.target.value as RecurrenceType)}
        className="w-full px-4 py-3 text-sm mb-4"
      >
        <option value="EVERY_DAY">Every day</option>
        <option value="SPECIFIC_WEEKDAYS">Specific weekdays</option>
        <option value="TIMES_PER_WEEK">X times per week</option>
        <option value="EVERY_X_DAYS">Every X days</option>
        <option value="MONTHLY">Monthly</option>
        <option value="EVERY_X_MONTHS">Every X months</option>
        <option value="ONCE">Once</option>
      </select>

      {recurrenceType === 'SPECIFIC_WEEKDAYS' && (
        <div className="mb-4">
          <label style={labelStyle}>On these days</label>
          <div className="flex gap-1.5 flex-wrap">
            {WEEKDAY_LABEL.map((label, index) => {
              const on = weekdays.includes(index);
              return (
                <button
                  key={label}
                  aria-pressed={on}
                  onClick={() =>
                    setWeekdays(
                      on ? weekdays.filter((d) => d !== index) : [...weekdays, index].sort(),
                    )
                  }
                  className="rounded-lg"
                  style={{
                    width: 44,
                    height: 40,
                    background: on ? '#f0ebff' : '#fff',
                    border: `1.5px solid ${on ? '#7c3aed' : '#e8e6f5'}`,
                    color: on ? '#7c3aed' : '#8b88b0',
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    fontFamily: 'Plus Jakarta Sans',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {recurrenceType === 'TIMES_PER_WEEK' && (
        <div className="mb-4">
          <label htmlFor="task-tpw" style={labelStyle}>
            Times per week
          </label>
          <input
            id="task-tpw"
            type="number"
            min={1}
            max={7}
            value={timesPerWeek}
            onChange={(e) => setTimesPerWeek(Number(e.target.value))}
            className="w-full px-4 py-3 text-sm"
          />
        </div>
      )}

      {recurrenceType === 'EVERY_X_DAYS' && (
        <div className="mb-4">
          <label htmlFor="task-interval" style={labelStyle}>
            Every how many days?
          </label>
          <input
            id="task-interval"
            type="number"
            min={1}
            value={intervalDays}
            onChange={(e) => setIntervalDays(Number(e.target.value))}
            className="w-full px-4 py-3 text-sm"
          />
        </div>
      )}

      {(recurrenceType === 'MONTHLY' || recurrenceType === 'EVERY_X_MONTHS') && (
        <div className="mb-4">
          {recurrenceType === 'EVERY_X_MONTHS' && (
            <>
              <label htmlFor="task-month-interval" style={labelStyle}>Every how many months?</label>
              <input id="task-month-interval" type="number" min={1} max={120}
                value={intervalMonths} onChange={(e) => setIntervalMonths(Number(e.target.value))}
                className="w-full px-4 py-3 text-sm mb-3" />
            </>
          )}
          <label htmlFor="task-month-day" style={labelStyle}>Day of month</label>
          <input id="task-month-day" type="number" min={1} max={31}
            value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))}
            className="w-full px-4 py-3 text-sm" />
        </div>
      )}

      <label htmlFor="task-reminder" style={labelStyle}>
        Reminder (optional)
      </label>
      <input
        id="task-reminder"
        type="time"
        value={reminderTime}
        onChange={(e) => setReminderTime(e.target.value)}
        className="w-full px-4 py-3 text-sm mb-4"
      />

      <label htmlFor="task-reward" style={labelStyle}>
        Reward
      </label>
      <div className="flex items-center gap-2">
        <input
          id="task-reward"
          type="range"
          min={0}
          max={50}
          step={5}
          value={reward}
          onChange={(e) => setReward(Number(e.target.value))}
          className="flex-1"
          style={{ border: 'none', background: 'transparent', padding: 0 }}
        />
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f59e0b', minWidth: 56 }}>
          +{reward}🪙
        </span>
      </div>
    </Modal>
  );
}
