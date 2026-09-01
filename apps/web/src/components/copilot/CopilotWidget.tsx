import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  HelpCircle,
  MessageSquare,
  Send,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import QuestionInput from '../QuestionInput';
import Transcript from './Transcript';
import GoalAnswer from './GoalAnswer';
import DraftPreview from './DraftPreview';
import { useAsync, useToast } from '../ui';
import { api } from '../../lib/api';
import { SLASH_COMMANDS, canSubmit, parseInput, type SlashCommand } from '../../lib/slash';
import { isProductHelpRequest } from '../../lib/copilot-intent';
import { useCopilotInterview, interviewPhaseLabel } from '../../lib/useCopilotInterview';
import { GOAL_QUICK_ASKS, useGoalCopilot } from '../../lib/useGoalCopilot';
import type { CopilotStatus } from '../../lib/types';
import type { CopilotTarget } from './CopilotProvider';

type CommandHandler = (command: SlashCommand, args: string) => void;

// ---------------------------------------------------------------- input

/**
 * The widget's message box.
 *
 * Slash handling lives here and nowhere else: an allowlisted first word becomes a
 * command, and everything else — including "5/7 days", "walking/running" and a
 * lone "/" — is ordinary text that reaches the Copilot unchanged.
 */
function WidgetInput({
  placeholder,
  disabled,
  onText,
  onCommand,
  initialValue = '',
}: {
  placeholder: string;
  disabled: boolean;
  onText(text: string): void;
  onCommand: CommandHandler;
  initialValue?: string;
}) {
  const [value, setValue] = useState(initialValue);

  function submit() {
    // Send is enabled for any non-empty message, so this guard should never fire
    // from a click — it exists for the Enter path.
    if (!canSubmit(value) || disabled) return;
    const parsed = parseInput(value);
    setValue('');
    if (parsed.kind === 'command') onCommand(parsed.command, parsed.args);
    else onText(parsed.text);
  }

  return (
    <div className="flex items-end gap-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter makes a new line — the convention people
          // already expect from a chat box.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={placeholder}
        className="flex-1 px-3.5 py-2.5 text-sm resize-none"
        style={{ maxHeight: 96 }}
        aria-label="Message the Copilot"
      />
      <button
        className="btn-primary flex items-center justify-center"
        style={{
          width: 44,
          height: 44,
          padding: 0,
          flexShrink: 0,
          opacity: disabled || !canSubmit(value) ? 0.5 : 1,
        }}
        onClick={submit}
        disabled={disabled || !canSubmit(value)}
        aria-label="Send message"
      >
        <Send size={16} />
      </button>
    </div>
  );
}

// ----------------------------------------------------------------- home

function QuickAction({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: typeof Target;
  label: string;
  hint: string;
  onClick(): void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-left"
      style={{ background: 'var(--surface)', border: '1px solid var(--hairline)', minHeight: 44 }}
    >
      <span
        className="flex items-center justify-center rounded-lg flex-shrink-0"
        style={{ width: 32, height: 32, background: 'var(--surface-3)' }}
        aria-hidden="true"
      >
        <Icon size={16} style={{ color: 'var(--text-muted)' }} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block"
          style={{
            fontFamily: 'var(--font-sans)',
            fontWeight: 500,
            fontSize: '0.85rem',
            color: 'var(--text)',
          }}
        >
          {label}
        </span>
        <span className="block truncate" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {hint}
        </span>
      </span>
      <ChevronRight size={14} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
    </button>
  );
}

function WidgetHome({
  pageGoal,
  onChangeTarget,
  onResume,
}: {
  pageGoal: { id: string; title: string } | null;
  onChangeTarget(target: CopilotTarget): void;
  onResume(sessionId: string): void;
}) {
  const { data } = useAsync(() => api.get<CopilotStatus>('/copilot/status'), []);
  const resumable = data?.resumable ?? [];

  return (
    <div className="flex flex-col gap-2.5">
      <p style={{ fontSize: '0.88rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
        I can help you turn something you want into a plan you'll actually keep. What are we working
        on?
      </p>

      <QuickAction
        icon={Sparkles}
        label="Create a goal with AI"
        hint="A few questions, then a plan you can edit"
        onClick={() => onChangeTarget({ view: 'create' })}
      />

      {pageGoal && (
        <QuickAction
          icon={MessageSquare}
          label={`Ask about ${pageGoal.title}`}
          hint="How it's going, and what to change"
          onClick={() =>
            onChangeTarget({ view: 'goal', goalId: pageGoal.id, goalTitle: pageGoal.title })
          }
        />
      )}

      <QuickAction
        icon={HelpCircle}
        label="What can you do?"
        hint="Capabilities, limits and shortcuts"
        onClick={() => onChangeTarget({ view: 'help' })}
      />

      {resumable.length > 0 && (
        <>
          <div
            style={{
              fontSize: '0.7rem',
              fontWeight: 500,
              color: 'var(--text-body)',
              letterSpacing: '0.05em',
              fontFamily: 'var(--font-sans)',
              marginTop: 6,
            }}
          >
            PICK BACK UP
          </div>
          {resumable.slice(0, 3).map((session) => (
            <button
              key={session.id}
              onClick={() => onResume(session.id)}
              className="w-full text-left px-3.5 py-2.5 rounded-xl"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)', minHeight: 44 }}
            >
              <span
                className="block truncate"
                style={{ fontSize: '0.82rem', fontWeight: 500, color: 'var(--text)' }}
              >
                {session.initialGoalText}
              </span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {session.questionCount} {session.questionCount === 1 ? 'answer' : 'answers'} in
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- clarify

/**
 * The create view's response to "this is not obviously a goal".
 *
 * The server refused to start an interview and asked one question; here are
 * the two answers. "Create a goal" re-posts the user's own words with the
 * intent answer that forces the session; "Ask a question" hands the panel to
 * the help view. Neither silently does both.
 */
function ClarificationCard({
  clarification,
  onConfirm,
  onAskQuestion,
}: {
  clarification: { text: string; prompt: string };
  onConfirm(prompt: string): void;
  onAskQuestion(): void;
}) {
  const chip = {
    background: 'var(--surface-2)',
    border: '1px solid var(--hairline)',
    color: 'var(--text-body)',
    fontSize: '0.75rem',
    fontWeight: 500,
    minHeight: 32,
  } as const;
  return (
    <div className="px-4 py-4 flex flex-col gap-3">
      {clarification.prompt && (
        <div className="self-end" style={{ maxWidth: '86%' }}>
          <div
            className="px-3.5 py-2.5 rounded-2xl"
            style={{
              background: 'var(--surface-3)',
              color: 'var(--text)',
              fontSize: '0.88rem',
              lineHeight: 1.55,
              borderBottomRightRadius: 6,
            }}
          >
            {clarification.prompt}
          </div>
        </div>
      )}
      <p style={{ fontSize: '0.88rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
        {clarification.text}
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="px-3 py-1.5 rounded-full" style={chip} onClick={() => onConfirm(clarification.prompt)}>
          Create a goal
        </button>
        <button className="px-3 py-1.5 rounded-full" style={chip} onClick={onAskQuestion}>
          Ask a question
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- help

function HelpView() {
  return (
    <div className="flex flex-col gap-3.5" style={{ fontSize: '0.85rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
      <div>
        <strong style={{ color: 'var(--text)' }}>What I can do</strong>
        <ul className="mt-1.5 flex flex-col gap-1" style={{ paddingLeft: 18, listStyle: 'disc' }}>
          <li>Ask a few questions and draft a goal with tasks and a schedule</li>
          <li>Explain how a goal is going, using your real completion numbers</li>
          <li>Suggest changes when something is too hard or too easy</li>
        </ul>
      </div>
      <div>
        <strong style={{ color: 'var(--text)' }}>What I won't do</strong>
        <ul className="mt-1.5 flex flex-col gap-1" style={{ paddingLeft: 18, listStyle: 'disc' }}>
          <li>Change a goal, a reminder or your coins without you confirming it</li>
          <li>Rewrite days that have already happened</li>
          <li>Touch anyone else's goals or see data that isn't yours</li>
        </ul>
      </div>
      <div>
        <strong style={{ color: 'var(--text)' }}>Account & support</strong>
        <ul className="mt-1.5 flex flex-col gap-1" style={{ paddingLeft: 18, listStyle: 'disc' }}>
          <li>Log out from the exit icon in the header (mobile) or the sidebar (desktop)</li>
          <li>Profile contains your personal settings and Copilot memory controls</li>
          <li>For data export, account deletion, or support, email support@goalify.app</li>
        </ul>
      </div>
      <div>
        <strong style={{ color: 'var(--text)' }}>Shortcuts</strong>
        <ul className="mt-1.5 flex flex-col gap-1" style={{ paddingLeft: 18, listStyle: 'disc' }}>
          {SLASH_COMMANDS.map((command) => (
            <li key={command}>
              <code style={{ fontFamily: 'monospace', color: 'var(--text)' }}>/{command}</code>
              {command === 'help' && ' — this screen'}
              {command === 'new' && ' — start a fresh goal'}
              {command === 'clear' && ' — clear this conversation'}
            </li>
          ))}
        </ul>
        <p className="mt-2" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          Anything else you type is just a message — slashes in words like "5/7 days" are safe.
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- goal chat

function GoalChat({
  goalId,
  goalTitle,
  onCommand,
}: {
  goalId: string;
  goalTitle: string;
  onCommand: CommandHandler;
}) {
  const { push } = useToast();
  const copilot = useGoalCopilot(goalId, (message) => push(message, 'error'));
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [copilot.entries.length, copilot.busy]);

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {copilot.entries.length === 0 && !copilot.busy && (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
            Ask me anything about <strong style={{ color: 'var(--text)' }}>{goalTitle}</strong>. I'll look
            at your actual completions before answering.
          </p>
        )}

        <div className="flex flex-col gap-4">
          {copilot.entries.map((entry, index) => (
            <div key={index} className="flex flex-col gap-3">
              <div className="self-end" style={{ maxWidth: '86%' }}>
                <div
                  className="px-3.5 py-2.5 rounded-2xl"
                  style={{
                    background: 'var(--surface-3)',
                    color: 'var(--text)',
                    fontSize: '0.88rem',
                    lineHeight: 1.55,
                    borderBottomRightRadius: 6,
                  }}
                >
                  {entry.question}
                </div>
              </div>
              <GoalAnswer
                result={entry.answer}
                compact
                onMarkUsed={(item) => void copilot.markConsumed(item)}
                consumedIdentities={copilot.consumedIdentities}
              />
            </div>
          ))}
        </div>

        {copilot.busy && (
          <p className="mt-4" style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Looking at your progress…
          </p>
        )}

        {!copilot.busy && (
          <div className="flex flex-wrap gap-2 mt-4">
            {GOAL_QUICK_ASKS.map((q) => (
              <button
                key={q}
                onClick={() => copilot.ask(q)}
                className="px-3 py-1.5 rounded-full"
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--hairline)',
                  color: 'var(--text-body)',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  minHeight: 32,
                }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--hairline)', background: 'var(--surface)' }}>
        <WidgetInput
          placeholder="Ask about this goal…"
          disabled={copilot.busy}
          onText={(text) => copilot.ask(text)}
          onCommand={onCommand}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- widget

export default function CopilotWidget({
  isOpen,
  target,
  pageGoal,
  onChangeTarget,
  onOpen,
  onClose,
}: {
  isOpen: boolean;
  target: CopilotTarget;
  pageGoal: { id: string; title: string } | null;
  onChangeTarget(target: CopilotTarget): void;
  onOpen(): void;
  onClose(): void;
}) {
  const navigate = useNavigate();
  const { push } = useToast();
  const panelRef = useRef<HTMLDivElement>(null);

  const interview = useCopilotInterview({
    resumeSessionId: target.view === 'create' ? target.sessionId : undefined,
    onError: (message) => push(message, 'error'),
    onResumedDraft: (draftId) => {
      onClose();
      navigate(`/app/goals/drafts/${draftId}`);
    },
    onResumeFailed: () => onChangeTarget({ view: 'create' }),
  });

  // Escape closes, matching every other overlay in the app.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen]);

  const handleCommand: CommandHandler = (command, args) => {
    if (command === 'help') return onChangeTarget({ view: 'help' });
    if (command === 'clear') {
      interview.reset();
      return onChangeTarget({ view: 'home' });
    }
    // /new
    interview.reset();
    onChangeTarget({ view: 'create', seed: args.trim().length >= 3 ? undefined : args });
    if (args.trim().length >= 3) void interview.begin(args);
  };

  function startInterview(text: string) {
    if (isProductHelpRequest(text)) {
      onChangeTarget({ view: 'help' });
      return;
    }
    onChangeTarget({ view: 'create' });
    void interview.begin(text);
  }

  async function build() {
    // The hook stores the draft and moves to DONE; the user sees a compact
    // preview here and opens the full plan only if they want to.
    await interview.generate();
  }

  function openFullPlan() {
    if (!interview.draft) return;
    onClose();
    navigate(`/app/goals/drafts/${interview.draft.id}`);
  }

  // ----------------------------------------------------------- collapsed

  if (!isOpen) {
    return (
      <button
        onClick={onOpen}
        aria-label="Open One Up Copilot"
        aria-expanded={false}
        className="copilot-fab fixed rounded-full flex items-center justify-center z-[90] animate-resolve-in"
        style={{
          width: 56,
          height: 56,
          background: 'var(--accent)',
          // A ring, not a drop shadow: this system has none. The Teal Deep
          // outline is what lifts the button off whatever it floats over.
          border: '1px solid var(--accent-line)',
        }}
      >
        <Sparkles size={24} color="var(--accent-ink)" />
      </button>
    );
  }

  // ---------------------------------------------------------------- open

  const heading =
    target.view === 'goal'
      ? target.goalTitle
      : target.view === 'help'
        ? 'About the Copilot'
        : target.view === 'create'
          ? 'New goal'
          : 'Copilot';

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label="One Up Copilot"
      className="copilot-panel fixed z-[90] flex flex-col animate-slide-up"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--hairline-strong)',
        outline: 'none',
      }}
    >
      {/* header */}
      <div
        className="flex items-center gap-2.5 px-4 py-3 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--hairline)' }}
      >
        {target.view !== 'home' && (
          <button
            onClick={() => onChangeTarget({ view: 'home' })}
            aria-label="Back to Copilot home"
            className="flex items-center justify-center rounded-lg flex-shrink-0"
            style={{ width: 32, height: 32, color: 'var(--text-body)' }}
          >
            <ArrowLeft size={17} />
          </button>
        )}
        <span
          className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{ width: 32, height: 32, background: 'var(--accent)' }}
          aria-hidden="true"
        >
          <Sparkles size={16} color="var(--accent-ink)" />
        </span>
        <span
          className="flex-1 min-w-0 truncate"
          style={{
            fontFamily: 'var(--font-sans)',
            fontWeight: 600,
            fontSize: '0.95rem',
            color: 'var(--text)',
          }}
        >
          {heading}
        </span>
        <button
          onClick={onClose}
          aria-label="Close Copilot"
          className="flex items-center justify-center rounded-lg flex-shrink-0"
          style={{ width: 32, height: 32, color: 'var(--text-body)' }}
        >
          <X size={18} />
        </button>
      </div>

      {/* body */}
      {target.view === 'goal' ? (
        <GoalChat
          key={target.goalId}
          goalId={target.goalId}
          goalTitle={target.goalTitle}
          onCommand={handleCommand}
        />
      ) : target.view === 'help' ? (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <HelpView />
        </div>
      ) : target.view === 'home' ? (
        <>
          <div className="flex-1 overflow-y-auto px-4 py-4" style={{ background: 'var(--surface-2)' }}>
            <WidgetHome
              pageGoal={pageGoal}
              onChangeTarget={onChangeTarget}
              onResume={(sessionId) => onChangeTarget({ view: 'create', sessionId })}
            />
          </div>
          <div className="px-4 py-3" style={{ borderTop: '1px solid var(--hairline)' }}>
            <WidgetInput
              placeholder="Tell me a goal, or type /help"
              disabled={interview.busy}
              onText={startInterview}
              onCommand={handleCommand}
            />
          </div>
        </>
      ) : (
        // ---- create ----
        <>
          <div
            className="flex-1 overflow-y-auto flex flex-col"
            style={{ background: 'var(--surface-2)', minHeight: 0 }}
          >
            {interview.clarification ? (
              <ClarificationCard
                clarification={interview.clarification}
                onConfirm={(prompt) => void interview.begin(prompt, { intentAnswer: 'goal' })}
                onAskQuestion={() => {
                  interview.reset();
                  onChangeTarget({ view: 'help' });
                }}
              />
            ) : interview.phase === 'DONE' && interview.draft ? (
              <div className="px-4 py-4">
                <DraftPreview draft={interview.draft} onOpenFull={openFullPlan} />
              </div>
            ) : interview.phase === 'RESUMING' ? (
              <p className="px-4 py-4" style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Reopening your conversation…
              </p>
            ) : interview.phase === 'OPENING' ? (
              <div className="px-4 py-4">
                <p style={{ fontSize: '0.88rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
                  What would you like to achieve? Say it however you like — the more detail you give,
                  the fewer questions I need to ask.
                </p>
                <div className="flex flex-wrap gap-2 mt-3">
                  {['Read more books', 'Get fitter', 'Save money for a trip'].map((example) => (
                    <button
                      key={example}
                      onClick={() => startInterview(`I want to ${example.toLowerCase()}`)}
                      className="px-3 py-1.5 rounded-full"
                      style={{
                        background: 'var(--surface-2)',
                        border: '1px solid var(--hairline)',
                        color: 'var(--text-body)',
                        fontSize: '0.75rem',
                        fontWeight: 500,
                        minHeight: 32,
                      }}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {/* progress */}
                <div className="flex items-center gap-2.5 px-4 pt-3.5 flex-shrink-0">
                  <div className="progress-bar-track flex-1" style={{ height: 4 }}>
                    <div className="progress-bar-fill" style={{ width: `${interview.progress}%` }} />
                  </div>
                  <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                    {interviewPhaseLabel(interview.phase, interview.turn)}
                  </span>
                </div>
                <Transcript
                  bubbles={interview.bubbles}
                  busy={interview.busy}
                  className="flex-1 overflow-y-auto px-4 py-3.5"
                />
              </>
            )}
          </div>

          {/* answer area */}
          <div className="flex-shrink-0" style={{ borderTop: '1px solid var(--hairline)', background: 'var(--surface)' }}>
            {interview.question ? (
              <QuestionInput
                question={interview.question}
                disabled={interview.busy}
                onAnswer={interview.answer}
                compact
              />
            ) : interview.phase === 'READY' ? (
              <div className="px-4 py-3">
                <button
                  className="btn-primary w-full py-3 text-sm flex items-center justify-center gap-2"
                  onClick={build}
                  disabled={interview.generating}
                >
                  <Sparkles size={15} />
                  {interview.generating ? 'Building your plan…' : 'Build my plan'}
                </button>
              </div>
            ) : interview.phase === 'DONE' || interview.phase === 'RESUMING' ? null : (
              <div className="px-4 py-3">
                <WidgetInput
                  // Remounts when /new carried text too short to start on, so the
                  // user's words are handed back rather than silently dropped.
                  key={target.view === 'create' ? (target.seed ?? '') : ''}
                  placeholder="Tell me a goal, or type /help"
                  disabled={interview.busy}
                  onText={startInterview}
                  onCommand={handleCommand}
                  initialValue={target.view === 'create' ? (target.seed ?? '') : ''}
                />
              </div>
            )}
            {interview.phase === 'INTERVIEWING' &&
              !interview.turn?.canGenerate &&
              (interview.turn?.questionCount ?? 0) >= 2 && (
                <div className="px-4 pb-3">
                  <button
                    className="btn-ghost w-full py-2 text-xs"
                    onClick={() => interview.forceGenerate()}
                    disabled={interview.generating}
                  >
                    Build with what we have
                  </button>
                </div>
              )}
          </div>
        </>
      )}
    </div>
  );
}
