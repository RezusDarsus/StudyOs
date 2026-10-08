package com.studyos.ai;

/**
 * Structured internal reason for a provider failure. Distinguishing "temporary" from "invalid"
 * is the whole point: 429/5xx/timeouts deserve bounded retries, while 401/403/404-with-body are
 * configuration errors that no retry can fix — retrying them only burns the learner's deadline.
 *
 * <p>These codes are internal diagnostics. Learner-facing surfaces translate them into plain
 * language and never show raw provider responses.
 */
public enum ProviderFailureClassification {
    CREDENTIALS_OR_CONFIG,
    MODEL_OR_ROUTE_NOT_FOUND,
    RATE_LIMITED,
    PROVIDER_TRANSIENT,
    TIMEOUT,
    NETWORK,
    HOSTED_ENDPOINT_EMPTY_404,
    UNKNOWN;

    /**
     * Classifies an HTTP status (with the response body when available) into the reason family.
     * The empty-body 404 stays separate and retryable: NVIDIA's hosted endpoint occasionally
     * returns it before a model route is warm, and a retry succeeds.
     */
    public static ProviderFailureClassification fromStatus(int status, String responseBody) {
        boolean blankBody = responseBody == null || responseBody.isBlank();
        return switch (status) {
            case 401, 403 -> CREDENTIALS_OR_CONFIG;
            case 404 -> blankBody ? HOSTED_ENDPOINT_EMPTY_404 : MODEL_OR_ROUTE_NOT_FOUND;
            case 408 -> PROVIDER_TRANSIENT;
            case 429 -> RATE_LIMITED;
            case 500, 501, 502, 503, 504 -> PROVIDER_TRANSIENT;
            default -> UNKNOWN;
        };
    }

    public static ProviderFailureClassification fromThrowable(Throwable error) {
        if (error instanceof java.net.http.HttpTimeoutException) return TIMEOUT;
        if (error instanceof java.io.IOException) return NETWORK;
        if (error instanceof AiProviderException provider && provider.statusCode() != null) {
            return fromStatus(provider.statusCode(), null);
        }
        return UNKNOWN;
    }

    /** Whether the failure family can ever be fixed by retrying. */
    public boolean transientlyRetryable() {
        return this == RATE_LIMITED || this == PROVIDER_TRANSIENT || this == TIMEOUT
                || this == NETWORK || this == HOSTED_ENDPOINT_EMPTY_404;
    }
}
