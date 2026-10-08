package com.studyos;

import com.studyos.ai.AiProviderException;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

@RestControllerAdvice
public class ApiExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler({IllegalArgumentException.class, MethodArgumentNotValidException.class, HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    public ResponseEntity<ApiError> badRequest(Exception exception, HttpServletRequest request) {
        String message = exception instanceof MethodArgumentNotValidException validation
                ? validation.getBindingResult().getFieldErrors().stream().map(error -> error.getField() + ": " + error.getDefaultMessage()).collect(Collectors.joining("; "))
                : exception.getMessage() == null ? "Request is invalid" : exception.getMessage();
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(error(HttpStatus.BAD_REQUEST, message, request));
    }

    /**
     * The workspace does not hold what the request needs yet. The message names what is missing and is
     * written for the student, so it is returned instead of being replaced by a generic failure.
     */
    @ExceptionHandler(WorkspaceNotReadyException.class)
    public ResponseEntity<ApiError> notReady(WorkspaceNotReadyException exception, HttpServletRequest request) {
        String message = exception.getMessage() == null ? "This workspace does not have enough material for that yet" : exception.getMessage();
        return ResponseEntity.status(HttpStatus.CONFLICT).body(error(HttpStatus.CONFLICT, message, request));
    }

    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<ApiError> databaseFailure(DataAccessException exception, HttpServletRequest request) {
        log.error("Database request failed for {}", request.getRequestURI(), exception);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error(HttpStatus.INTERNAL_SERVER_ERROR, "The database request could not be completed", request));
    }

    @ExceptionHandler(AiProviderException.class)
    public ResponseEntity<ApiError> providerFailure(AiProviderException exception, HttpServletRequest request) {
        HttpStatus status = exception.retryable() ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY;
        log.error("{} provider request failed for {} (upstreamStatus={}, retryable={})", exception.provider(), request.getRequestURI(), exception.statusCode(), exception.retryable(), exception);
        String message = exception.retryable()
                ? "The AI provider is temporarily unavailable. Retry the request shortly."
                : "The AI provider rejected the request. Check the configured model and credentials.";
        ResponseEntity.BodyBuilder response = ResponseEntity.status(status);
        if (exception.retryable()) response.header(HttpHeaders.RETRY_AFTER, "2");
        return response.body(error(status, message, request));
    }

    /**
     * The turn ran out of its time budget. Reported as unavailable rather than as a server error, because the
     * request is well-formed and retrying it is the correct next step.
     */
    @ExceptionHandler(com.studyos.ai.DeadlineExceededException.class)
    public ResponseEntity<ApiError> deadlineExceeded(com.studyos.ai.DeadlineExceededException exception, HttpServletRequest request) {
        log.warn("Request exceeded its time budget for {} at stage {}", request.getRequestURI(), exception.stage());
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).header(HttpHeaders.RETRY_AFTER, "5")
                .body(error(HttpStatus.SERVICE_UNAVAILABLE, "This request took longer than its time budget allows. Retry it, or ask for fewer items.", request));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> unexpected(Exception exception, HttpServletRequest request) {
        log.error("Unhandled request failure for {}", request.getRequestURI(), exception);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error(HttpStatus.INTERNAL_SERVER_ERROR, "The request could not be completed", request));
    }

    private ApiError error(HttpStatus status, String message, HttpServletRequest request) { AiProviderCounters counters=AiProviderCounters.current(); return new ApiError(Instant.now(), status.value(), status.getReasonPhrase(), message, request.getRequestURI(), counters.upstreamCalls(), counters.upstreamAttempts(), counters.retries(), counters.transientFailures(), counters.transientDetail()); }
    public record ApiError(Instant timestamp,int status,String error,String message,String path,int upstreamCalls,int upstreamAttempts,int retries,int transientFailures,String transientDetail) {}
    /** Failing turns never return a reply body, so the upstream counters have to travel with the error. */
    private record AiProviderCounters(int upstreamCalls,int upstreamAttempts,int retries,int transientFailures,String transientDetail) {
        static AiProviderCounters current() { var snapshot=com.studyos.ai.ProviderCallTelemetry.snapshot(); return new AiProviderCounters(snapshot.upstreamCalls(),snapshot.upstreamAttempts(),snapshot.retries(),snapshot.transientFailures(),snapshot.transientDetail()); }
    }
}
