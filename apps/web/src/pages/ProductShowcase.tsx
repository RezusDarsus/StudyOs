import { AlertTriangle, Bell, Check, CheckCircle2, CircleDollarSign, Compass, Eye, Home, LoaderCircle, MessageCircle, Plus, Sparkles, Target, Users, WifiOff } from 'lucide-react';
import { UpMarker } from '../components/ui';

/** Local-only render fixture for the authenticated product. It never enters production routing. */
export default function ProductShowcase() {
  const view = new URLSearchParams(window.location.search).get('view') ?? 'dashboard';
  return <div className="app-frame showcase-frame">
    <aside className="app-sidebar showcase-sidebar">
      <div className="showcase-side-top"><div className="brand-link"><UpMarker size={36} /><strong>One Up</strong></div>
        <nav aria-label="Preview navigation">
          <span className="sidebar-nav-item active"><Home size={17} />Today</span>
          <span className="sidebar-nav-item"><Target size={17} />My goals</span>
          <span className="sidebar-nav-item"><Compass size={17} />Discover</span>
          <span className="sidebar-nav-item"><Users size={17} />Friends</span>
        </nav>
      </div>
      <div className="showcase-side-bottom"><span className="sidebar-nav-item"><Bell size={17} />Notifications <b>2</b></span><div className="showcase-profile"><span>MA</span><div><strong>Maya</strong><small>Level 6 · 18 day trail</small></div></div></div>
    </aside>
    <main className={`showcase-main showcase-main--${view}`}>
      {view === 'onboarding' ? <ShowcaseOnboarding /> : view === 'states' ? <ShowcaseStates /> : <ShowcaseDashboard />}
    </main>
  </div>;
}

function ShowcaseDashboard() {
  return <div className="product-page dashboard-page">
        <header className="product-page-header"><div><p className="product-eyebrow">Today · your momentum field</p><h1>Maya, this is your next move.</h1><p>One clear action first. The plan adapts after you report how it felt.</p></div><button className="btn-primary product-new-goal"><Plus size={17} />Shape a new goal</button></header>
        <div className="dashboard-layout">
          <section className="dashboard-primary">
            <div className="challenge-window daily-window"><div className="challenge-rail" aria-hidden="true"><span>NOW</span><i /><i /><i /></div><div className="challenge-body">
              <div className="daily-window-head"><div><p className="product-eyebrow">Daily focus</p><h2>2 moves left today</h2></div><div className="daily-progress-number"><strong>1</strong><span>of 3</span></div></div>
              <div className="momentum-track" aria-label="One of three daily moves complete"><span style={{ width: '34%' }} /><i className="is-settled" /><i className="is-settled" /><i /><i /></div>
              <div className="dashboard-task-stack"><div className="goal-task-group"><div className="goal-task-group__head"><span className="showcase-goal-title"><span className="goal-glyph">F</span>Run my first comfortable 5K</span><span className="trail-count"><span className="mini-up-marker"><i /><i /></span>18 day trail</span></div>
                <div className="showcase-task is-complete"><span><Check size={14} /></span><div><strong>Easy recovery walk</strong><small>Completed at 08:14 · felt right</small></div><em>+10</em></div>
                <div className="showcase-task is-current"><span /><div><strong>Run 20 minutes at an easy pace</strong><small>Today at 18:00 · Stage 2 of 4</small></div><em>+20</em></div>
                <div className="showcase-task"><span /><div><strong>Five-minute mobility reset</strong><small>After the run · flexible time</small></div><em>+8</em></div>
              </div></div>
            </div></div>
            <section className="active-goals-section"><div className="section-row-heading"><div><p className="product-eyebrow">Longer horizon</p><h2>Goals in motion</h2></div><span>View all</span></div><div className="goal-rail"><div className="goal-rail-row"><span className="goal-glyph">F</span><span className="goal-rail-copy"><strong>Run my first comfortable 5K</strong><small>2 left today · shared with Jonah</small></span><span className="goal-rail-progress"><i><b style={{ width: '46%' }} /></i><em>46%</em></span></div></div></section>
          </section>
          <aside className="dashboard-context"><div className="context-rail"><p className="product-eyebrow">Field signal</p><div className="context-stat context-stat--progress"><Check /><span><strong>1 / 3 moves</strong><small>Today’s field → complete</small><i><b style={{width:'34%'}} /></i></span></div><div className="context-stat"><CircleDollarSign /><span><strong>10</strong>earned today</span></div><div className="context-stat"><Target /><span><strong>3</strong>active goals</span></div></div>
            <div className="copilot-reason"><div><Sparkles size={16} /><strong>Why this pace?</strong></div><p>Your last two runs felt slightly hard, so today stays at 20 minutes. You remain in control of the change.</p><span>Adjust with Copilot</span></div>
          </aside>
        </div>
        <section className="friend-field showcase-social-rail"><div className="section-row-heading compact"><div><p className="product-eyebrow">Nearby momentum</p><h2>Friends</h2></div><span className="showcase-social-note">Small signals, shared by choice</span></div><div className="showcase-social-signals"><div className="friend-signal"><span className="friend-avatar">JO</span><span><strong>Jonah settled a move</strong><small>Shared 5K goal · 12 min ago</small></span><em>14d</em></div><div className="friend-signal"><span className="friend-avatar friend-avatar--2">LE</span><span><strong>Lea sent encouragement</strong><small>“You have this pace.”</small></span><em>9d</em></div></div><div className="friend-convergence"><i /><i /><UpMarker size={24} /></div></section>
        <section className="showcase-closing-band"><div><p className="product-eyebrow">NEXT MOVE</p><h2>Keep the useful part.</h2><p>One clear action now. The rest of the plan stays ready when you are.</p></div><button className="btn-primary">Open today’s plan <span>→</span></button></section>
      </div>;
}

function ShowcaseOnboarding() {
  return <div className="product-page showcase-flow-page">
    <header className="product-page-header"><div><p className="product-eyebrow">Create a goal · AI coach</p><h1>Start with what keeps getting in the way.</h1><p>One Up turns context into a plan you can inspect, edit, and share when you are ready.</p></div><span className="showcase-step-count">02 / 03</span></header>
    <div className="showcase-flow-grid">
      <section className="showcase-interview-pane"><div className="showcase-pane-head"><MessageCircle size={17} /><strong>Coach interview</strong><span>Listening</span></div><p className="showcase-question">What usually gets in the way?</p><div className="showcase-bubble showcase-bubble--user">I schedule runs that are too ambitious for busy days.</div><div className="showcase-bubble">Make it easy to restart. We can begin with a comfortable 12 minutes.</div><div className="showcase-choice-row"><button className="showcase-choice showcase-choice--selected">Make it easy to restart</button><button className="showcase-choice">Prefer weekday mornings</button></div><button className="btn-primary showcase-wide-action"><Eye size={16} />Review the first plan</button></section>
      <div className="showcase-flow-connector" aria-hidden="true"><i /><i /><i /><i /></div>
      <section className="showcase-draft-pane"><div className="showcase-pane-head"><Sparkles size={17} /><strong>Draft plan</strong><span className="showcase-status-dot">Ready to review</span></div><div className="showcase-reason-card"><p className="product-eyebrow">WHY THIS PLAN</p><h2>Build the rhythm first.</h2><p>Three easy sessions leave room for recovery and make restarting feel possible.</p></div><div className="showcase-draft-row"><span className="mono">01</span><div><strong>Tue · 12-minute easy run</strong><small>Begin below your current limit</small></div><CheckCircle2 size={17} /></div><div className="showcase-draft-row"><span className="mono">02</span><div><strong>Thu · 14-minute run + walk</strong><small>Add one small variable</small></div><span className="showcase-next-label">NEXT</span></div><div className="showcase-draft-row"><span className="mono">03</span><div><strong>Sun · 16-minute easy run</strong><small>Recovery stays in the plan</small></div><span className="showcase-next-label">PLANNED</span></div><div className="showcase-review-note"><Check size={15} /> Nothing saves until you review the reasoning.</div></section>
    <section className="showcase-closing-band"><div><p className="product-eyebrow">READY WHEN YOU ARE</p><h2>Review before anything saves.</h2><p>Your context stays yours, and every adjustment remains editable.</p></div><button className="btn-primary">Review the plan <span>→</span></button></section>
    </div>
  </div>;
}

function ShowcaseStates() {
  return <div className="product-page showcase-flow-page">
    <header className="product-page-header"><div><p className="product-eyebrow">System states · local fixture</p><h1>Every state keeps the next move clear.</h1><p>Quiet feedback preserves your work, names what happened, and offers a useful recovery path.</p></div><span className="showcase-step-count">STATE KIT</span></header>
    <div className="showcase-state-grid">
      <section className="showcase-state-card"><div className="showcase-state-icon showcase-state-icon--companion"><UpMarker size={22} /></div><p className="product-eyebrow">EMPTY</p><h2>Give the trail somewhere to go.</h2><p>Create one goal and One Up will shape a realistic first move.</p><div className="showcase-empty-trail" aria-hidden="true"><i /><i /><i /></div><button className="btn-primary showcase-wide-action">Shape my first goal</button></section>
      <section className="showcase-state-card"><div className="showcase-state-icon"><LoaderCircle size={18} /></div><p className="product-eyebrow">LOADING</p><h2>Finding your next useful move.</h2><div className="showcase-skeleton-lines"><i /><i /><i /></div><span className="showcase-state-meta">Your answers stay on this screen.</span></section>
      <section className="showcase-state-card showcase-state-card--error"><div className="showcase-state-icon"><AlertTriangle size={18} /></div><p className="product-eyebrow">ERROR</p><h2>Your plan could not load.</h2><p>Your draft is safe. Try again or continue with the saved version.</p><button className="showcase-state-link">Try again <span>→</span></button></section>
      <section className="showcase-state-card showcase-state-card--success"><div className="showcase-state-icon"><Check size={18} /></div><p className="product-eyebrow">SUCCESS</p><h2>Easy recovery walk is complete.</h2><p>Your trail advanced one step. The next action is ready when you are.</p><div className="showcase-toast"><Check size={15} /> Saved to today’s plan</div></section>
      <section className="showcase-state-card"><div className="showcase-state-icon"><WifiOff size={18} /></div><p className="product-eyebrow">OFFLINE</p><h2>Last known plan is still here.</h2><p>Your check-in is queued and will sync when you reconnect.</p><span className="showcase-pending-chip">Pending sync · 1 action</span></section>
      <section className="showcase-state-card showcase-focus-card"><p className="product-eyebrow">KEYBOARD FOCUS</p><h2>Focus never disappears.</h2><button className="btn-primary showcase-wide-action showcase-focus-target">Continue with this plan <span>→</span></button><p className="showcase-state-meta">The active target stays visible as you move through the plan.</p></section>
    </div>
  </div>;
}
