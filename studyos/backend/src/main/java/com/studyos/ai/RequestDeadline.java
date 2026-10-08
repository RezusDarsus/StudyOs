package com.studyos.ai;

import java.time.Duration;

/**
 * The wall-clock budget the current turn has left. A turn fans out into many provider calls, and each of
 * those may retry, so the only way a single answer can be bounded is for the pieces that block to agree on
 * one shared clock rather than each enforcing a local timeout of its own.
 *
 * <p>Unset means unbounded, which is deliberate: background ingestion legitimately runs for minutes and must
 * keep working exactly as before. Everything here is a no-op until some caller opts in with {@link #start}.
 */
public final class RequestDeadline {
    /** An attempt shorter than this cannot realistically return, so the budget is spent rather than wasted. */
    private static final Duration MINIMUM_USEFUL_ATTEMPT = Duration.ofSeconds(2);
    /**
     * The shortest turn a declared client wait may produce. A caller that says it will wait one second has
     * asked for something no generation can deliver, and honouring that literally would turn every answer into
     * a timeout — a single mistaken header would switch answering off. The floor keeps the turn trying.
     */
    private static final Duration MINIMUM_TURN_BUDGET = Duration.ofSeconds(10);
    private static final ThreadLocal<Long> DEADLINE_NANOS = new ThreadLocal<>();
    /**
     * How long the caller said it would wait, when it said so. A server cannot see a client hang up: with
     * blocking request handling the socket's state is not readable until something is written to it, which for
     * one of these turns is minutes after the client has gone. What the caller <em>can</em> do is say up front
     * how long its own timeout is, and that is enough — past that instant the work is certainly unwanted, so
     * the declared wait, not a TCP signal, is what cancellation is derived from here.
     */
    private static final ThreadLocal<Duration> CLIENT_WAIT = new ThreadLocal<>();

    private RequestDeadline() {}

    public static void start(Duration budget) { DEADLINE_NANOS.set(System.nanoTime() + Math.max(0, budget.toNanos())); }
    public static void clear() { DEADLINE_NANOS.remove(); CLIENT_WAIT.remove(); }
    public static boolean bounded() { return DEADLINE_NANOS.get() != null; }

    /** Records the wait the caller declared for this request. Null or nonsensical values leave it undeclared. */
    public static void declaredClientWait(Duration declared) {
        if (declared == null || declared.isNegative() || declared.isZero()) CLIENT_WAIT.remove();
        else CLIENT_WAIT.set(declared);
    }

    public static Duration declaredClientWait() { return CLIENT_WAIT.get(); }

    /**
     * The budget a turn should run under: its configured ceiling, or the caller's declared wait when that is
     * shorter, less {@code reserve} for the work that still has to happen after the last provider call —
     * rendering, auditing and persisting an answer nobody would receive if the budget ran out first.
     *
     * <p>A caller that declares nothing gets the configured ceiling unchanged, so nothing about existing
     * clients or background work changes.
     */
    public static Duration turnBudget(Duration configured, Duration reserve) {
        Duration declared = CLIENT_WAIT.get();
        if (declared == null) return configured;
        Duration usable = declared.minus(reserve == null ? Duration.ZERO : reserve);
        if (usable.compareTo(MINIMUM_TURN_BUDGET) < 0) usable = MINIMUM_TURN_BUDGET;
        return usable.compareTo(configured) < 0 ? usable : configured;
    }

    /** What is left of the budget, or {@code null} when this turn is unbounded. Never negative. */
    public static Duration remaining() { Long deadline = DEADLINE_NANOS.get(); return deadline == null ? null : Duration.ofNanos(Math.max(0, deadline - System.nanoTime())); }

    /** Whether there is still enough time for one more blocking attempt to be worth starting. */
    public static boolean spent() { Duration left = remaining(); return left != null && left.compareTo(MINIMUM_USEFUL_ATTEMPT) < 0; }

    /**
     * Whether a stage expected to cost {@code expected} can still be afforded. A stage worth starting only
     * because a millisecond is left is the failure mode this prevents: work that consumes the rest of the
     * budget and is then thrown away unfinished, leaving the turn with nothing to show for the wait. Callers
     * pass what the same work measurably cost the first time rather than a guess.
     */
    public static boolean allows(Duration expected) {
        Duration left = remaining();
        Duration needed = expected == null || expected.compareTo(MINIMUM_USEFUL_ATTEMPT) < 0 ? MINIMUM_USEFUL_ATTEMPT : expected;
        return left == null || left.compareTo(needed) >= 0;
    }

    /**
     * Caps a timeout at what the turn still has. An attempt that would outlive the answer's usefulness is
     * cut to the remaining budget so it fails inside this turn instead of holding the thread past it.
     */
    public static Duration cap(Duration requested) { Duration left = remaining(); return left == null || left.compareTo(requested) >= 0 ? requested : left; }

    /** Milliseconds a caller may sleep before its next attempt, keeping {@code reserve} for the attempt itself. */
    public static long sleepableMillis(long requestedMillis, Duration reserve) {
        Duration left = remaining();
        if (left == null) return requestedMillis;
        long available = left.toMillis() - reserve.toMillis();
        return Math.min(requestedMillis, Math.max(0, available));
    }

    /** Stops the turn at a named stage rather than starting work whose result would arrive too late. */
    public static void requireTimeRemaining(String stage) { if (spent()) throw new DeadlineExceededException(stage); }
}
