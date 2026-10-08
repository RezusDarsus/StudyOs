package com.studyos.ai;

/** A sanitized provider failure that can be mapped to an actionable API status. */
public class AiProviderException extends RuntimeException {
    private final String provider;
    private final Integer statusCode;
    private final boolean retryable;

    public AiProviderException(String provider, Integer statusCode, boolean retryable, String message) {
        super(message);
        this.provider = provider;
        this.statusCode = statusCode;
        this.retryable = retryable;
    }

    public AiProviderException(String provider, Integer statusCode, boolean retryable, String message, Throwable cause) {
        super(message, cause);
        this.provider = provider;
        this.statusCode = statusCode;
        this.retryable = retryable;
    }

    public String provider() { return provider; }
    public Integer statusCode() { return statusCode; }
    public boolean retryable() { return retryable; }
}
