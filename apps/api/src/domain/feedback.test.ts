import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_WINDOW_DAYS,
  isActionableSignal,
  summarizeFeedback,
  type FeedbackEntry,
} from './feedback.js';

// Milestone 13. The rule these tests exist to protect: difficulty feedback is
// evidence, never authority. A summary may say "this keeps feeling too hard"; it may
// never be firm enough on its own to justify changing someone's plan behind their
// back, and it must admit when the picture is mixed instead of picking a side.

const TODAY = '2026-08-20';

/** n days of the same rating, ending today. */
const run = (rating: FeedbackEntry['rating'], count: number, endingOn = TODAY): FeedbackEntry[] =>
  Array.from({ length: count }, (_, i) => {
    const date = new Date(`${endingOn}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - i);
    return { day: date.toISOString().slice(0, 10), rating };
  });

describe('feedback summary', () => {
  it('says nothing at all when nobody has rated anything', () => {
    const summary = summarizeFeedback([], TODAY);
    expect(summary.sampleSize).toBe(0);
    expect(summary.signal).toBe('UNKNOWN');
    expect(summary.dominant).toBeNull();
    expect(summary.latest).toBeNull();
    expect(isActionableSignal(summary)).toBe(false);
  });

  it('holds back on one rating, however emphatic', () => {
    const summary = summarizeFeedback(run('TOO_HARD', 1), TODAY);
    // The count is reported honestly — it is the *signal* that stays silent.
    expect(summary.counts.TOO_HARD).toBe(1);
    expect(summary.dominant).toBe('TOO_HARD');
    expect(summary.signal).toBe('UNKNOWN');
    expect(isActionableSignal(summary)).toBe(false);
  });

  it('speaks once three days agree', () => {
    const summary = summarizeFeedback(run('TOO_HARD', 3), TODAY);
    expect(summary.sampleSize).toBe(3);
    expect(summary.signal).toBe('TOO_HARD');
    expect(isActionableSignal(summary)).toBe(true);
  });

  it('reports a genuinely mixed picture as mixed, not as the winner', () => {
    const summary = summarizeFeedback(
      [...run('TOO_HARD', 2), ...run('TOO_EASY', 2, '2026-08-17')],
      TODAY,
    );
    expect(summary.sampleSize).toBe(4);
    expect(summary.signal).toBe('MIXED');
    // Nothing to act on: the user has said opposite things and deserves a question,
    // not a change.
    expect(isActionableSignal(summary)).toBe(false);
  });

  it('breaks an even split towards "fine" rather than towards a change', () => {
    const summary = summarizeFeedback(
      [...run('TOO_HARD', 2), ...run('JUST_RIGHT', 2, '2026-08-17')],
      TODAY,
    );
    expect(summary.dominant).toBe('JUST_RIGHT');
    expect(summary.signal).toBe('MIXED');
  });

  it('needs a real majority, not a plurality', () => {
    // 3 of 7 leads, and means nothing.
    const summary = summarizeFeedback(
      [
        ...run('TOO_HARD', 3),
        ...run('TOO_EASY', 2, '2026-08-17'),
        ...run('JUST_RIGHT', 2, '2026-08-15'),
      ],
      TODAY,
    );
    expect(summary.dominant).toBe('TOO_HARD');
    expect(summary.signal).toBe('MIXED');
  });

  it('forgets ratings that fall out of the window', () => {
    const old = run('TOO_HARD', 3, '2026-07-01');
    const summary = summarizeFeedback(old, TODAY);
    expect(summary.sampleSize).toBe(0);
    expect(summary.signal).toBe('UNKNOWN');
    expect(summary.windowStart).toBe('2026-07-31');
  });

  it('keeps the oldest day the window still covers', () => {
    const edge = summarizeFeedback([{ day: '2026-07-31', rating: 'TOO_HARD' }], TODAY);
    expect(edge.sampleSize).toBe(1);
    // Off by one here would quietly shorten every window in the app.
    expect(FEEDBACK_WINDOW_DAYS).toBe(21);
  });

  it('counts today, because a day you have lived can be judged', () => {
    // Deliberately unlike a progression review, whose window stops at yesterday.
    const summary = summarizeFeedback([{ day: TODAY, rating: 'JUST_RIGHT' }], TODAY);
    expect(summary.sampleSize).toBe(1);
    expect(summary.latest).toEqual({ day: TODAY, rating: 'JUST_RIGHT' });
  });

  it('ignores a rating dated in the future', () => {
    const summary = summarizeFeedback([{ day: '2026-08-21', rating: 'TOO_EASY' }], TODAY);
    expect(summary.sampleSize).toBe(0);
  });

  it('reports the most recent rating even when the aggregate disagrees', () => {
    const summary = summarizeFeedback(
      [...run('TOO_EASY', 3, '2026-08-19'), { day: TODAY, rating: 'TOO_HARD' }],
      TODAY,
    );
    expect(summary.signal).toBe('TOO_EASY');
    // The turn is worth surfacing beside the trend — one hard day after an easy week
    // is a fact, not a contradiction to be smoothed away.
    expect(summary.latest).toEqual({ day: TODAY, rating: 'TOO_HARD' });
  });

  it('treats "just right" as good news, not as something to act on', () => {
    const summary = summarizeFeedback(run('JUST_RIGHT', 5), TODAY);
    expect(summary.signal).toBe('JUST_RIGHT');
    // Nothing needs doing, so nothing gets raised. Telling someone their plan is
    // fine every week is noise.
    expect(isActionableSignal(summary)).toBe(false);
  });

  it('does not care what order the ratings arrive in', () => {
    const entries = run('TOO_EASY', 4);
    const forwards = summarizeFeedback(entries, TODAY);
    const backwards = summarizeFeedback([...entries].reverse(), TODAY);
    expect(backwards).toEqual(forwards);
  });
});
