import { ArrowRight, Check, Target, Trophy, Users, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';

const STEPS = [
  {
    icon: Target,
    title: 'Create a goal',
    body: 'Name what you want to achieve and break it into small recurring tasks.',
  },
  {
    icon: Check,
    title: 'Do it daily',
    body: "Your tasks show up when they're scheduled. Tick them off and build a streak.",
  },
  {
    icon: Users,
    title: 'Bring friends',
    body: 'Invite friends or join a public challenge, and compare progress as you go.',
  },
];

const FEATURES = [
  { emoji: '🔥', title: 'Streaks that make sense', body: 'Rest days never break your streak.' },
  { emoji: '🏆', title: 'Two leaderboards', body: 'Who is best today, and who is most consistent.' },
  { emoji: '🔒', title: 'Private by default', body: 'Share a goal only when you want to.' },
  { emoji: '🪙', title: 'Rewards worth chasing', body: 'Earn coins and unlock achievements.' },
];

export default function Landing() {
  return (
    <div style={{ background: '#f5f4ff', minHeight: '100vh' }}>
      {/* ------------------------------------------------------------ nav */}
      <header className="sticky top-0 z-50" style={{ background: 'rgba(245,244,255,0.85)', backdropFilter: 'blur(20px)' }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center rounded-xl"
              style={{
                width: 36,
                height: 36,
                background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
                boxShadow: '0 4px 12px rgba(124,58,237,0.4)',
              }}
            >
              <Zap size={18} fill="white" color="white" />
            </div>
            <span style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1.1rem', color: '#1a1635' }}>
              One Up
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <Link to="/login" className="btn-ghost px-4 py-2 text-sm">
              Log In
            </Link>
            <Link to="/register" className="btn-primary px-4 py-2 text-sm">
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------- hero */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse at 50% 0%, rgba(124,58,237,0.10) 0%, transparent 60%)' }}
        />
        <div className="max-w-6xl mx-auto px-5 sm:px-6 py-12 lg:py-20 relative">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <span
                className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 mb-6"
                style={{ background: '#f0ebff', border: '1px solid #ddd0ff', color: '#7c3aed', fontSize: '0.78rem', fontWeight: 700, fontFamily: 'Plus Jakarta Sans' }}
              >
                ⚡ Productivity, gamified
              </span>

              <h1
                style={{
                  fontFamily: 'Plus Jakarta Sans',
                  fontWeight: 900,
                  fontSize: 'clamp(2.1rem, 5.5vw, 3.4rem)',
                  color: '#1a1635',
                  lineHeight: 1.1,
                  letterSpacing: '-0.03em',
                }}
              >
                Turn your goals into{' '}
                <span className="gradient-text">fun social challenges.</span>
              </h1>

              <p
                className="mt-5 max-w-lg"
                style={{ fontSize: '1.05rem', color: '#6b688f', lineHeight: 1.65 }}
              >
                Set goals, complete daily challenges, stay consistent, and improve together with your
                friends. Your goals are more fun when you don't do them alone.
              </p>

              <div className="flex flex-col sm:flex-row gap-3 mt-8">
                <Link
                  to="/register"
                  className="btn-primary flex items-center justify-center gap-2 px-6 py-3.5 text-sm"
                >
                  Get Started free <ArrowRight size={16} />
                </Link>
                <Link to="/login" className="btn-ghost flex items-center justify-center px-6 py-3.5 text-sm">
                  Log In
                </Link>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-2 mt-7">
                {['Free to start', 'No credit card', 'Private by default'].map((item) => (
                  <span
                    key={item}
                    className="flex items-center gap-1.5"
                    style={{ fontSize: '0.82rem', color: '#8b88b0' }}
                  >
                    <Check size={14} style={{ color: '#7c3aed' }} /> {item}
                  </span>
                ))}
              </div>
            </div>

            {/* ------------------------------------------ product preview */}
            <div className="relative">
              <div className="card shadow-card-lg p-5 animate-float" style={{ borderRadius: 20 }}>
                <div className="flex items-center gap-3 mb-4">
                  <div
                    className="flex items-center justify-center rounded-xl"
                    style={{ width: 44, height: 44, fontSize: 20, background: '#f0ebff', border: '1px solid #ddd0ff' }}
                    aria-hidden="true"
                  >
                    🏋️
                  </div>
                  <div className="flex-1 min-w-0">
                    <div style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1rem', color: '#1a1635' }}>
                      Get Fit
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#8b88b0' }}>Fitness · 🔒 Private</div>
                  </div>
                  <div className="text-right">
                    <div style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, fontSize: '1.1rem', color: '#7c3aed' }}>
                      33%
                    </div>
                    <div style={{ fontSize: '0.65rem', color: '#b8b5d5' }}>complete</div>
                  </div>
                </div>

                <div className="progress-bar-track mb-5" style={{ height: 6 }}>
                  <div className="progress-bar-fill" style={{ width: '33%' }} />
                </div>

                <div
                  style={{ fontSize: '0.68rem', fontWeight: 700, color: '#8b88b0', letterSpacing: '0.06em', fontFamily: 'Plus Jakarta Sans', marginBottom: 8 }}
                >
                  TODAY'S TASKS
                </div>
                <div className="flex flex-col gap-1.5 mb-5">
                  {[
                    { title: 'Go to the gym', reward: 20, done: true },
                    { title: 'Walk 8,000 steps', reward: 15, done: false },
                    { title: 'Drink 2L of water', reward: 10, done: false },
                  ].map((task) => (
                    <div
                      key={task.title}
                      className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl"
                      style={{ background: task.done ? '#f5f4ff' : '#fff', border: '1px solid #e8e6f5' }}
                    >
                      <span
                        className="flex items-center justify-center rounded-full flex-shrink-0"
                        style={{
                          width: 20,
                          height: 20,
                          background: task.done ? 'linear-gradient(135deg, #7c3aed, #6d28d9)' : 'transparent',
                          border: task.done ? 'none' : '2px solid #ddd0ff',
                          color: '#fff',
                        }}
                        aria-hidden="true"
                      >
                        {task.done && <Check size={12} strokeWidth={3.5} />}
                      </span>
                      <span
                        className="flex-1"
                        style={{
                          fontSize: '0.82rem',
                          fontWeight: 600,
                          color: task.done ? '#8b88b0' : '#1a1635',
                          textDecoration: task.done ? 'line-through' : 'none',
                          fontFamily: 'Plus Jakarta Sans',
                        }}
                      >
                        {task.title}
                      </span>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#f59e0b' }}>
                        +{task.reward}🪙
                      </span>
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-4 mb-5">
                  <span style={{ fontSize: '0.78rem', color: '#f97316', fontWeight: 700 }}>
                    🔥 12 day streak
                  </span>
                  <span style={{ fontSize: '0.78rem', color: '#f59e0b', fontWeight: 700 }}>
                    🪙 145 today
                  </span>
                </div>

                <div
                  style={{ fontSize: '0.68rem', fontWeight: 700, color: '#8b88b0', letterSpacing: '0.06em', fontFamily: 'Plus Jakarta Sans', marginBottom: 8 }}
                >
                  LEADERBOARD
                </div>
                <div className="flex flex-col gap-1">
                  {[
                    { medal: '🥇', name: 'Alex', pct: 94, streak: 18, you: false },
                    { medal: '🥈', name: 'You', pct: 68, streak: 12, you: true },
                    { medal: '🥉', name: 'Maria', pct: 55, streak: 9, you: false },
                  ].map((row) => (
                    <div
                      key={row.name}
                      className="flex items-center gap-2.5 px-2.5 py-2 rounded-xl"
                      style={{
                        background: row.you ? '#f0ebff' : 'transparent',
                        border: `1px solid ${row.you ? '#ddd0ff' : 'transparent'}`,
                      }}
                    >
                      <span style={{ fontSize: 13 }}>{row.medal}</span>
                      <span
                        className="flex-1"
                        style={{
                          fontSize: '0.8rem',
                          fontWeight: row.you ? 700 : 500,
                          color: row.you ? '#7c3aed' : '#1a1635',
                        }}
                      >
                        {row.name}
                      </span>
                      <span style={{ fontSize: '0.78rem', fontWeight: 700, color: row.you ? '#7c3aed' : '#8b88b0' }}>
                        {row.pct}%
                      </span>
                      <span style={{ fontSize: 11, color: '#f97316' }}>🔥{row.streak}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- how it works */}
      <section className="max-w-6xl mx-auto px-5 sm:px-6 py-14 lg:py-20">
        <div className="text-center mb-12">
          <h2
            style={{
              fontFamily: 'Plus Jakarta Sans',
              fontWeight: 800,
              fontSize: 'clamp(1.6rem, 3.5vw, 2.25rem)',
              color: '#1a1635',
              letterSpacing: '-0.02em',
            }}
          >
            How it works
          </h2>
          <p className="mt-3" style={{ color: '#6b688f', fontSize: '1rem' }}>
            Three steps, then just keep showing up.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {STEPS.map(({ icon: Icon, title, body }, index) => (
            <div key={title} className="card shadow-card p-6">
              <div
                className="flex items-center justify-center rounded-xl mb-4"
                style={{
                  width: 44,
                  height: 44,
                  background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
                  boxShadow: '0 4px 12px rgba(124,58,237,0.3)',
                }}
              >
                <Icon size={20} color="white" />
              </div>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#b8b5d5', fontFamily: 'Plus Jakarta Sans', letterSpacing: '0.06em' }}>
                STEP {index + 1}
              </div>
              <h3
                className="mt-1"
                style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: '1.05rem', color: '#1a1635' }}
              >
                {title}
              </h3>
              <p className="mt-2" style={{ fontSize: '0.88rem', color: '#6b688f', lineHeight: 1.6 }}>
                {body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------ features */}
      <section className="max-w-6xl mx-auto px-5 sm:px-6 pb-14 lg:pb-20">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="card shadow-card p-5">
              <div style={{ fontSize: 26 }} aria-hidden="true">
                {feature.emoji}
              </div>
              <h3
                className="mt-3"
                style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: '0.95rem', color: '#1a1635' }}
              >
                {feature.title}
              </h3>
              <p className="mt-1.5" style={{ fontSize: '0.83rem', color: '#6b688f', lineHeight: 1.55 }}>
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------- cta */}
      <section className="max-w-6xl mx-auto px-5 sm:px-6 pb-16 lg:pb-24">
        <div
          className="rounded-3xl px-6 py-12 lg:py-16 text-center relative overflow-hidden"
          style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 55%, #3b82f6 100%)' }}
        >
          <Trophy size={34} color="white" className="mx-auto mb-4 opacity-90" />
          <h2
            style={{
              fontFamily: 'Plus Jakarta Sans',
              fontWeight: 800,
              fontSize: 'clamp(1.5rem, 3.5vw, 2.1rem)',
              color: '#fff',
              letterSpacing: '-0.02em',
            }}
          >
            Your goals are waiting.
          </h2>
          <p
            className="mt-3 max-w-md mx-auto"
            style={{ color: 'rgba(255,255,255,0.85)', fontSize: '1rem', lineHeight: 1.6 }}
          >
            Start today, invite a friend tomorrow, and see how far you get.
          </p>
          <Link
            to="/register"
            className="inline-flex items-center gap-2 mt-7 px-7 py-3.5 rounded-xl"
            style={{
              background: '#fff',
              color: '#7c3aed',
              fontFamily: 'Plus Jakarta Sans',
              fontWeight: 700,
              fontSize: '0.9rem',
            }}
          >
            Get Started free <ArrowRight size={16} />
          </Link>
        </div>
      </section>

      <footer className="max-w-6xl mx-auto px-5 sm:px-6 pb-10">
        <div
          className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-6"
          style={{ borderTop: '1px solid #e8e6f5' }}
        >
          <div className="flex items-center gap-2">
            <div
              className="flex items-center justify-center rounded-lg"
              style={{ width: 26, height: 26, background: 'linear-gradient(135deg, #7c3aed, #6d28d9)' }}
            >
              <Zap size={13} fill="white" color="white" />
            </div>
            <span style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: '0.85rem', color: '#1a1635' }}>
              One Up
            </span>
          </div>
          <span style={{ fontSize: '0.78rem', color: '#b8b5d5' }}>
            Turn your goals into fun social challenges.
          </span>
        </div>
      </footer>
    </div>
  );
}
