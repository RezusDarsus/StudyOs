import { Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
import type { GoalCopilotAnswer, StructuredRecommendation } from '../../lib/types';
import { recommendationIdentity } from '../../lib/useGoalCopilot';

/**
 * The Copilot's read on a live goal.
 *
 * The prose comes from the model; every number comes from the app's own scoring.
 * The disclaimer is not decoration — the suggestions really have not been applied,
 * and the user needs to know that before they close the panel and forget.
 */
export default function GoalAnswer({
  result,
  compact = false,
  onMarkUsed,
  consumedIdentities,
}: {
  result: GoalCopilotAnswer;
  compact?: boolean;
  /** Stage 2: when provided, recommendation cards carry the durable "used" action. */
  onMarkUsed?: (item: StructuredRecommendation) => void;
  consumedIdentities?: ReadonlySet<string>;
}) {
  return (
    <div>
      <div
        className="px-4 py-3.5 rounded-xl"
        style={{ background: 'var(--surface-3)', border: '1px solid var(--hairline-strong)' }}
      >
        <div className="flex items-center gap-2 mb-2">
          <Sparkles size={14} style={{ color: 'var(--text-muted)' }} />
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 500,
              color: 'var(--text)',
              fontFamily: 'var(--font-sans)',
              letterSpacing: '0.05em',
            }}
          >
            COPILOT
          </span>
        </div>
        <p style={{ fontSize: '0.88rem', color: 'var(--text)', lineHeight: 1.6 }}>
          {result.analysis.explanation}
        </p>
      </div>

      {/* Advice and adjustment answers should not be buried under the same progress
       * cards every turn. Older API responses have no intent, so retain their
       * original display during a rolling deployment. */}
      {(!result.intent || result.intent === 'PROGRESS') && <div className="grid grid-cols-3 gap-2 mt-4">
        {[
          {
            label: `Last ${result.summary.periodDays} days`,
            value: `${Math.round(result.summary.completionRate * 100)}%`,
          },
          { label: 'Streak', value: `🔥 ${result.summary.currentStreak}` },
          {
            label: 'Done',
            value: `${result.summary.completedTaskOccurrences}/${result.summary.eligibleTaskOccurrences}`,
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl px-2 py-2.5 text-center"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
          >
            <div
              style={{
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
                fontSize: compact ? '0.88rem' : '0.95rem',
                color: 'var(--text)',
              }}
            >
              {stat.value}
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2 }}>{stat.label}</div>
          </div>
        ))}
      </div>}

      {result.analysis.suggestions.length > 0 && (
        <div className="mt-4">
          <div
            style={{
              fontSize: '0.72rem',
              fontWeight: 500,
              color: 'var(--text-body)',
              letterSpacing: '0.05em',
              fontFamily: 'var(--font-sans)',
              marginBottom: 8,
            }}
          >
            SUGGESTIONS
          </div>
          <div className="flex flex-col gap-2">
            {result.analysis.suggestions.map((s, i) => (
              <div
                key={i}
                className="px-3.5 py-3 rounded-xl"
                style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
              >
                <p style={{ fontSize: '0.85rem', color: 'var(--text)', lineHeight: 1.5 }}>{s.summary}</p>
                {s.taskTitle && (
                  <p style={{ fontSize: '0.72rem', color: 'var(--text-faint)', marginTop: 3 }}>
                    {s.taskTitle}
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3" style={{ fontSize: '0.75rem', color: 'var(--text-faint)', lineHeight: 1.5 }}>
            These are suggestions only — nothing has changed. Edit the goal yourself if you want to
            apply one. Your past history is never rewritten.
          </p>
        </div>
      )}

      {result.analysis.recommendations && result.analysis.recommendations.length > 0 && (
        <div className="mt-4">
          <div
            style={{
              fontSize: '0.72rem',
              fontWeight: 500,
              color: 'var(--text-body)',
              letterSpacing: '0.05em',
              fontFamily: 'var(--font-sans)',
              marginBottom: 8,
            }}
          >
            RECOMMENDATIONS
          </div>
          <div className="flex flex-col gap-2">
            {/*
             * Structured, domain-open entities. The tag renders the model's own
             * entityType verbatim — the frontend has no list of kinds and must
             * never switch on one. Presentation only: nothing here is saved,
             * linked or actionable; persistence is a later stage.
             */}
            {result.analysis.recommendations.map((item, i) => (
              <div
                key={`${item.displayName}|${item.attribution ?? ''}|${i}`}
                className="px-3.5 py-3 rounded-xl"
                style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
              >
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className="rounded-md px-1.5 py-0.5"
                    style={{
                      fontSize: '0.65rem',
                      color: 'var(--text-muted)',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--hairline)',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    {item.entityType}
                  </span>
                  <span
                    style={{
                      fontSize: '0.85rem',
                      fontWeight: 500,
                      color: 'var(--text)',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    {item.displayName}
                  </span>
                  {item.attribution && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      · {item.attribution}
                    </span>
                  )}
                </div>
                {item.reason && (
                  <p style={{ fontSize: '0.85rem', color: 'var(--text)', marginTop: 5, lineHeight: 1.5 }}>
                    {item.reason}
                  </p>
                )}
                {onMarkUsed && (() => {
                  const used = consumedIdentities?.has(recommendationIdentity(item)) ?? false;
                  return (
                    <div className="mt-2">
                      <button
                        type="button"
                        disabled={used}
                        onClick={() => onMarkUsed(item)}
                        className="rounded-lg px-2.5 py-1"
                        style={{
                          fontSize: '0.72rem',
                          color: used ? 'var(--text-muted)' : 'var(--text)',
                          background: 'var(--surface-2)',
                          border: '1px solid var(--hairline)',
                          cursor: used ? 'default' : 'pointer',
                        }}
                      >
                        {used ? 'Marked as used' : 'Mark as used'}
                      </button>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)', marginLeft: 6 }}>
                        Saved to your history.
                      </span>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      )}

      {/*
       * Stage changes are kept apart from the ordinary suggestions because they are
       * the one thing the Copilot can ask for that the app has already answered. The
       * refusal is shown as the app's own words, not the model's, and the user is sent
       * to the place where the decision is actually theirs to make.
       */}
      {result.progressionProposals?.length > 0 && (
        <div className="mt-4">
          <div
            style={{
              fontSize: '0.72rem',
              fontWeight: 500,
              color: 'var(--text-body)',
              letterSpacing: '0.05em',
              fontFamily: 'var(--font-sans)',
              marginBottom: 8,
            }}
          >
            BUILD-UP
          </div>
          <div className="flex flex-col gap-2">
            {result.progressionProposals.map((proposal) => {
              const up = proposal.requested === 'ADVANCE';
              const Icon = up ? TrendingUp : TrendingDown;
              const backed = proposal.reviewAction === proposal.requested;
              return (
                <div
                  key={proposal.planId}
                  className="px-3.5 py-3 rounded-xl"
                  style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon size={13} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
                    <span
                      style={{
                        fontSize: '0.85rem',
                        fontWeight: 500,
                        color: 'var(--text)',
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      {proposal.taskTitle}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      · {proposal.stageLabel}
                    </span>
                  </div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text)', marginTop: 5, lineHeight: 1.5 }}>
                    The Copilot suggests {up ? 'stepping up' : 'dropping back'} a step.{' '}
                    {backed
                      ? 'Your numbers agree.'
                      : `Your numbers point to ${
                          proposal.reviewAction === 'STAY' ? 'staying put' : 'something else'
                        }.`}
                  </p>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                    Nothing has moved. Open the goal’s build-up section to decide.
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
