import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Globe, Lock, Plus, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../components/ui';
import { ApiError, api, browserTimezone } from '../lib/api';
import {
  CATEGORY_EMOJI,
  CATEGORY_LABEL,
  WEEKDAY_LABEL,
  describeRecurrence,
  type GoalCategory,
  type GoalVisibility,
  type RecurrenceType,
  type TargetType,
} from '../lib/types';

interface DraftTask {
  key: number;
  title: string;
  recurrenceType: RecurrenceType;
  weekdays: number[];
  timesPerWeek: number;
  intervalDays: number;
  dayOfMonth: number;
  intervalMonths: number;
  reward: number;
  reminderTime: string;
}

const STEPS = ['Goal', 'Target', 'Privacy', 'Tasks', 'Review'] as const;

const TARGETS: Array<{ type: TargetType; title: string; example: string; needsValue?: boolean }> = [
  { type: 'HABIT', title: 'Habit', example: 'Walk every day.' },
  { type: 'QUANTITY', title: 'Quantity', example: 'Read 10 books.', needsValue: true },
  { type: 'WEEKLY_TARGET', title: 'Weekly target', example: 'Gym 3 times per week.', needsValue: true },
  { type: 'DEADLINE', title: 'Deadline', example: 'Save $2,000 before June.' },
];

const labelStyle = {
  fontSize: '0.8rem',
  fontWeight: 700,
  color: '#4b4870',
  display: 'block',
  marginBottom: 6,
  fontFamily: 'Plus Jakarta Sans',
} as const;

const newTask = (): DraftTask => ({
  key: Date.now() + Math.random(),
  title: '',
  recurrenceType: 'EVERY_DAY',
  weekdays: [1, 3, 5],
  timesPerWeek: 3,
  intervalDays: 2,
  dayOfMonth: 1,
  intervalMonths: 2,
  reward: 10,
  reminderTime: '',
});

export default function CreateGoal() {
  const navigate = useNavigate();
  const { push } = useToast();

  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<GoalCategory>('FITNESS');
  const [targetType, setTargetType] = useState<TargetType>('HABIT');
  const [targetValue, setTargetValue] = useState<number>(10);
  const [deadline, setDeadline] = useState('');
  const [visibility, setVisibility] = useState<GoalVisibility>('PRIVATE');
  const [tasks, setTasks] = useState<DraftTask[]>([newTask()]);
  const today = (() => {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60_000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
  })();

  const target = TARGETS.find((t) => t.type === targetType)!;
  const validTasks = tasks.filter((t) => t.title.trim().length > 0);

  const canContinue = (() => {
    if (step === 0) return title.trim().length > 0;
    if (step === 1) {
      if (target.needsValue && (!targetValue || targetValue < 1)) return false;
      if (targetType === 'DEADLINE' && !deadline) return false;
      return true;
    }
    if (step === 3) return validTasks.length > 0;
    return true;
  })();

  function buildRecurrenceConfig(task: DraftTask) {
    switch (task.recurrenceType) {
      case 'SPECIFIC_WEEKDAYS':
        return { weekdays: task.weekdays };
      case 'TIMES_PER_WEEK':
        return { timesPerWeek: task.timesPerWeek };
      case 'EVERY_X_DAYS':
        return { intervalDays: task.intervalDays };
      case 'MONTHLY':
        return { dayOfMonth: task.dayOfMonth };
      case 'EVERY_X_MONTHS':
        return { intervalMonths: task.intervalMonths, dayOfMonth: task.dayOfMonth };
      default:
        return {};
    }
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const { goal } = await api.post<{ goal: { id: string } }>('/goals', {
        title: title.trim(),
        description: description.trim(),
        category,
        visibility,
        targetType,
        targetValue: target.needsValue ? targetValue : null,
        deadline: deadline || null,
        timezone: browserTimezone(),
        tasks: validTasks.map((task) => ({
          title: task.title.trim(),
          recurrenceType: task.recurrenceType,
          recurrenceConfig: buildRecurrenceConfig(task),
          reward: task.reward,
          reminderTime: task.reminderTime || null,
        })),
      });
      push('Goal created — let’s go 🎉');
      navigate(`/app/goals/${goal.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the goal');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-5 sm:p-6 lg:p-8 max-w-2xl mx-auto">
      <button
        onClick={() => (step === 0 ? navigate('/app/goals') : setStep(step - 1))}
        className="flex items-center gap-2 mb-5"
        style={{ color: '#8b88b0', fontSize: '0.875rem', fontWeight: 500 }}
      >
        <ArrowLeft size={15} /> {step === 0 ? 'Back to goals' : STEPS[step - 1]}
      </button>

      {/* step indicator */}
      <div className="flex items-center gap-1.5 mb-7" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((label, i) => (
          <div key={label} className="flex-1">
            <div
              style={{
                height: 4,
                borderRadius: 999,
                background: i <= step ? 'linear-gradient(90deg, #7c3aed, #a855f7)' : '#ede9f8',
                transition: 'background .3s',
              }}
            />
            <span
              className="hidden sm:block mt-1.5"
              style={{
                fontSize: 11,
                fontWeight: 700,
                fontFamily: 'Plus Jakarta Sans',
                color: i <= step ? '#7c3aed' : '#b8b5d5',
              }}
            >
              {label}
            </span>
          </div>
        ))}
      </div>

      <div className="card shadow-card p-6">
        {/* ------------------------------------------------ step 1: goal */}
        {step === 0 && (
          <>
            <h1 style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1.4rem', color: '#1a1635', letterSpacing: '-0.02em' }}>
              What do you want to achieve?
            </h1>
            <p style={{ color: '#8b88b0', fontSize: '0.875rem', marginTop: 4, marginBottom: 22 }}>
              Give it a name you'll recognise at a glance.
            </p>

            <div className="mb-4">
              <label htmlFor="title" style={labelStyle}>Goal name</label>
              <input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Get Fit"
                className="w-full px-4 py-3 text-sm"
                autoFocus
              />
            </div>

            <div className="mb-5">
              <label htmlFor="description" style={labelStyle}>Description</label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Become more active and improve my fitness."
                rows={3}
                className="w-full px-4 py-3 text-sm resize-none"
              />
            </div>

            <label style={labelStyle}>Category</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {(Object.keys(CATEGORY_LABEL) as GoalCategory[]).map((key) => (
                <button
                  key={key}
                  onClick={() => setCategory(key)}
                  aria-pressed={category === key}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-left"
                  style={{
                    background: category === key ? '#f0ebff' : '#fdfcff',
                    border: `1.5px solid ${category === key ? '#7c3aed' : '#e8e6f5'}`,
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    color: category === key ? '#7c3aed' : '#4b4870',
                    fontFamily: 'Plus Jakarta Sans',
                  }}
                >
                  <span aria-hidden="true">{CATEGORY_EMOJI[key]}</span>
                  {CATEGORY_LABEL[key]}
                </button>
              ))}
            </div>
          </>
        )}

        {/* ---------------------------------------------- step 2: target */}
        {step === 1 && (
          <>
            <h1 style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1.4rem', color: '#1a1635', letterSpacing: '-0.02em' }}>
              How will you measure it?
            </h1>
            <p style={{ color: '#8b88b0', fontSize: '0.875rem', marginTop: 4, marginBottom: 22 }}>
              Pick the shape that fits what you're going for.
            </p>

            <div className="flex flex-col gap-2.5 mb-5">
              {TARGETS.map((t) => (
                <button
                  key={t.type}
                  onClick={() => setTargetType(t.type)}
                  aria-pressed={targetType === t.type}
                  className="flex items-center gap-3 px-4 py-3.5 rounded-xl text-left"
                  style={{
                    background: targetType === t.type ? '#f0ebff' : '#fdfcff',
                    border: `1.5px solid ${targetType === t.type ? '#7c3aed' : '#e8e6f5'}`,
                  }}
                >
                  <span
                    className="flex items-center justify-center rounded-full flex-shrink-0"
                    style={{
                      width: 20,
                      height: 20,
                      border: targetType === t.type ? 'none' : '2px solid #ddd0ff',
                      background: targetType === t.type ? '#7c3aed' : 'transparent',
                      color: '#fff',
                    }}
                    aria-hidden="true"
                  >
                    {targetType === t.type && <Check size={12} strokeWidth={3.5} />}
                  </span>
                  <span className="flex-1">
                    <span className="block" style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: '0.9rem', color: '#1a1635' }}>
                      {t.title}
                    </span>
                    <span className="block" style={{ fontSize: '0.78rem', color: '#8b88b0', marginTop: 1 }}>
                      {t.example}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            {target.needsValue && (
              <div className="mb-4">
                <label htmlFor="targetValue" style={labelStyle}>
                  {targetType === 'QUANTITY' ? 'How many?' : 'How many times per week?'}
                </label>
                <input
                  id="targetValue"
                  type="number"
                  min={1}
                  value={targetValue}
                  onChange={(e) => setTargetValue(Number(e.target.value))}
                  className="w-full px-4 py-3 text-sm"
                />
              </div>
            )}

            <div>
              <label htmlFor="deadline" style={labelStyle}>
                Deadline {targetType === 'DEADLINE' ? '' : '(optional)'}
              </label>
              <input
                id="deadline"
                type="date"
                min={today}
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-full px-4 py-3 text-sm"
              />
            </div>
          </>
        )}

        {/* --------------------------------------------- step 3: privacy */}
        {step === 2 && (
          <>
            <h1 style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1.4rem', color: '#1a1635', letterSpacing: '-0.02em' }}>
              Who can see this?
            </h1>
            <p style={{ color: '#8b88b0', fontSize: '0.875rem', marginTop: 4, marginBottom: 22 }}>
              You can change this later.
            </p>

            <div className="flex flex-col gap-3">
              {([
                {
                  value: 'PRIVATE' as const,
                  icon: Lock,
                  title: 'Private',
                  body: 'Only you and people you invite can see this goal and its progress.',
                },
                {
                  value: 'PUBLIC' as const,
                  icon: Globe,
                  title: 'Public',
                  body: 'Anyone can discover this challenge and join in.',
                },
              ]).map(({ value, icon: Icon, title: t, body }) => (
                <button
                  key={value}
                  onClick={() => setVisibility(value)}
                  aria-pressed={visibility === value}
                  className="flex items-start gap-3.5 px-4 py-4 rounded-xl text-left"
                  style={{
                    background: visibility === value ? '#f0ebff' : '#fdfcff',
                    border: `1.5px solid ${visibility === value ? '#7c3aed' : '#e8e6f5'}`,
                  }}
                >
                  <span
                    className="flex items-center justify-center rounded-xl flex-shrink-0"
                    style={{
                      width: 40,
                      height: 40,
                      background: visibility === value ? '#7c3aed' : '#f5f4ff',
                      color: visibility === value ? '#fff' : '#8b88b0',
                    }}
                  >
                    <Icon size={18} />
                  </span>
                  <span className="flex-1">
                    <span className="block" style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: '0.95rem', color: '#1a1635' }}>
                      {t}
                    </span>
                    <span className="block" style={{ fontSize: '0.8rem', color: '#6b688f', marginTop: 2, lineHeight: 1.5 }}>
                      {body}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* ----------------------------------------------- step 4: tasks */}
        {step === 3 && (
          <>
            <h1 style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1.4rem', color: '#1a1635', letterSpacing: '-0.02em' }}>
              What will you actually do?
            </h1>
            <p style={{ color: '#8b88b0', fontSize: '0.875rem', marginTop: 4, marginBottom: 22 }}>
              These become your daily tasks. Small and repeatable beats ambitious.
            </p>

            <div className="flex flex-col gap-3">
              {tasks.map((task, index) => (
                <TaskEditor
                  key={task.key}
                  index={index}
                  task={task}
                  canRemove={tasks.length > 1}
                  onRemove={() => setTasks(tasks.filter((t) => t.key !== task.key))}
                  onChange={(next) =>
                    setTasks(tasks.map((t, i) => (i === index ? { ...t, ...next } : t)))
                  }
                />
              ))}
            </div>

            <button
              onClick={() => setTasks([...tasks, newTask()])}
              className="w-full mt-3 py-3.5 rounded-xl flex items-center justify-center gap-2"
              style={{ border: '1.5px dashed #ddd0ff', background: '#fdfcff', color: '#8b88b0', fontWeight: 700, fontSize: '0.85rem', fontFamily: 'Plus Jakarta Sans' }}
            >
              <Plus size={15} /> Add another task
            </button>
          </>
        )}

        {/* ---------------------------------------------- step 5: review */}
        {step === 4 && (
          <>
            <h1 style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1.4rem', color: '#1a1635', letterSpacing: '-0.02em' }}>
              Ready to activate?
            </h1>
            <p style={{ color: '#8b88b0', fontSize: '0.875rem', marginTop: 4, marginBottom: 22 }}>
              Your first tasks appear on Home as soon as you create this.
            </p>

            <div className="rounded-xl p-4 mb-4" style={{ background: '#f5f4ff', border: '1px solid #e8e6f5' }}>
              <div className="flex items-center gap-3 mb-3">
                <span style={{ fontSize: 24 }} aria-hidden="true">{CATEGORY_EMOJI[category]}</span>
                <div className="min-w-0">
                  <div className="truncate" style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1.05rem', color: '#1a1635' }}>
                    {title || 'Untitled goal'}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#8b88b0' }}>
                    {CATEGORY_LABEL[category]} · {visibility === 'PRIVATE' ? '🔒 Private' : '🌍 Public'}
                  </div>
                </div>
              </div>
              {description && (
                <p style={{ fontSize: '0.83rem', color: '#6b688f', lineHeight: 1.55 }}>{description}</p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              {validTasks.map((task) => (
                <div
                  key={task.key}
                  className="flex items-center gap-3 px-3.5 py-3 rounded-xl"
                  style={{ background: '#fff', border: '1px solid #e8e6f5' }}
                >
                  <span
                    className="rounded-full flex-shrink-0"
                    style={{ width: 20, height: 20, border: '2px solid #ddd0ff' }}
                    aria-hidden="true"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate" style={{ fontSize: '0.88rem', fontWeight: 600, color: '#1a1635', fontFamily: 'Plus Jakarta Sans' }}>
                      {task.title}
                    </span>
                    <span className="block" style={{ fontSize: '0.72rem', color: '#b8b5d5' }}>
                      {describeRecurrence({
                        recurrenceType: task.recurrenceType,
                        recurrenceConfig: buildRecurrenceConfig(task),
                      })}
                      {task.reminderTime ? ` · ${task.reminderTime}` : ''}
                    </span>
                  </span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#f59e0b' }}>
                    +{task.reward}🪙
                  </span>
                </div>
              ))}
            </div>

            {error && (
              <div
                className="mt-4 px-4 py-3 rounded-xl"
                style={{ background: '#ffeef0', border: '1px solid #ffd3d9', color: '#c8253c', fontSize: '0.85rem', fontWeight: 600 }}
                role="alert"
              >
                {error}
              </div>
            )}
          </>
        )}

        {/* ------------------------------------------------- navigation */}
        <div className="flex gap-3 mt-7">
          {step > 0 && (
            <button className="btn-ghost px-5 py-3 text-sm" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button
              className="btn-primary flex-1 py-3 text-sm flex items-center justify-center gap-2"
              disabled={!canContinue}
              style={{ opacity: canContinue ? 1 : 0.5, cursor: canContinue ? 'pointer' : 'not-allowed' }}
              onClick={() => canContinue && setStep(step + 1)}
            >
              Continue <ArrowRight size={15} />
            </button>
          ) : (
            <button
              className="btn-primary flex-1 py-3 text-sm"
              onClick={submit}
              disabled={saving}
              style={{ opacity: saving ? 0.7 : 1 }}
            >
              {saving ? 'Creating…' : 'Activate Goal'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskEditor({
  task,
  index,
  canRemove,
  onRemove,
  onChange,
}: {
  task: DraftTask;
  index: number;
  canRemove: boolean;
  onRemove: () => void;
  onChange: (next: Partial<DraftTask>) => void;
}) {
  const recurrenceOptions: Array<{ value: RecurrenceType; label: string }> = [
    { value: 'EVERY_DAY', label: 'Every day' },
    { value: 'SPECIFIC_WEEKDAYS', label: 'Specific weekdays' },
    { value: 'TIMES_PER_WEEK', label: 'X times per week' },
    { value: 'EVERY_X_DAYS', label: 'Every X days' },
    { value: 'MONTHLY', label: 'Monthly' },
    { value: 'EVERY_X_MONTHS', label: 'Every X months' },
    { value: 'ONCE', label: 'Once' },
  ];

  return (
    <fieldset className="rounded-xl p-4" style={{ background: '#fdfcff', border: '1px solid #e8e6f5' }}>
      <legend className="sr-only">Task {index + 1}</legend>
      <div className="flex items-center gap-2 mb-3">
        <label className="sr-only" htmlFor={`task-title-${index}`}>Task {index + 1} name</label>
        <input
          id={`task-title-${index}`}
          value={task.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="e.g. Walk 8,000 steps"
          className="flex-1 px-3.5 py-2.5 text-sm"
          aria-label={`Task ${index + 1} name`}
        />
        {canRemove && (
          <button
            onClick={onRemove}
            aria-label={`Remove task ${index + 1}`}
            className="flex items-center justify-center rounded-lg flex-shrink-0"
            style={{ width: 38, height: 38, color: '#b8b5d5', border: '1px solid #e8e6f5', background: '#fff' }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <label htmlFor={`task-repeats-${index}`} style={{ ...labelStyle, fontSize: '0.72rem' }}>Repeats</label>
          <select
            id={`task-repeats-${index}`}
            value={task.recurrenceType}
            onChange={(e) => onChange({ recurrenceType: e.target.value as RecurrenceType })}
            className="w-full px-3 py-2.5 text-sm"
          >
            {recurrenceOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={`task-reminder-${index}`} style={{ ...labelStyle, fontSize: '0.72rem' }}>Reminder (optional)</label>
          <input
            id={`task-reminder-${index}`}
            type="time"
            value={task.reminderTime}
            onChange={(e) => onChange({ reminderTime: e.target.value })}
            className="w-full px-3 py-2.5 text-sm"
          />
        </div>
      </div>

      {task.recurrenceType === 'SPECIFIC_WEEKDAYS' && (
        <div className="mt-3">
          <label style={{ ...labelStyle, fontSize: '0.72rem' }}>On these days</label>
          <div className="flex gap-1.5 flex-wrap">
            {WEEKDAY_LABEL.map((label, index) => {
              const on = task.weekdays.includes(index);
              return (
                <button
                  key={label}
                  aria-pressed={on}
                  onClick={() =>
                    onChange({
                      weekdays: on
                        ? task.weekdays.filter((d) => d !== index)
                        : [...task.weekdays, index].sort(),
                    })
                  }
                  className="rounded-lg"
                  style={{
                    width: 42,
                    height: 38,
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

      {task.recurrenceType === 'TIMES_PER_WEEK' && (
        <div className="mt-3">
          <label style={{ ...labelStyle, fontSize: '0.72rem' }}>Times per week</label>
          <input
            type="number"
            min={1}
            max={7}
            value={task.timesPerWeek}
            onChange={(e) => onChange({ timesPerWeek: Number(e.target.value) })}
            className="w-full px-3 py-2.5 text-sm"
          />
          <p style={{ fontSize: '0.72rem', color: '#b8b5d5', marginTop: 6 }}>
            Do it on any days you like — it only counts against you if the week runs short.
          </p>
        </div>
      )}

      {task.recurrenceType === 'EVERY_X_DAYS' && (
        <div className="mt-3">
          <label style={{ ...labelStyle, fontSize: '0.72rem' }}>Every how many days?</label>
          <input
            type="number"
            min={1}
            value={task.intervalDays}
            onChange={(e) => onChange({ intervalDays: Number(e.target.value) })}
            className="w-full px-3 py-2.5 text-sm"
          />
        </div>
      )}

      {(task.recurrenceType === 'MONTHLY' || task.recurrenceType === 'EVERY_X_MONTHS') && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {task.recurrenceType === 'EVERY_X_MONTHS' && (
            <div>
              <label style={{ ...labelStyle, fontSize: '0.72rem' }}>Every how many months?</label>
              <input type="number" min={1} max={120} value={task.intervalMonths}
                onChange={(e) => onChange({ intervalMonths: Number(e.target.value) })}
                className="w-full px-3 py-2.5 text-sm" />
            </div>
          )}
          <div>
            <label style={{ ...labelStyle, fontSize: '0.72rem' }}>Day of month</label>
            <input type="number" min={1} max={31} value={task.dayOfMonth}
              onChange={(e) => onChange({ dayOfMonth: Number(e.target.value) })}
              className="w-full px-3 py-2.5 text-sm" />
          </div>
        </div>
      )}

      <div className="mt-3">
        <label style={{ ...labelStyle, fontSize: '0.72rem' }}>Reward</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={50}
            step={5}
            value={task.reward}
            onChange={(e) => onChange({ reward: Number(e.target.value) })}
            className="flex-1"
            style={{ border: 'none', background: 'transparent', padding: 0 }}
            aria-label="Reward coins"
          />
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#f59e0b', minWidth: 52 }}>
            +{task.reward}🪙
          </span>
        </div>
      </div>
    </fieldset>
  );
}
