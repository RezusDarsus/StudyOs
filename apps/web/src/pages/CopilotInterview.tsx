import { useState } from 'react';
import { ArrowLeft, ArrowRight, Sparkles, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Modal, useToast } from '../components/ui';
import QuestionInput from '../components/QuestionInput';
import Transcript from '../components/copilot/Transcript';
import { useCopilotInterview } from '../lib/useCopilotInterview';

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

  async function build() {
    const draft = await interview.generate();
    if (draft) navigate(`/app/goals/drafts/${draft.id}`, { replace: true });
  }

  async function leave(discard: boolean) {
    if (discard) await interview.discard();
    navigate('/app/goals', { replace: true });
  }

  // ------------------------------------------------------- opening screen

  if (phase === 'OPENING') {
    return (
      <div className="p-5 sm:p-6 lg:p-8 max-w-xl mx-auto">
        <button
          onClick={() => navigate('/app/goals/new')}
          className="flex items-center gap-2 mb-6"
          style={{ color: '#8b88b0', fontSize: '0.875rem', fontWeight: 500 }}
        >
          <ArrowLeft size={15} /> Back
        </button>

        <div className="card shadow-card p-6 sm:p-7">
          <div className="flex items-center gap-2.5 mb-5">
            <span
              className="flex items-center justify-center rounded-xl"
              style={{
                width: 38,
                height: 38,
                background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
                boxShadow: '0 4px 12px rgba(124,58,237,0.35)',
              }}
            >
              <Sparkles size={19} color="white" />
            </span>
            <span
              style={{
                fontFamily: 'Plus Jakarta Sans',
                fontWeight: 800,
                fontSize: '1.05rem',
                color: '#1a1635',
              }}
            >
              Goal Copilot
            </span>
          </div>

          <h1
            style={{
              fontFamily: 'Plus Jakarta Sans',
              fontWeight: 800,
              fontSize: '1.5rem',
              color: '#1a1635',
              letterSpacing: '-0.02em',
            }}
          >
            What would you like to achieve?
          </h1>
          <p style={{ color: '#8b88b0', fontSize: '0.88rem', marginTop: 6, marginBottom: 18 }}>
            Say it however you like. The more detail you give, the fewer questions I need to ask.
          </p>

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
                  background: '#f5f4ff',
                  border: '1px solid #e8e6f5',
                  color: '#6b688f',
                  fontSize: '0.75rem',
                  fontWeight: 600,
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
    );
  }

  // ---------------------------------------------------------- interview

  return (
    <div className="p-5 sm:p-6 lg:p-8 max-w-2xl mx-auto flex flex-col" style={{ minHeight: '100%' }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <span
            className="flex items-center justify-center rounded-xl"
            style={{ width: 34, height: 34, background: 'linear-gradient(135deg, #7c3aed, #6d28d9)' }}
          >
            <Sparkles size={17} color="white" />
          </span>
          <span
            style={{
              fontFamily: 'Plus Jakarta Sans',
              fontWeight: 800,
              fontSize: '1rem',
              color: '#1a1635',
            }}
          >
            Goal Copilot
          </span>
        </div>
        <button
          onClick={() => setCancelOpen(true)}
          aria-label="Close Copilot"
          className="flex items-center justify-center rounded-lg"
          style={{ width: 34, height: 34, color: '#8b88b0', border: '1px solid #e8e6f5' }}
        >
          <X size={16} />
        </button>
      </div>

      {/* progress */}
      <div className="flex items-center gap-3 mb-4">
        <div className="progress-bar-track flex-1" style={{ height: 5 }}>
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <span style={{ fontSize: '0.72rem', color: '#8b88b0', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {phase === 'READY'
            ? 'Ready'
            : `${turn?.questionCount ?? 0} of ~${turn?.estimatedTotal ?? 3}`}
        </span>
      </div>

      <Transcript bubbles={bubbles} busy={busy} maxHeight="52vh" />

      {/* answer area */}
      <div className="mt-4">
        {question ? (
          <QuestionInput question={question} disabled={busy} onAnswer={interview.answer} />
        ) : phase === 'READY' ? (
          <div className="card shadow-card p-5 text-center">
            <p style={{ fontSize: '0.9rem', color: '#4b4870', marginBottom: 14 }}>
              That's everything I need. Ready to see your plan?
            </p>
            <button
              className="btn-primary w-full py-3.5 text-sm flex items-center justify-center gap-2"
              onClick={build}
              disabled={generating}
            >
              <Sparkles size={15} />
              {generating ? 'Building your plan…' : 'Build my plan'}
            </button>
          </div>
        ) : null}
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
              style={{ background: '#c8253c', boxShadow: 'none' }}
              onClick={() => leave(true)}
            >
              Discard
            </button>
          </>
        }
      >
        <p style={{ fontSize: '0.9rem', color: '#4b4870', lineHeight: 1.6 }}>
          Your answers are saved. You can pick this back up from the create-goal screen, or
          discard it entirely.
        </p>
      </Modal>
    </div>
  );
}
