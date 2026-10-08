package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockFilterChain;

/**
 * The declared wait is a promise about how long an answer is still wanted, and it is the only cancellation
 * signal blocking request handling can act on. These tests pin down what counts as a declaration, because the
 * failure mode of reading one too eagerly is a turn that stops working on an answer somebody was waiting for.
 */
class ProviderTelemetryFilterTest {
    @AfterEach void clearDeadline() { RequestDeadline.clear(); }

    private static MockHttpServletRequest request(String header, String value) {
        var request = new MockHttpServletRequest("POST", "/api/workspaces/one/chats/two/messages");
        if (header != null) request.addHeader(header, value);
        return request;
    }

    @Test void aCallerThatSendsNoHeaderHasNotDeclaredAnything() {
        assertThat(ProviderTelemetryFilter.declaredWait(request(null, null))).isNull();
    }

    @Test void bothTheOwnHeaderAndTheConventionalOneAreRead() {
        assertThat(ProviderTelemetryFilter.declaredWait(request(ProviderTelemetryFilter.CLIENT_TIMEOUT_HEADER, "45")))
                .isEqualTo(Duration.ofSeconds(45));
        assertThat(ProviderTelemetryFilter.declaredWait(request(ProviderTelemetryFilter.ALTERNATE_TIMEOUT_HEADER, "90")))
                .isEqualTo(Duration.ofSeconds(90));
        assertThat(ProviderTelemetryFilter.declaredWait(request(ProviderTelemetryFilter.CLIENT_TIMEOUT_HEADER, " 45 ")))
                .isEqualTo(Duration.ofSeconds(45));
    }

    /** Our own header wins when a proxy has added one too, so a caller can override what the hop in between says. */
    @Test void theOwnHeaderIsPreferredWhenBothArePresent() {
        var both = request(ProviderTelemetryFilter.CLIENT_TIMEOUT_HEADER, "45");
        both.addHeader(ProviderTelemetryFilter.ALTERNATE_TIMEOUT_HEADER, "600");
        assertThat(ProviderTelemetryFilter.declaredWait(both)).isEqualTo(Duration.ofSeconds(45));
    }

    /**
     * A value that cannot be read as a positive number of seconds is a caller mistake, and answering a typo with
     * a timeout would be the wrong reading of it. Unreadable means undeclared, so the configured budget stands.
     */
    @Test void anUnreadableOrNonPositiveValueMeansUndeclared() {
        for (String value : new String[] { "", "   ", "soon", "45s", "1.5", "0", "-30", "99999999999999999999" })
            assertThat(ProviderTelemetryFilter.declaredWait(request(ProviderTelemetryFilter.CLIENT_TIMEOUT_HEADER, value)))
                    .describedAs("declared wait for header value '%s'", value)
                    .isNull();
    }

    /** A malformed preferred header falls through to the alternate rather than shadowing it. */
    @Test void aMalformedHeaderDoesNotHideAUsableOne() {
        var mixed = request(ProviderTelemetryFilter.CLIENT_TIMEOUT_HEADER, "soon");
        mixed.addHeader(ProviderTelemetryFilter.ALTERNATE_TIMEOUT_HEADER, "120");
        assertThat(ProviderTelemetryFilter.declaredWait(mixed)).isEqualTo(Duration.ofSeconds(120));
    }

    @Test void theDeclaredWaitIsVisibleDuringTheRequestAndGoneAfterIt() throws Exception {
        var filter = new ProviderTelemetryFilter();
        var seen = new Duration[1];
        var chain = new MockFilterChain() {
            @Override public void doFilter(jakarta.servlet.ServletRequest req, jakarta.servlet.ServletResponse res) {
                seen[0] = RequestDeadline.declaredClientWait();
            }
        };
        filter.doFilter(request(ProviderTelemetryFilter.CLIENT_TIMEOUT_HEADER, "75"), new MockHttpServletResponse(), chain);
        assertThat(seen[0]).isEqualTo(Duration.ofSeconds(75));
        assertThat(RequestDeadline.declaredClientWait()).isNull();
    }

    /** The turn's own deadline must not survive the request either, or the next turn inherits a spent budget. */
    @Test void aDeadlineSetInsideTheRequestDoesNotOutliveIt() throws Exception {
        var filter = new ProviderTelemetryFilter();
        var chain = new MockFilterChain() {
            @Override public void doFilter(jakarta.servlet.ServletRequest req, jakarta.servlet.ServletResponse res) {
                RequestDeadline.start(Duration.ZERO);
            }
        };
        filter.doFilter(request(null, null), new MockHttpServletResponse(), chain);
        assertThat(RequestDeadline.bounded()).isFalse();
        assertThat(RequestDeadline.spent()).isFalse();
    }

    /** Static assets and the UI are not turns; the filter leaves them alone. */
    @Test void onlyApiRequestsAreFiltered() {
        var filter = new ProviderTelemetryFilter();
        assertThat(filter.shouldNotFilter(new MockHttpServletRequest("GET", "/api/workspaces"))).isFalse();
        assertThat(filter.shouldNotFilter(new MockHttpServletRequest("GET", "/index.html"))).isTrue();
    }
}
