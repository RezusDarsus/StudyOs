import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Zap } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Modal } from '../components/ui';

const labelStyle = {
  fontSize: '0.8rem',
  fontWeight: 700,
  color: '#4b4870',
  display: 'block',
  marginBottom: 6,
  fontFamily: 'Plus Jakarta Sans',
} as const;

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-1.5" style={{ fontSize: '0.75rem', color: '#c8253c', fontWeight: 600 }} role="alert">
      {message}
    </p>
  );
}

export default function Auth({ mode }: { mode: 'login' | 'register' }) {
  const isLogin = mode === 'login';
  const navigate = useNavigate();
  const { login, register } = useAuth();

  const [showPass, setShowPass] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string[] | undefined>>({});
  const [forgotOpen, setForgotOpen] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setFormError(null);
    setFields({});

    // Confirm-password is checked here too so the user gets the message without
    // a round trip; the server enforces the same rule regardless.
    if (!isLogin && password !== confirmPassword) {
      setFields({ confirmPassword: ['Passwords do not match'] });
      return;
    }

    setSubmitting(true);
    try {
      if (isLogin) await login(email, password);
      else await register({ name, email, password, confirmPassword });
      navigate('/app', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.fields ? null : err.message);
        setFields(err.fields ?? {});
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10" style={{ background: '#f5f4ff' }}>
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at 50% 0%, rgba(124,58,237,0.07) 0%, transparent 60%)' }}
      />

      <div className="w-full max-w-md relative">
        <Link
          to="/"
          className="flex items-center gap-2 mb-6"
          style={{ color: '#8b88b0', fontSize: '0.875rem', fontWeight: 500 }}
        >
          <ArrowLeft size={15} /> Back to home
        </Link>

        <form onSubmit={onSubmit} className="rounded-2xl p-8 bg-white shadow-card-lg" style={{ border: '1px solid #e8e6f5' }} noValidate>
          <div className="flex items-center gap-2.5 mb-8">
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
            <span style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1.1rem', color: '#1a1635' }}>
              One Up
            </span>
          </div>

          <h1
            style={{
              fontFamily: 'Plus Jakarta Sans',
              fontWeight: 800,
              fontSize: '1.55rem',
              color: '#1a1635',
              marginBottom: 5,
              letterSpacing: '-0.02em',
            }}
          >
            {isLogin ? 'Welcome back!' : 'Start achieving your goals.'}
          </h1>
          <p style={{ color: '#8b88b0', fontSize: '0.875rem', marginBottom: '1.75rem' }}>
            {isLogin ? "Let's pick up where you left off." : 'Create your free account and start today.'}
          </p>

          {formError && (
            <div
              className="mb-4 px-4 py-3 rounded-xl"
              style={{ background: '#ffeef0', border: '1px solid #ffd3d9', color: '#c8253c', fontSize: '0.85rem', fontWeight: 600 }}
              role="alert"
            >
              {formError}
            </div>
          )}

          <div className="flex flex-col gap-4">
            {!isLogin && (
              <div>
                <label htmlFor="name" style={labelStyle}>
                  Full Name
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-3 text-sm"
                  aria-invalid={Boolean(fields.name)}
                />
                <FieldError message={fields.name?.[0]} />
              </div>
            )}

            <div>
              <label htmlFor="email" style={labelStyle}>
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 text-sm"
                aria-invalid={Boolean(fields.email)}
              />
              <FieldError message={fields.email?.[0]} />
            </div>

            <div>
              <label htmlFor="password" style={labelStyle}>
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPass ? 'text' : 'password'}
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 text-sm pr-11"
                  aria-invalid={Boolean(fields.password)}
                  aria-describedby={isLogin ? undefined : 'password-hint'}
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                  style={{ color: '#b8b5d5' }}
                  aria-label={showPass ? 'Hide password' : 'Show password'}
                >
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <FieldError message={fields.password?.[0]} />
              {!isLogin && !fields.password && (
                <p id="password-hint" className="mt-1.5" style={{ fontSize: '0.72rem', color: '#b8b5d5' }}>
                  At least 8 characters, including a letter and a number.
                </p>
              )}
            </div>

            {!isLogin && (
              <div>
                <label htmlFor="confirmPassword" style={labelStyle}>
                  Confirm Password
                </label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-4 py-3 text-sm"
                  aria-invalid={Boolean(fields.confirmPassword)}
                />
                <FieldError message={fields.confirmPassword?.[0]} />
              </div>
            )}

            {isLogin && (
              <div className="text-right">
                <button
                  type="button"
                  onClick={() => setForgotOpen(true)}
                  className="text-sm"
                  style={{ color: '#7c3aed', fontWeight: 700, fontFamily: 'Plus Jakarta Sans' }}
                >
                  Forgot password?
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="btn-primary w-full py-3.5 text-sm flex items-center justify-center gap-2 mt-1"
              style={{ opacity: submitting ? 0.7 : 1 }}
            >
              {submitting ? 'Just a moment…' : isLogin ? 'Log In' : 'Create Account'}
              {!submitting && <ArrowRight size={15} />}
            </button>
          </div>

          <p className="text-center mt-5" style={{ fontSize: '0.85rem', color: '#8b88b0' }}>
            {isLogin ? "Don't have an account? " : 'Already have an account? '}
            <Link
              to={isLogin ? '/register' : '/login'}
              style={{ color: '#7c3aed', fontWeight: 700, fontFamily: 'Plus Jakarta Sans' }}
            >
              {isLogin ? 'Sign up free' : 'Log in'}
            </Link>
          </p>
        </form>

        {!isLogin && (
          <p className="text-center mt-4" style={{ fontSize: '0.75rem', color: '#b8b5d5' }}>
            By creating an account, you agree to our Terms of Service and Privacy Policy.
          </p>
        )}
      </div>

      <ForgotPasswordModal open={forgotOpen} onClose={() => setForgotOpen(false)} />
    </div>
  );
}

function ForgotPasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setSent(false);
      }}
      title="Reset your password"
      footer={
        !sent && (
          <>
            <button className="btn-ghost px-4 py-2.5 text-sm" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary px-4 py-2.5 text-sm" onClick={submit} disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </>
        )
      }
    >
      {sent ? (
        <p style={{ fontSize: '0.9rem', color: '#4b4870', lineHeight: 1.6 }}>
          If an account exists for <strong>{email}</strong>, a reset link is on its way. Check your
          inbox and spam folder.
        </p>
      ) : (
        <>
          <label htmlFor="reset-email" style={labelStyle}>
            Email
          </label>
          <input
            id="reset-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full px-4 py-3 text-sm"
          />
        </>
      )}
    </Modal>
  );
}
