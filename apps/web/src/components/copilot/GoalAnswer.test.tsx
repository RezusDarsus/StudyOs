import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import GoalAnswer from './GoalAnswer';
import type { GoalCopilotAnswer } from '../../lib/types';
import { recommendationIdentity } from '../../lib/useGoalCopilot';

// The recommendation cards are presentation-only: they render the structured,
// domain-open entities verbatim — including entity types the frontend has never
// heard of — and render nothing at all when the field is absent.

const baseAnswer = (analysis: Partial<GoalCopilotAnswer['analysis']> = {}): GoalCopilotAnswer => ({
  intent: 'ADVICE',
  summary: {
    goalTitle: 'Read more',
    periodDays: 14,
    eligibleTaskOccurrences: 6,
    completedTaskOccurrences: 4,
    completionRate: 0.67,
    currentStreak: 3,
    mostMissedTasks: [],
  },
  analysis: {
    explanation: 'A class that fits your schedule.',
    suggestions: [],
    ...analysis,
  },
  progressionProposals: [],
});

describe('GoalAnswer recommendation cards (Stage 1)', () => {
  it('renders structured recommendations with type, name, attribution and reason', () => {
    render(
      <GoalAnswer
        result={baseAnswer({
          recommendations: [
            {
              entityType: 'pottery_class',
              displayName: 'Wheel Throwing for Beginners',
              attribution: 'Clay House Studio',
              reason: 'Close by and beginner-friendly.',
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('RECOMMENDATIONS')).toBeInTheDocument();
    expect(screen.getByText('pottery_class')).toBeInTheDocument();
    expect(screen.getByText('Wheel Throwing for Beginners')).toBeInTheDocument();
    expect(screen.getByText('· Clay House Studio')).toBeInTheDocument();
    expect(screen.getByText('Close by and beginner-friendly.')).toBeInTheDocument();
  });

  it('renders an entity type it has never heard of, verbatim', () => {
    render(
      <GoalAnswer
        result={baseAnswer({
          recommendations: [
            { entityType: 'k9_agility_club', displayName: 'Agility Foundations' },
          ],
        })}
      />,
    );
    expect(screen.getByText('k9_agility_club')).toBeInTheDocument();
    expect(screen.getByText('Agility Foundations')).toBeInTheDocument();
  });

  it('omits the attribution line and reason when the item has none', () => {
    render(
      <GoalAnswer
        result={baseAnswer({
          recommendations: [{ entityType: 'x', displayName: 'Bare Item' }],
        })}
      />,
    );
    expect(screen.getByText('Bare Item')).toBeInTheDocument();
    expect(screen.queryByText(/^· /)).not.toBeInTheDocument();
  });

  it('renders exactly as before when the answer carries no recommendations', () => {
    render(<GoalAnswer result={baseAnswer()} />);
    expect(screen.queryByText('RECOMMENDATIONS')).not.toBeInTheDocument();
    expect(screen.getByText('A class that fits your schedule.')).toBeInTheDocument();
  });

  it('renders nothing for an empty recommendations array', () => {
    render(<GoalAnswer result={baseAnswer({ recommendations: [] })} />);
    expect(screen.queryByText('RECOMMENDATIONS')).not.toBeInTheDocument();
  });

  it('renders no action button when the caller provides no handler (Stage 1 presentation)', () => {
    render(
      <GoalAnswer
        result={baseAnswer({
          recommendations: [{ entityType: 'pottery_class', displayName: 'Wheel Throwing for Beginners' }],
        })}
      />,
    );
    expect(screen.queryByText('Mark as used')).not.toBeInTheDocument();
    expect(screen.queryByText('Saved to your history.')).not.toBeInTheDocument();
  });

  it('offers the durable "used" action and reflects the consumed state', () => {
    const item = { entityType: 'pottery_class', displayName: 'Wheel Throwing for Beginners' };
    const onMarkUsed = vi.fn();
    const { rerender } = render(
      <GoalAnswer
        result={baseAnswer({ recommendations: [item] })}
        onMarkUsed={onMarkUsed}
        consumedIdentities={new Set()}
      />,
    );
    fireEvent.click(screen.getByText('Mark as used'));
    expect(onMarkUsed).toHaveBeenCalledWith(item);
    // After the mutation lands, the card shows the durable state.
    rerender(
      <GoalAnswer
        result={baseAnswer({ recommendations: [item] })}
        onMarkUsed={onMarkUsed}
        consumedIdentities={new Set([recommendationIdentity(item)])}
      />,
    );
    expect(screen.getByText('Marked as used')).toBeInTheDocument();
  });
});
