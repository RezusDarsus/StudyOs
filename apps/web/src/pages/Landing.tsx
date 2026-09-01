import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  LockKeyhole,
  Monitor,
  RefreshCw,
  Route,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Tablet,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { UpMarker } from '../components/ui';
import ProductFilm from '../components/ProductFilm';

function UpMark({ size = 36, light = false }: { size?: number; light?: boolean }) {
  return <UpMarker size={size} inverse={light} />;
}

function PulseNode({ label, tone = 'tide' }: { label: string; tone?: 'tide' | 'leaf' | 'persimmon' }) {
  return (
    <span className={`landing-pulse landing-pulse--${tone}`} aria-label={label}>
      <span aria-hidden="true" />
    </span>
  );
}

function SectionIntro({
  eyebrow,
  title,
  body,
  align = 'left',
}: {
  eyebrow: string;
  title: string;
  body: string;
  align?: 'left' | 'center';
}) {
  return (
    <div className={`landing-section-intro landing-section-intro--${align}`}>
      <p className="landing-eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p className="landing-section-copy">{body}</p>
    </div>
  );
}

function ProductChrome({ label, status }: { label: string; status: string }) {
  return (
    <div className="landing-product-chrome">
      <span><UpMark size={24} />{label}</span>
      <span className="landing-chrome-status"><i />{status}</span>
    </div>
  );
}

function PlanningScene() {
  return (
    <div className="landing-planning-scene">
      <div className="landing-interview">
        <div className="landing-scene-kicker"><Sparkles size={16} /> Coach interview</div>
        <div className="landing-chat landing-chat--coach">What usually gets in the way?</div>
        <div className="landing-chat landing-chat--user">I schedule workouts that are too ambitious for busy days.</div>
        <div className="landing-choice-list" aria-label="Planning priorities">
          <span className="landing-choice landing-choice--active"><Check size={13} /> Make it easy to restart</span>
          <span className="landing-choice">Prefer weekday mornings</span>
          <span className="landing-choice">Keep weekends flexible</span>
        </div>
      </div>
      <div className="landing-planning-trail" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="landing-plan-ladder">
        <div className="landing-scene-kicker"><Route size={16} /> Plan logic</div>
        {[
          ['01', 'Start below your limit', '12 min · easy'],
          ['02', 'Repeat before adding', '3 sessions'],
          ['03', 'Increase one variable', '+2 min'],
        ].map(([step, title, meta], index) => (
          <div className="landing-ladder-step" key={step}>
            <span className="mono">{step}</span>
            <div><strong>{title}</strong><small>{meta}</small></div>
            {index === 0 ? <span className="landing-reason">Because consistency is the goal</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function DailyLoopScene() {
  const days = [
    ['Ask', 'How is today?', '01'],
    ['Act', '12 min easy', '02'],
    ['Confirm', 'Done at 8:14', '03'],
    ['Adapt', 'Next: 14 min', '04'],
  ];
  return (
    <div className="landing-daily-scene">
      <ProductChrome label="Build the rhythm" status="Synced just now" />
      <div className="landing-day-header">
        <div><span className="landing-mini-label">TUESDAY · WEEK 1</span><h3>One useful action, then move on.</h3></div>
        <div className="landing-daily-progress"><span className="mono">1 of 3</span><span className="landing-progress-track"><i /></span></div>
      </div>
      <div className="landing-day-strip">
        {days.map(([title, detail, step], index) => (
          <div className={`landing-day-step${index === 2 ? ' landing-day-step--complete' : ''}`} key={title}>
            <div className="landing-day-node">{index === 2 ? <Check size={16} strokeWidth={3} /> : <span className="mono">{step}</span>}</div>
            <strong>{title}</strong><small>{detail}</small>
          </div>
        ))}
      </div>
      <div className="landing-daily-note"><RefreshCw size={16} /><span><strong>Plan adjusted quietly.</strong> Thursday changed from 16 to 14 minutes after today’s effort.</span></div>
    </div>
  );
}


function ContinuityScene() {
  const [complete, setComplete] = useState(false);
  return (
    <div className="landing-relay" aria-label="A goal moving from phone to tablet to desktop">
      <div className="landing-relay-path" aria-hidden="true"><span /><span /><span /></div>
      <div className="landing-device landing-device--phone">
        <div className="landing-device-top"><Smartphone size={16} /><span><strong>On the move</strong><small>Today · 8:10 AM</small></span></div>
        <span className="landing-mini-label">NEXT ACTION</span>
        <h3>12-minute run</h3>
        <button type="button" className="landing-demo-action" aria-pressed={complete} onClick={() => setComplete(!complete)}><Check size={15} />{complete ? 'Completed · undo' : 'Try marking complete'}</button>
      </div>
      <div className="landing-device landing-device--tablet">
        <div className="landing-device-top"><Tablet size={16} /><span><strong>At a glance</strong><small>{complete ? 'Demo updated from phone' : 'Interactive example'}</small></span></div>
        <span className="landing-mini-label">THIS WEEK</span>
        <div className="landing-tablet-days" aria-label="Weekly sessions"><span className={complete ? 'done' : 'active'}>Tue{complete && <Check size={14} />}</span><span>Thu</span><span>Sun</span></div>
        <p aria-live="polite">{complete ? '1 of 3 complete · 2 left' : '0 of 3 complete · 3 left'}</p>
      </div>
      <div className="landing-device landing-device--desktop">
        <div className="landing-device-top"><Monitor size={16} /><span><strong>Plan view</strong><small>{complete ? 'Run marked complete' : 'Run ready for today'}</small></span></div>
        <div className="landing-desktop-plan"><div className={complete ? 'is-complete' : ''}>{complete ? <Check size={15} /> : <Clock3 size={15} />}<span>12-minute easy run</span><small>{complete ? 'Done' : 'Today'}</small></div><div><Clock3 size={15} /><span>14-minute run + walk</span><small>Thu</small></div><div><Clock3 size={15} /><span>16-minute easy run</span><small>Sun</small></div></div>
        <p><strong>Build the rhythm</strong><small>See the whole plan, together.</small></p>
      </div>
    </div>
  );
}

function SocialScene() {
  return (
    <div className="landing-social-field" aria-label="Three friends contributing to one shared challenge milestone">
      <ProductChrome label="Run steady · Private challenge" status="3 people active" />
      <div className="landing-person landing-person--one"><span>Y</span><strong>You</strong><small>Completed · 8:14 AM</small></div>
      <div className="landing-person landing-person--two"><span>M</span><strong>Maya</strong><small>Checked in · 2m ago</small></div>
      <div className="landing-person landing-person--three"><span>A</span><strong>Alex</strong><small>Rest day protected</small></div>
      <svg className="landing-social-lines" viewBox="0 0 720 360" role="presentation" aria-hidden="true">
        <path d="M130 80 C 270 80, 245 180, 360 180" />
        <path d="M590 80 C 450 80, 475 180, 360 180" />
        <path d="M160 295 C 260 295, 280 180, 360 180" />
      </svg>
      <div className="landing-group-node"><PulseNode label="Group milestone reached" tone="persimmon" /><strong>9 / 12 actions</strong><small>Group week</small></div>
      <div className="landing-encouragement"><Users size={16} /><span>Maya sent encouragement</span><strong>Keep the easy pace.</strong></div>
    </div>
  );
}

function ProgressionScene() {
  const [reviewOpen, setReviewOpen] = useState(false);
  return (
    <div className="landing-progression-scene">
      <div className="landing-progression-chrome"><ProductChrome label="Coach review" status="Draft change" /></div>
      <div className="landing-stage-rail">
        {[
          ['Foundation', '12–16 min', 'complete'],
          ['Rhythm', '18–22 min', 'active'],
          ['Capacity', '24–30 min', 'future'],
          ['Independence', 'Your own pace', 'future'],
        ].map(([name, target, state]) => (
          <div className={`landing-stage landing-stage--${state}`} key={name}>
            <span>{state === 'complete' ? <Check size={14} /> : null}</span>
            <div><strong>{name}</strong><small>{target}</small></div>
          </div>
        ))}
      </div>
      <div className="landing-adaptation-card">
        <span className="landing-mini-label">NEXT WEEK’S CHANGE · PREVIEW</span>
        <div className="landing-change-values"><span><small>Before</small><strong className="mono">18 min</strong></span><ArrowRight /><span><small>After</small><strong className="mono">20 min</strong></span></div>
        <div className="landing-reason-box"><Sparkles size={16} /><p><strong>Why this changed</strong>You completed all three sessions and rated the last two “comfortable.” Only duration moves; pace stays easy.</p></div>
        <button type="button" className="landing-demo-secondary" aria-expanded={reviewOpen} aria-controls="landing-review-detail" onClick={() => setReviewOpen(!reviewOpen)}>{reviewOpen ? 'Close example review' : 'Review this example'}<ChevronRight size={15} /></button>
        {reviewOpen && <div id="landing-review-detail" className="landing-review-detail"><strong>You decide what changes.</strong><p>This example adds two minutes, keeps the easy pace, and preserves your rest days. Nothing here changes an account or saves a plan.</p><Link to="/register">Build your own plan <ArrowRight size={14} /></Link></div>}
      </div>
    </div>
  );
}

const proofEvents = [
  {
    icon: Sparkles,
    time: '08:02',
    eyebrow: 'PRODUCT-BEHAVIOR EXAMPLE',
    title: 'AI reason shown before save',
    state: 'Needs your review',
    details: ['Suggestion: increase 18 → 20 min', 'Reason: 3 sessions complete; last 2 felt comfortable'],
  },
  {
    icon: CheckCircle2,
    time: '08:06',
    eyebrow: 'PRODUCT-BEHAVIOR EXAMPLE',
    title: 'Change reviewed by the user',
    state: 'Accepted by you',
    details: ['20-minute target saved', 'Pace remains easy'],
  },
  {
    icon: RefreshCw,
    time: 'SUN',
    eyebrow: 'PRODUCT-BEHAVIOR EXAMPLE',
    title: 'Rest day preserved',
    state: 'Cadence intact',
    details: ['0 tasks scheduled', 'Recovery does not break the plan'],
  },
  {
    icon: LockKeyhole,
    time: '09:18',
    eyebrow: 'PRODUCT-BEHAVIOR EXAMPLE',
    title: 'Audience remains private',
    state: 'Invite only',
    details: ['Visible to you, Maya, and Alex', 'Not listed in public challenges'],
  },
];

export default function Landing() {
  return (
    <div className="landing-page">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <header className="landing-header">
        <div className="landing-shell landing-nav">
          <Link to="/" className="landing-brand" aria-label="One Up home"><UpMark /><span>One Up</span></Link>
          <nav className="landing-nav-links" aria-label="Main navigation">
            <a href="#how-it-works">How it works</a>
            <a href="#together">Together</a>
            <Link to="/login">Log in</Link>
            <Link to="/register" className="landing-nav-cta">Start a goal <ArrowRight size={15} /></Link>
          </nav>
        </div>
      </header>

      <main id="main-content">
        <section className="landing-hero" id="momentum">
          <div className="landing-shell">
            <div className="landing-hero-copy">
              <h1>Turn an intention into momentum you can feel.</h1>
              <p>One Up shapes a realistic plan, keeps today clear, and lets the right people move forward with you.</p>
              <div className="landing-hero-actions">
                <Link to="/register" className="landing-primary-action">Build my first plan <ArrowRight size={17} /></Link>
                <a href="#product-film" className="landing-secondary-action">Watch how it works</a>
              </div>
            </div>
            <ProductFilm />
            <div className="landing-trust-line"><span><CheckCircle2 size={16} /> Free to start</span><span><LockKeyhole size={16} /> Private by default</span><span><Clock3 size={16} /> A useful first plan in minutes</span></div>
          </div>
        </section>

        <section className="landing-section landing-planning" id="how-it-works">
          <div className="landing-shell landing-split-heading">
            <SectionIntro eyebrow="01 · AI PLANNING" title="A plan that starts by listening." body="The coach asks about your constraints, pace, and definition of success. Then it shows the logic—not a magic answer." />
            <p className="landing-aside-note">AI is useful here because it turns context into a plan you can inspect and change.</p>
          </div>
          <div className="landing-shell"><PlanningScene /></div>
        </section>

        <section className="landing-section landing-daily">
          <div className="landing-shell">
            <SectionIntro eyebrow="02 · THE DAILY LOOP" title="Today stays small. Progress keeps moving." body="One clear action meets you where you are. Complete it, share how it felt, and tomorrow adjusts without drama." align="center" />
            <DailyLoopScene />
          </div>
        </section>

<section className="landing-section landing-continuity">
          <div className="landing-shell landing-continuity-layout">
            <div className="landing-continuity-copy">
              <SectionIntro eyebrow="04 · CONTINUITY" title="Pick up the same goal, wherever the day takes you." body="A quick action on your phone, a weekly glance on your tablet, the full plan on desktop. Try the example below: one check-in updates every view." />
              <div className="landing-continuity-caption"><Route size={18} /><span><strong>One goal. The right amount of detail.</strong> Your latest progress travels with the plan.</span></div>
            </div>
            <ContinuityScene />
          </div>
        </section>

        <section className="landing-section landing-social" id="together">
          <div className="landing-shell">
            <div className="landing-social-heading"><SectionIntro eyebrow="05 · TOGETHER" title="Accountability without the performance." body="Invite the people who help you keep going. Individual trails converge on a shared milestone—without turning every goal into a competition." /><p>Friends can encourage, check in, and move at their own pace.</p></div>
            <SocialScene />
          </div>
        </section>

        <section className="landing-section landing-progression">
          <div className="landing-shell landing-progression-layout">
            <SectionIntro eyebrow="06 · ADAPTIVE PROGRESSION" title="Grow the challenge, not the pressure." body="When your pattern changes, One Up suggests the smallest useful adjustment and explains why. You stay in control of the next step." />
            <ProgressionScene />
          </div>
        </section>

        <section className="landing-section landing-proof">
          <div className="landing-shell">
            <div className="landing-proof-heading"><SectionIntro eyebrow="07 · YOUR PLAN, YOUR CALL" title="A little guidance. The final say stays yours." body="Review a suggestion, protect a rest day, and choose who comes along. These examples show the controls—not customer results." /><span className="landing-honesty-badge"><ShieldCheck size={16} /> Product examples</span></div>
            <div className="landing-proof-window">
              <ProductChrome label="Your choices in practice" status="Example journey" />
              <div className="landing-proof-rail" tabIndex={0} aria-label="Example product controls; scroll horizontally for more">
                {proofEvents.map(({ icon: Icon, time, eyebrow, title, state, details }, index) => (
                <article className={`landing-proof-event landing-proof-event--${index + 1}`} key={title}>
                  <div className="landing-proof-event-head"><span className="mono">{time}</span><span>{eyebrow}</span></div>
                  <div className="landing-proof-event-icon"><Icon size={21} /></div>
                  <h3>{title}</h3>
                  <span className="landing-proof-state"><i />{state}</span>
                  <div className="landing-proof-details">
                    {details.map((detail) => <p key={detail}><Check size={13} />{detail}</p>)}
                  </div>
                </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="landing-closing">
          <div className="landing-shell landing-closing-inner">
            <div className="landing-closing-mark"><UpMark size={84} light /><span className="landing-closing-trail" aria-hidden="true"><i /><i /><i /></span></div>
            <div><h2>Start with the goal that keeps coming back.</h2><p>Tell One Up what you want, what gets in the way, and who you want beside you.</p></div>
            <Link to="/register" className="landing-primary-action">Build my first plan <ArrowRight size={18} /></Link>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-shell"><Link to="/" className="landing-brand"><UpMark size={30} /><span>One Up</span></Link><p>Shared momentum for goals that matter.</p><div><Link to="/login">Log in</Link><Link to="/register">Get started</Link></div></div>
      </footer>
    </div>
  );
}
