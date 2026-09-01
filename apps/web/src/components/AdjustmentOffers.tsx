// "Worth a look" — the changes the app is willing to offer, and nothing more.
//
// Everything in this panel comes from a read-only endpoint that derives its offers
// from the user's own difficulty ratings. Three rules are visible here rather than
// only enforced on the server:
//
//  * Nothing applies itself. Every offer opens the progression view, which shows the
//    live numbers and holds the button that actually moves a stage.
//  * An offer the completion rate does not support says so, on the card, before the
//    user acts on it.
//  * Silence is the normal state. No offers means no panel — not a card explaining
//    that there is nothing to explain.

import { useState } from 'react';
import { Gauge, TrendingDown, TrendingUp } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, useAsync } from './ui';
import ProgressionModal from './ProgressionPanel';
import type { AdjustmentOffer, AdjustmentOffersResponse } from '../lib/types';

const ICON = {
  EASE_STAGE: TrendingDown,
  ADVANCE_STAGE: TrendingUp,
  // A build-up can be either direction depending on why it is being offered, so this
  // borrows the glyph the difficulty line already uses rather than implying one.
  START_LADDER: Gauge,
} as const;

export default function AdjustmentOffers({
  goalId,
  onChanged,
}: {
  goalId: string;
  onChanged?: () => void;
}) {
  const { data, error, reload } = useAsync<AdjustmentOffersResponse>(
    () => api.get(`/goals/${goalId}/adjustments`),
    [goalId],
  );
  const [openTask, setOpenTask] = useState<AdjustmentOffer | null>(null);
  const [stale, setStale] = useState(false);

  // No skeleton and no error box on purpose. This panel is an extra, and the same
  // ratings it is built from are already on every task row — a spinner or a red
  // banner here would make an optional suggestion look like a broken feature.
  if (error || !data || data.offers.length === 0) return null;

  return (
    <div className="mb-4">
      <div
        className="mb-2.5"
        style={{
          fontSize: '0.72rem',
          fontWeight: 500,
          color: 'var(--text-body)',
          letterSpacing: '0.05em',
          fontFamily: 'var(--font-sans)',
        }}
      >
        WORTH A LOOK
      </div>

      <div className="flex flex-col gap-2">
        {data.offers.map((offer) => {
          const Icon = ICON[offer.kind];
          return (
            <div
              key={`${offer.taskId}-${offer.kind}`}
              className="rounded-xl px-3.5 py-3"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
            >
              <div className="flex items-start gap-2">
                <Icon
                  size={14}
                  style={{ color: 'var(--text)', flexShrink: 0, marginTop: 2 }}
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      style={{
                        fontSize: '0.85rem',
                        fontWeight: 500,
                        color: 'var(--text)',
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      {offer.headline}
                    </span>
                    {/* Said in words as well as shown, because this is the one thing
                        on the card a user must not miss. */}
                    {offer.needsOverride && <Badge tone="neutral">Your call</Badge>}
                  </div>
                  <p className="mt-1" style={{ fontSize: '0.78rem', color: 'var(--text-body)', lineHeight: 1.55 }}>
                    {offer.because}
                  </p>

                  {data.canApply ? (
                    <button
                      onClick={() => setOpenTask(offer)}
                      className="mt-2.5"
                      style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--text)' }}
                    >
                      {offer.kind === 'START_LADDER' ? 'Set up a build-up' : 'Open the build-up'} →
                    </button>
                  ) : (
                    <p className="mt-2" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                      The goal owner sets the pace for everyone, so this one is theirs to
                      change. The ratings behind it are your own.
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-2.5" style={{ fontSize: '0.72rem', color: 'var(--text-faint)', lineHeight: 1.5 }}>
        Nothing here has happened. Each one opens the build-up, where the numbers sit next
        to the button — and days already past keep the target they asked for.
      </p>

      {openTask && (
        <ProgressionModal
          open
          taskId={openTask.taskId}
          taskTitle={openTask.taskTitle}
          isOwner={data.canApply}
          onClose={() => {
            setOpenTask(null);
            // Refetching while the modal is up would tear it down mid-read, so the
            // offers are brought back into line once the user is done looking.
            if (stale) {
              setStale(false);
              reload();
              onChanged?.();
            }
          }}
          onChanged={() => setStale(true)}
        />
      )}
    </div>
  );
}
