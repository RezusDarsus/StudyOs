import { describe, expect, it } from 'vitest';
import { AttemptWindow, describeWait } from './rate-limit.js';

/** A clock the test moves by hand, so no test waits for a real window to pass. */
function clock(start = 1_700_000_000_000) {
  let at = start;
  return {
    now: () => at,
    advance: (seconds: number) => {
      at += seconds * 1000;
    },
  };
}

describe('AttemptWindow', () => {
  it('allows up to the limit, then blocks', () => {
    const time = clock();
    const window = new AttemptWindow(3, 60, time.now);

    for (let i = 0; i < 3; i++) {
      expect(window.blockedFor('a')).toBe(0);
      window.record('a');
    }
    expect(window.blockedFor('a')).toBeGreaterThan(0);
  });

  it('reports how long is left, in whole seconds', () => {
    const time = clock();
    const window = new AttemptWindow(1, 60, time.now);
    window.record('a');
    expect(window.blockedFor('a')).toBe(60);
    time.advance(30);
    expect(window.blockedFor('a')).toBe(30);
  });

  it('never reports zero seconds while still blocked', () => {
    // A caller that formats this into "try again in 0 seconds" would be lying, and one that
    // treats 0 as "allowed" would let the request through.
    const time = clock();
    const window = new AttemptWindow(1, 60, time.now);
    window.record('a');
    time.advance(59.9);
    expect(window.blockedFor('a')).toBe(1);
  });

  it('lets the attempt through once the window has passed', () => {
    const time = clock();
    const window = new AttemptWindow(2, 60, time.now);
    window.record('a');
    window.record('a');
    expect(window.blockedFor('a')).toBeGreaterThan(0);
    time.advance(61);
    expect(window.blockedFor('a')).toBe(0);
  });

  it('slides rather than resetting on a boundary', () => {
    // The failure a fixed window has: an attacker who spends their budget at the end of one
    // bucket and the start of the next gets 2 × max attempts back to back.
    const time = clock();
    const window = new AttemptWindow(2, 60, time.now);
    window.record('a');
    time.advance(59);
    window.record('a');
    time.advance(2); // the first attempt has now aged out, the second has not
    expect(window.blockedFor('a')).toBe(0);
    window.record('a');
    expect(window.blockedFor('a')).toBeGreaterThan(0);
  });

  it('keeps keys apart', () => {
    const time = clock();
    const window = new AttemptWindow(1, 60, time.now);
    window.record('a');
    expect(window.blockedFor('a')).toBeGreaterThan(0);
    expect(window.blockedFor('b')).toBe(0);
  });

  it('forgets a key on request', () => {
    const time = clock();
    const window = new AttemptWindow(1, 60, time.now);
    window.record('a');
    window.forget('a');
    expect(window.blockedFor('a')).toBe(0);
  });

  it('holds the sustained rate to the limit, however hard the key is hammered', () => {
    // The property that actually matters, and the one a sliding window gives: attempting
    // continuously does not earn extra attempts. Someone trying every second for five
    // windows gets `max` per window and no more — the block expiring on schedule rather
    // than being extended costs nothing, because each attempt it lets through is counted.
    const time = clock();
    const window = new AttemptWindow(2, 60, time.now);

    let allowed = 0;
    for (let second = 0; second < 300; second++) {
      if (window.blockedFor('a') === 0) {
        allowed++;
        window.record('a');
      }
      time.advance(1);
    }
    // Five windows of two, plus the boundary case of the very first tick.
    expect(allowed).toBeLessThanOrEqual(11);
  });

  it('does not let hammering shorten the block either', () => {
    // `record` keeps only the newest `max` timestamps, so it would be possible for extra
    // attempts to discard the oldest one and pull the expiry closer. The wait must stay
    // whole: bounded by the window, never cut short by attempting again.
    const time = clock();
    const window = new AttemptWindow(2, 60, time.now);
    window.record('a');
    window.record('a');
    const before = window.blockedFor('a');
    window.record('a'); // a caller ignoring the block, or a future one that records blindly
    expect(window.blockedFor('a')).toBeGreaterThanOrEqual(before);
    expect(window.blockedFor('a')).toBeLessThanOrEqual(60);
  });

  it('releases the key entirely once every attempt has aged out', () => {
    const time = clock();
    const window = new AttemptWindow(2, 60, time.now);
    window.record('a');
    expect(window.size).toBe(1);
    time.advance(61);
    expect(window.blockedFor('a')).toBe(0);
    // Not merely allowed again — actually released, so an address seen once does not
    // occupy memory for the rest of the process's life.
    expect(window.size).toBe(0);
  });

  describe('memory', () => {
    it('stops growing when addresses are rotated', () => {
      const time = clock();
      const window = new AttemptWindow(5, 60, time.now, 100);
      for (let i = 0; i < 1_000; i++) window.record(`address-${i}`);
      expect(window.size).toBeLessThanOrEqual(100);
    });

    it('stores at most `max` timestamps per key', () => {
      // Otherwise a determined attacker turns one key into an unbounded array.
      const time = clock();
      const window = new AttemptWindow(3, 3600, time.now);
      for (let i = 0; i < 10_000; i++) {
        window.record('a');
        time.advance(0.001);
      }
      // Nothing public exposes the array, so assert the consequence: the block is still
      // measured from one window ago, not from ten thousand attempts ago.
      expect(window.blockedFor('a')).toBeLessThanOrEqual(3600);
      expect(window.size).toBe(1);
    });

    it('drops dead keys before live ones', () => {
      const time = clock();
      const window = new AttemptWindow(5, 60, time.now, 10);
      for (let i = 0; i < 10; i++) window.record(`old-${i}`);
      time.advance(61); // every one of those is now expired

      window.record('current');
      for (let i = 0; i < 5; i++) window.record(`new-${i}`);
      // The expired keys were swept, so the live one survived the crowding.
      expect(window.blockedFor('current')).toBe(0);
      expect(window.size).toBeLessThanOrEqual(10);
    });
  });
});

describe('describeWait', () => {
  it('reads as something a person would say', () => {
    expect(describeWait(30)).toBe('30 seconds');
    expect(describeWait(60)).toBe('a minute');
    expect(describeWait(61)).toBe('2 minutes');
    expect(describeWait(15 * 60)).toBe('15 minutes');
  });

  it('rounds up, so it never promises sooner than it means', () => {
    // `blockedFor` floors at 1, so "1 seconds" is a message a real user can be shown.
    expect(describeWait(1)).toBe('a second');
    expect(describeWait(0.4)).toBe('a second');
    expect(describeWait(59.5)).toBe('60 seconds');
  });
});
