import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';

// Primitives shared across every screen. Colours, radii and shadows all come
// from the tokens in index.css so nothing here invents new styling.

/** One Up's supplied rising-step mark, isolated onto transparency for UI use. */
export function UpMarker({ size = 36, inverse = false }: { size?: number; inverse?: boolean }) {
  return (
    <img className={`oneup-source-mark${inverse ? ' oneup-source-mark--inverse' : ''}`} src="/assets/oneup-mark-transparent.png" width={size} height={size} alt="" aria-hidden="true" />
  );
}

/** Purpose-built empty-state character; intentionally abstract, never emoji. */
export function MomentumCompanion() {
  return (
    <div className="momentum-companion" aria-hidden="true">
      <span className="momentum-companion__body"><i /><i /></span>
      <span className="momentum-companion__trail"><i /><i /><i /></span>
    </div>
  );
}

export function ProgressBar({ value, height = 8 }: { value: number; height?: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="progress-bar-track w-full"
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-bar-fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function ProgressCircle({
  value,
  size = 72,
  stroke = 7,
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  children?: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (clamped / 100) * circumference}
          style={{ transition: 'stroke-dashoffset .5s cubic-bezier(.4,0,.2,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
}) {
  const tones = {
    neutral: { background: 'var(--surface-2)', color: 'var(--text-body)', border: 'var(--hairline)' },
    primary: { background: 'var(--surface-3)', color: 'var(--text)', border: 'var(--hairline-strong)' },
    success: { background: 'var(--green-tint)', color: 'var(--green)', border: 'var(--green-line)' },
    warning: { background: 'var(--note-tint)', color: 'var(--note-ink)', border: 'var(--note-line)' },
    danger: { background: 'var(--red-tint)', color: 'var(--red)', border: 'var(--red-line)' },
  }[tone];

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1"
      style={{
        background: tones.background,
        color: tones.color,
        border: `1px solid ${tones.border}`,
        fontSize: 11,
        fontWeight: 500,
        fontFamily: 'var(--font-sans)',
      }}
    >
      {children}
    </span>
  );
}

export function StreakBadge({ days, size = 'md' }: { days: number; size?: 'sm' | 'md' }) {
  return (
    <span
      className="inline-flex items-center gap-1"
      style={{
        color: 'var(--text-body)',
        fontWeight: 500,
        fontSize: size === 'sm' ? 11 : 13,
        fontFamily: 'var(--font-sans)',
        fontVariantNumeric: 'tabular-nums',
      }}
      title={`${days} day streak`}
    >
      <span className="mini-up-marker" aria-hidden="true"><i /><i /></span>
      {days} {size === 'sm' ? '' : days === 1 ? 'day' : 'days'}
    </span>
  );
}

export function PrivacyBadge({ visibility }: { visibility: 'PRIVATE' | 'PUBLIC' }) {
  return visibility === 'PRIVATE' ? (
    <Badge tone="neutral">🔒 Private</Badge>
  ) : (
    <Badge tone="primary">🌍 Public</Badge>
  );
}

export function Avatar({
  emoji,
  size = 38,
  ring = false,
}: {
  emoji: string;
  size?: number;
  ring?: boolean;
}) {
  return (
    <div
      className="flex-shrink-0 rounded-full flex items-center justify-center"
      style={{
        width: size,
        height: size,
        background: 'var(--surface-3)',
        fontSize: size * 0.45,
        boxShadow: ring ? '0 0 0 3px var(--hairline-strong)' : undefined,
      }}
      aria-hidden="true"
    >
      {emoji}
    </div>
  );
}

export function AvatarGroup({ people, max = 4 }: { people: Array<{ avatarEmoji: string; name: string }>; max?: number }) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((p, i) => (
        <div key={p.name + i} style={{ marginLeft: i === 0 ? 0 : -10 }} title={p.name}>
          <div style={{ boxShadow: '0 0 0 2px var(--bg)', borderRadius: 999 }}>
            <Avatar emoji={p.avatarEmoji} size={28} />
          </div>
        </div>
      ))}
      {extra > 0 && (
        <span
          className="flex items-center justify-center rounded-full"
          style={{
            marginLeft: -10,
            width: 28,
            height: 28,
            background: 'var(--surface-3)',
            color: 'var(--text)',
            border: '2px solid var(--bg)',
            fontSize: 10,
            fontWeight: 500,
          }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

export function EmptyState({
  emoji: _emoji,
  title,
  body,
  action,
}: {
  emoji: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="card shadow-card flex flex-col items-center text-center px-6 py-12">
      <MomentumCompanion />
      <h3 className="mt-3" style={{ fontSize: '1.15rem', fontWeight: 600, color: 'var(--text)' }}>
        {title}
      </h3>
      <p className="mt-1.5 max-w-sm" style={{ fontSize: '.9rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
        {body}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%', radius = 10 }: { height?: number; width?: string | number; radius?: number }) {
  return (
    <div
      style={{
        height,
        width,
        borderRadius: radius,
        background: 'linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 37%, var(--surface-2) 63%)',
        backgroundSize: '400% 100%',
        animation: 'shimmer 1.4s ease infinite',
      }}
      aria-hidden="true"
    />
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card shadow-card px-6 py-10 text-center" role="alert">
      <div style={{ fontSize: 34 }} aria-hidden="true">
        ⚠️
      </div>
      <p className="mt-2" style={{ fontWeight: 500, color: 'var(--text)' }}>
        {message}
      </p>
      {onRetry && (
        <button className="btn-secondary mt-4 px-4 py-2" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: 'rgba(17,18,19,0.4)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="card shadow-card-lg w-full sm:max-w-lg max-h-[85vh] overflow-y-auto animate-slide-up"
        style={{ borderRadius: '10px 10px 0 0' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="sticky top-0 flex items-center justify-between px-5 py-4"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--hairline)' }}
        >
          <h2 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text)' }}>{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center rounded-lg"
            style={{ width: 32, height: 32, color: 'var(--text-body)' }}
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="px-5 py-4 flex gap-3 justify-end" style={{ borderTop: '1px solid var(--hairline)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- toasts

interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'reward';
}

const ToastContext = createContext<{ push: (message: string, tone?: Toast['tone']) => void } | null>(
  null,
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2600);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="fixed z-[200] left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none"
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 84px)' }}
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="animate-resolve-in px-4 py-2.5 rounded-xl shadow-card-lg flex items-center gap-2"
            style={{
              background: toast.tone === 'error' ? 'var(--red-tint)' : 'var(--surface-2)',
              color: toast.tone === 'error' ? 'var(--red)' : 'var(--text)',
              border: `1px solid ${toast.tone === 'error' ? 'var(--red-line)' : 'var(--hairline-strong)'}`,
              fontFamily: 'var(--font-sans)',
              fontWeight: 500,
              fontSize: '.85rem',
            }}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

// ------------------------------------------------------------------- fetching

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fn()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1), setData };
}
