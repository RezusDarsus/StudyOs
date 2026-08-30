import { Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
import type { GoalCopilotAnswer } from '../../lib/types';

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
}: {
  result: GoalCopilotAnswer;
  compact?: boolean;
}) {
  return (
    <div>
      <div
        className="px-4 py-3.5 rounded-xl"
        style={{ background: '#f0ebff', border: '1px solid #ddd0ff' }}
      >
        <div className="flex items-center gap-2 mb-2">
          <Sparkles size={14} style={{ color: '#7c3aed' }} />
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 700,
              color: '#7c3aed',
              fontFamily: 'Plus Jakarta Sans',
              letterSpacing: '0.05em',
            }}
          >
            COPILOT
          </span>
        </div>
        <p style={{ fontSize: '0.88rem', color: '#1a1635', lineHeight: 1.6 }}>
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
            style={{ background: '#f5f4ff', border: '1px solid #e8e6f5' }}
          >
            <div
              style={{
                fontFamily: 'Plus Jakarta Sans',
                fontWeight: 800,
                fontSize: compact ? '0.88rem' : '0.95rem',
                color: '#1a1635',
              }}
            >
              {stat.value}
            </div>
            <div style={{ fontSize: '0.65rem', color: '#8b88b0', marginTop: 2 }}>{stat.label}</div>
          </div>
        ))}
      </div>}

      {result.analysis.suggestions.length > 0 && (
        <div className="mt-4">
          <div
            style={{
              fontSize: '0.72rem',
              fontWeight: 700,
              color: '#6b688f',
              letterSpacing: '0.05em',
              fontFamily: 'Plus Jakarta Sans',
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
                style={{ background: '#fff', border: '1px solid #e8e6f5' }}
              >
                <p style={{ fontSize: '0.85rem', color: '#1a1635', lineHeight: 1.5 }}>{s.summary}</p>
                {s.taskTitle && (
                  <p style={{ fontSize: '0.72rem', color: '#b8b5d5', marginTop: 3 }}>
                    {s.taskTitle}
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3" style={{ fontSize: '0.75rem', color: '#b8b5d5', lineHeight: 1.5 }}>
            These are suggestions only — nothing has changed. Edit the goal yourself if you want to
            apply one. Your past history is never rewritten.
          </p>
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
              fontWeight: 700,
              color: '#6b688f',
              letterSpacing: '0.05em',
              fontFamily: 'Plus Jakarta Sans',
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
                  style={{ background: '#fff', border: '1px solid #e8e6f5' }}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon size={13} style={{ color: '#7c3aed' }} aria-hidden="true" />
                    <span
                      style={{
                        fontSize: '0.85rem',
                        fontWeight: 700,
                        color: '#1a1635',
                        fontFamily: 'Plus Jakarta Sans',
                      }}
                    >
                      {proposal.taskTitle}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: '#8b88b0' }}>
                      · {proposal.stageLabel}
                    </span>
                  </div>
                  <p style={{ fontSize: '0.85rem', color: '#1a1635', marginTop: 5, lineHeight: 1.5 }}>
                    The Copilot suggests {up ? 'stepping up' : 'dropping back'} a step.{' '}
                    {backed
                      ? 'Your numbers agree.'
                      : `Your numbers point to ${
                          proposal.reviewAction === 'STAY' ? 'staying put' : 'something else'
                        }.`}
                  </p>
                  <p style={{ fontSize: '0.75rem', color: '#8b88b0', marginTop: 4, lineHeight: 1.5 }}>
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
