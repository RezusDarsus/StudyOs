import { useState } from 'react';
import { ArrowLeft, ArrowRight, Sparkles, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Modal, UpMarker, useToast } from '../components/ui';
import QuestionInput from '../components/QuestionInput';
import Transcript from '../components/copilot/Transcript';
import { useCopilotInterview, interviewPhaseLabel } from '../lib/useCopilotInterview';

/**
 * The conversational goal builder.
 *
 * Deliberately not a chat clone: it is a guided interview inside the product's
 * own visual language, with quick-select answers, a visible sense of progress,
 * and an always-available way out. The conversation itself lives in
 * useCopilotInterview, which the floating widget shares.
 */
export default function CopilotInterview() {
  const { sessionId: resumeId } = useParams();
  const navigate = useNavigate();
  const { push } = useToast();

  const [goalText, setGoalText] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);

  const interview = useCopilotInterview({
    resumeSessionId: resumeId,
    onError: (message) => push(message, 'error'),
    onResumedDraft: (draftId) => navigate(`/app/goals/drafts/${draftId}`, { replace: true }),
    onResumeFailed: () => navigate('/app/goals/new', { replace: true }),
  });

  const { phase, bubbles, turn, question, busy, generating, progress } = interview;

  async function build(force = false) {
    const draft = await interview.generate({ force });
    if (draft) navigate(`/app/goals/drafts/${draft.id}`, { replace: true });
  }

  async function leave(discard: boolean) {
    if (discard && !(await interview.discard())) return;
    navigate('/app/goals', { replace: true });
  }

  // ------------------------------------------------------- opening screen

  if (phase === 'OPENING') {
    return (
      <div className="product-page copilot-interview-page">
        <button
          onClick={() => navigate('/app/goals/new')}
          className="flex items-center gap-2 mb-6"
          style={{ color: 'var(--text-muted)', fontSize: '0.875rem', fontWeight: 400 }}
        >
          <ArrowLeft size={15} /> Back
        </button>

        <div className="challenge-window copilot-opening">
          <div className="challenge-rail" aria-hidden="true"><span>LISTEN</span><i /><i /><i /></div>
          <div className="challenge-body">
          <div className="flex items-center gap-2.5 mb-5">
            <UpMarker size={38} />
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
                fontSize: '1.05rem',
                color: 'var(--text)',
              }}
            >
              Goal Copilot
            </span>
          </div>

          <h1
            style={{
              fontFamily: 'var(--font-sans)',
              fontWeight: 600,
              fontSize: '1.5rem',
              color: 'var(--text)',
              letterSpacing: '-0.02em',
            }}
          >
            What would you like to achieve?
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', marginTop: 6, marginBottom: 18 }}>
            Say it however you like. The more detail you give, the fewer questions I need to ask.
          </p>
          {interview.clarification && <div className="mb-5" role="status">
            <p className="mb-3">{interview.clarification.text}</p>
            <button className="btn-secondary px-4 py-2" disabled={busy}
              onClick={() => interview.begin(interview.clarification!.prompt, { intentAnswer: 'goal' })}>
              Create a goal from this
            </button>
          </div>}

          <textarea
            value={goalText}
            onChange={(e) => setGoalText(e.target.value)}
            maxLength={2000}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) interview.begin(goalText);
            }}
            rows={3}
            autoFocus
            placeholder="I want to become more active and lose some weight."
            className="w-full px-4 py-3.5 text-sm resize-none"
            aria-label="Your goal"
          />

          <div className="flex flex-wrap gap-2 mt-3">
            {[
              'I want to read more books',
              'I want to get fitter',
              'I want to save money for a trip',
            ].map((example) => (
              <button
                key={example}
                onClick={() => setGoalText(example)}
                className="px-3 py-1.5 rounded-full"
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--hairline)',
                  color: 'var(--text-body)',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                }}
              >
                {example}
              </button>
            ))}
          </div>

          <button
            className="btn-primary w-full mt-5 py-3.5 text-sm flex items-center justify-center gap-2"
            onClick={() => interview.begin(goalText)}
            disabled={busy || goalText.trim().length < 3}
            style={{ opacity: busy || goalText.trim().length < 3 ? 0.55 : 1 }}
          >
            {busy ? 'Thinking…' : 'Continue'} {!busy && <ArrowRight size={15} />}
          </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------- interview

  return (
    <div className="product-page copilot-interview-page copilot-interview-page--active flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <UpMarker size={34} />
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontWeight: 600,
              fontSize: '1rem',
              color: 'var(--text)',
            }}
          >
            Goal Copilot
          </span>
        </div>
        <button
          onClick={() => setCancelOpen(true)}
          aria-label="Close Copilot"
          className="flex items-center justify-center rounded-lg"
          style={{ width: 34, height: 34, color: 'var(--text-muted)', border: '1px solid var(--hairline)' }}
        >
          <X size={16} />
        </button>
      </div>

      {/* progress */}
      <div className="flex items-center gap-3 mb-4">
        <div className="progress-bar-track flex-1" style={{ height: 5 }}>
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>
          {interviewPhaseLabel(phase, turn)}
        </span>
      </div>

      {phase === 'RESUMING' && <p role="status">Reopening your conversation…</p>}
      <Transcript bubbles={bubbles} busy={busy || generating} thinkingLabel={generating ? 'Building your plan…' : undefined} className="copilot-full-transcript flex-1 overflow-y-auto" />

      {/* answer area */}
      <div className="copilot-full-composer mt-4">
        {question ? (
          <QuestionInput question={question} disabled={busy || generating} onAnswer={interview.answer} />
        ) : phase === 'READY' ? (
          <div className="card shadow-card p-5 text-center">
            <p style={{ fontSize: '0.9rem', color: 'var(--text-body)', marginBottom: 14 }}>
              That's everything I need. Ready to see your plan?
            </p>
            <button
              className="btn-primary w-full py-3.5 text-sm flex items-center justify-center gap-2"
              onClick={() => build()}
              disabled={generating}
            >
              <Sparkles size={15} />
              {generating ? 'Building your plan…' : 'Build my plan'}
            </button>
          </div>
        ) : null}
        {phase === 'INTERVIEWING' && !turn?.canGenerate && (turn?.questionCount ?? 0) >= 2 && (
          <button
            className="btn-ghost w-full py-2.5 text-xs mt-2"
            onClick={() => build(true)}
            disabled={busy || generating}
          >
            Build with what we have
          </button>
        )}
      </div>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Leave the Copilot?"
        footer={
          <>
            <button className="btn-ghost px-4 py-2.5 text-sm" onClick={() => leave(false)}>
              Save for later
            </button>
            <button
              className="btn-primary px-4 py-2.5 text-sm"
              style={{ background: 'var(--red)', boxShadow: 'none' }}
              disabled={busy || generating}
              onClick={() => leave(true)}
            >
              Discard
            </button>
          </>
        }
      >
        <p style={{ fontSize: '0.9rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
          Your answers are saved. You can pick this back up from the create-goal screen, or
          discard it entirely.
        </p>
      </Modal>
    </div>
  );
}
