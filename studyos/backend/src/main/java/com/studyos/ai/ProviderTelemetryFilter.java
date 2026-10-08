package com.studyos.ai;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Owns the per-request lifecycle of {@link ProviderCallTelemetry}: counters start empty for every API
 * request and are cleared afterwards so pooled request threads never carry a previous turn's attempts.
 * The counters themselves are reported in the reply body, or in the error body when a turn fails.
 *
 * <p>It clears {@link RequestDeadline} on the same boundary. The deadline is opted into by the handlers that
 * want one, but it must never outlive the request that set it, or the next turn on a pooled thread would
 * inherit a budget that has already expired.
 *
 * <p>It also picks up the wait a caller declares for itself, which is the only cancellation signal this server
 * can actually act on. Blocking request handling cannot observe a client hanging up until it writes to the
 * socket, and for a long generation that is minutes after the answer stopped being wanted; a caller that states
 * its own timeout up front gives the turn a point past which the work is certainly useless.
 */
@Component
@Order(0)
public class ProviderTelemetryFilter extends OncePerRequestFilter {
    /** Preferred header. {@code Request-Timeout} is accepted too, for callers and proxies that already send it. */
    static final String CLIENT_TIMEOUT_HEADER = "X-Client-Timeout-Seconds";
    static final String ALTERNATE_TIMEOUT_HEADER = "Request-Timeout";

    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        ProviderCallTelemetry.reset();
        RequestDeadline.declaredClientWait(declaredWait(request));
        try { chain.doFilter(request, response); } finally { ProviderCallTelemetry.clear(); RequestDeadline.clear(); }
    }

    /**
     * The caller's declared wait in seconds, or {@code null} when it did not say. A header that cannot be read
     * as a positive number of seconds is treated as not said rather than as zero: a malformed value is a caller
     * mistake, and letting it shorten the budget would answer a typo with a timeout.
     */
    static java.time.Duration declaredWait(HttpServletRequest request) {
        for (String header : new String[] { CLIENT_TIMEOUT_HEADER, ALTERNATE_TIMEOUT_HEADER }) {
            String raw = request.getHeader(header);
            if (raw == null || raw.isBlank()) continue;
            try {
                long seconds = Long.parseLong(raw.trim());
                if (seconds > 0) return java.time.Duration.ofSeconds(seconds);
            } catch (NumberFormatException ignored) { /* treated as undeclared below */ }
        }
        return null;
    }
    @Override protected boolean shouldNotFilter(HttpServletRequest request) { return !request.getRequestURI().startsWith("/api/"); }
}
