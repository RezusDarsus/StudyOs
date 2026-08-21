// Throttling for the handful of endpoints where guessing is the attack.
//
// A password is the one credential in this system that a stranger can try repeatedly for
// free. Sessions are 32 random bytes and reset tokens are too — neither is worth guessing —
// but `POST /auth/login` will check any password anyone offers, as fast as bcrypt allows,
// forever. That is the hole this closes.
//
// In memory, and per process, which is a real limitation stated plainly rather than hidden:
// run two API instances and each keeps its own counters, so the effective limit doubles.
// The alternative is a shared counter in PostgreSQL — a write on every failed login, and a
// second thing to get wrong — and the moment to build it is when there are two instances,
// not before. Two API containers behind one nginx would still be a large improvement on no
// limit at all, which is what this replaces.
//
// One rule shapes every use of this module: **never key a limit on the account alone.** A
// counter keyed on an email address is a way for anyone to lock a stranger out of their own
// account by failing five logins on their behalf. Keys here combine the address with the
// account, so an attacker throttles only themselves.

/**
 * A sliding window of attempts per key.
 *
 * Sliding rather than a fixed bucket: a fixed window resets on a clock boundary, so an
 * attacker who knows where the boundary is gets `2 × max` attempts back to back across it.
 */
export class AttemptWindow {
  private readonly attempts = new Map<string, number[]>();

  /**
   * @param max        attempts allowed inside the window
   * @param windowSeconds how long an attempt is remembered
   * @param now        injected in tests; nothing else should pass it
   * @param maxKeys    hard ceiling on distinct keys held, so that rotating addresses
   *                   cannot turn this defence into a memory leak
   */
  constructor(
    private readonly max: number,
    private readonly windowSeconds: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = 10_000,
  ) {}

  /** Drop anything older than the window, and return what is left. */
  private live(key: string, now: number): number[] {
    const cutoff = now - this.windowSeconds * 1000;
    const kept = (this.attempts.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length > 0) this.attempts.set(key, kept);
    else this.attempts.delete(key);
    return kept;
  }

  /**
   * Seconds this key must wait, or 0 if it may proceed. Records nothing.
   *
   * Separate from `record` on purpose: the caller checks before doing the work and records
   * only what actually failed, so a user typing the right password first time is never
   * counted at all and the limit can be tight without being felt.
   */
  blockedFor(key: string): number {
    const now = this.now();
    const kept = this.live(key, now);
    if (kept.length < this.max) return 0;
    const expiresAt = kept[0]! + this.windowSeconds * 1000;
    return Math.max(1, Math.ceil((expiresAt - now) / 1000));
  }

  /**
   * Count one attempt against this key.
   *
   * The block is not extended by attempting again. A caller who keeps hammering has the
   * clock run down as if they had stopped, which sounds like a hole and is not: the oldest
   * attempt ages out, they get exactly one more, and it is counted. The sustained rate is
   * `max` per window whatever they do in between, which is the property the limit is for.
   * Extending the block instead would mean a client stuck in a retry loop — including an
   * honest one with a bug — could never recover, and would put no ceiling on the wait a
   * message has to quote.
   */
  record(key: string): void {
    const now = this.now();
    const kept = this.live(key, now);
    kept.push(now);
    // Cap the array at `max`. Unreachable through `throttle`, which only records after
    // `blockedFor` returned 0, so this exists to keep a future caller that records
    // unconditionally from turning one key into an unbounded array. The newest are kept:
    // they are the ones still inside the window.
    if (kept.length > this.max) kept.splice(0, kept.length - this.max);
    this.attempts.set(key, kept);
    this.evict(now);
  }

  /** Forget a key. Called on success, so one good login clears the slate. */
  forget(key: string): void {
    this.attempts.delete(key);
  }

  /** How many keys are held. For the tests and for diagnostics. */
  get size(): number {
    return this.attempts.size;
  }

  private evict(now: number): void {
    if (this.attempts.size <= this.maxKeys) return;

    const cutoff = now - this.windowSeconds * 1000;
    for (const [key, times] of this.attempts) {
      if (times[times.length - 1]! <= cutoff) this.attempts.delete(key);
    }
    if (this.attempts.size <= this.maxKeys) return;

    // Still full of live counters, which means this is an attack rather than accumulated
    // dust. Drop the oldest-created keys: a Map iterates in insertion order and re-setting
    // a key does not move it, so this is first-seen-first-out. Dropping a counter fails
    // open for that key, which is the right direction for a mistake to go — an eviction
    // must never lock out a legitimate user who happens to be in the wrong bucket.
    const excess = this.attempts.size - this.maxKeys;
    let dropped = 0;
    for (const key of this.attempts.keys()) {
      if (dropped >= excess) break;
      this.attempts.delete(key);
      dropped++;
    }
  }
}

/**
 * "14 minutes", "45 seconds" — for a message a person reads.
 *
 * Rounded up and deliberately vague. The exact second is not useful to a user and telling
 * an attacker precisely when to resume is not useful to us.
 */
export function describeWait(seconds: number): string {
  if (seconds < 60) {
    const whole = Math.max(1, Math.ceil(seconds));
    return whole === 1 ? 'a second' : `${whole} seconds`;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}
