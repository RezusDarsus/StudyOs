package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class RequestDeadlineTest {
    @AfterEach void clearDeadline() { RequestDeadline.clear(); }

    @Test void anUnboundedTurnBehavesExactlyAsItDidBeforeDeadlinesExisted() {
        assertThat(RequestDeadline.bounded()).isFalse();
        assertThat(RequestDeadline.remaining()).isNull();
        assertThat(RequestDeadline.spent()).isFalse();
        assertThat(RequestDeadline.cap(Duration.ofMinutes(4))).isEqualTo(Duration.ofMinutes(4));
        assertThat(RequestDeadline.sleepableMillis(2_000, Duration.ofSeconds(2))).isEqualTo(2_000);
        RequestDeadline.requireTimeRemaining("an unbounded stage");
    }

    /** The point of the cap: a per-attempt timeout can never outlive the turn it belongs to. */
    @Test void aTimeoutIsCutToWhatTheTurnStillHas() {
        RequestDeadline.start(Duration.ofSeconds(30));
        assertThat(RequestDeadline.cap(Duration.ofMinutes(4))).isLessThanOrEqualTo(Duration.ofSeconds(30));
        assertThat(RequestDeadline.cap(Duration.ofSeconds(5))).isEqualTo(Duration.ofSeconds(5));
    }

    @Test void anExhaustedBudgetStopsTheNextStageInsteadOfStartingIt() {
        RequestDeadline.start(Duration.ZERO);
        assertThat(RequestDeadline.spent()).isTrue();
        assertThat(RequestDeadline.remaining()).isEqualTo(Duration.ZERO);
        assertThatThrownBy(() -> RequestDeadline.requireTimeRemaining("the provider call"))
                .isInstanceOf(DeadlineExceededException.class)
                .hasMessageContaining("the provider call");
    }

    /** A backoff may never consume the room the attempt after it needs. */
    @Test void backoffIsClampedToTheBudgetLeftAfterReservingTheAttempt() {
        RequestDeadline.start(Duration.ofSeconds(3));
        assertThat(RequestDeadline.sleepableMillis(10_000, Duration.ofSeconds(2))).isBetween(0L, 1_000L);
        RequestDeadline.start(Duration.ofSeconds(1));
        assertThat(RequestDeadline.sleepableMillis(10_000, Duration.ofSeconds(2))).isZero();
    }

    /** Jitter spreads concurrent retries without ever exceeding the deterministic ceiling. */
    @Test void jitterStaysInsideTheLowerHalfOfItsCeiling() {
        for (int run = 0; run < 200; run++) assertThat(NvidiaGateway.jitter(2_000)).isBetween(1_000L, 2_000L);
        assertThat(NvidiaGateway.jitter(0)).isZero();
        assertThat(NvidiaGateway.jitter(1)).isEqualTo(1);
    }

    /**
     * A repeatable stage asks whether it can afford what it measurably cost last time. Answering "yes" on a
     * sliver of budget is what turns a slow turn into a slow turn with nothing to show.
     */
    @Test void aStageIsOnlyStartedWhenWhatItCostBeforeStillFits() {
        RequestDeadline.start(Duration.ofSeconds(60));
        assertThat(RequestDeadline.allows(Duration.ofSeconds(40))).isTrue();
        assertThat(RequestDeadline.allows(Duration.ofSeconds(90))).isFalse();
        RequestDeadline.start(Duration.ofSeconds(1));
        assertThat(RequestDeadline.allows(Duration.ofMillis(10))).isFalse();
    }

    @Test void anUnboundedTurnAffordsEveryStage() {
        assertThat(RequestDeadline.allows(Duration.ofHours(1))).isTrue();
        assertThat(RequestDeadline.allows(null)).isTrue();
    }

    /** A caller that says nothing about its own patience gets the server's configured ceiling, unchanged. */
    @Test void anUndeclaredWaitLeavesTheConfiguredBudgetAlone() {
        assertThat(RequestDeadline.declaredClientWait()).isNull();
        assertThat(RequestDeadline.turnBudget(Duration.ofSeconds(240), Duration.ofSeconds(5))).isEqualTo(Duration.ofSeconds(240));
        assertThat(RequestDeadline.turnBudget(Duration.ofSeconds(240), null)).isEqualTo(Duration.ofSeconds(240));
    }

    /**
     * The reserve is the room left for the work after generation — verification wording, persistence, the
     * response itself. Spending the caller's whole wait on generation returns a finished answer to nobody.
     */
    @Test void aShorterDeclaredWaitShrinksTheBudgetAndKeepsTheReserve() {
        RequestDeadline.declaredClientWait(Duration.ofSeconds(60));
        assertThat(RequestDeadline.declaredClientWait()).isEqualTo(Duration.ofSeconds(60));
        assertThat(RequestDeadline.turnBudget(Duration.ofSeconds(240), Duration.ofSeconds(5))).isEqualTo(Duration.ofSeconds(55));
    }

    /** A caller may not buy more time than the server configured; the declared wait can only ever shorten. */
    @Test void aLongerDeclaredWaitCannotRaiseTheConfiguredCeiling() {
        RequestDeadline.declaredClientWait(Duration.ofHours(1));
        assertThat(RequestDeadline.turnBudget(Duration.ofSeconds(240), Duration.ofSeconds(5))).isEqualTo(Duration.ofSeconds(240));
    }

    /**
     * One mistaken header must not switch answering off. Below the floor the turn still gets a usable slice and
     * simply overruns a caller who asked for the impossible, which is a late answer rather than no answer.
     */
    @Test void anAbsurdlySmallDeclaredWaitIsFlooredInsteadOfDisablingTheTurn() {
        RequestDeadline.declaredClientWait(Duration.ofSeconds(1));
        assertThat(RequestDeadline.turnBudget(Duration.ofSeconds(240), Duration.ofSeconds(5))).isEqualTo(Duration.ofSeconds(10));
        RequestDeadline.declaredClientWait(Duration.ofSeconds(12));
        assertThat(RequestDeadline.turnBudget(Duration.ofSeconds(240), Duration.ofSeconds(5))).isEqualTo(Duration.ofSeconds(10));
    }

    /** A configured ceiling under the floor still wins: the floor raises a declared wait, never the server's. */
    @Test void theFloorNeverLengthensAConfiguredBudgetThatIsAlreadyShort() {
        RequestDeadline.declaredClientWait(Duration.ofSeconds(1));
        assertThat(RequestDeadline.turnBudget(Duration.ofSeconds(4), Duration.ofSeconds(5))).isEqualTo(Duration.ofSeconds(4));
    }

    @Test void anEmptyOrBackwardsDeclaredWaitCountsAsNotDeclared() {
        RequestDeadline.declaredClientWait(Duration.ofSeconds(30));
        RequestDeadline.declaredClientWait(null);
        assertThat(RequestDeadline.declaredClientWait()).isNull();
        RequestDeadline.declaredClientWait(Duration.ZERO);
        assertThat(RequestDeadline.declaredClientWait()).isNull();
        RequestDeadline.declaredClientWait(Duration.ofSeconds(-5));
        assertThat(RequestDeadline.declaredClientWait()).isNull();
    }

    /** Both thread-locals live and die on the request boundary, or a pooled thread inherits the last caller's. */
    @Test void clearingTheTurnDropsTheDeclaredWaitToo() {
        RequestDeadline.start(Duration.ofSeconds(30));
        RequestDeadline.declaredClientWait(Duration.ofSeconds(30));
        RequestDeadline.clear();
        assertThat(RequestDeadline.bounded()).isFalse();
        assertThat(RequestDeadline.declaredClientWait()).isNull();
        assertThat(RequestDeadline.turnBudget(Duration.ofSeconds(240), Duration.ofSeconds(5))).isEqualTo(Duration.ofSeconds(240));
    }
}
