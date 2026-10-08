package com.studyos.ai;

/**
 * A turn ran out of its wall-clock budget before it could finish. Distinct from a provider fault: nothing
 * upstream necessarily failed, the answer simply stopped being worth waiting for, so it is reported as a
 * retryable condition and names the stage that was about to start.
 */
public class DeadlineExceededException extends RuntimeException {
    private final String stage;
    public DeadlineExceededException(String stage) {
        super("The request exceeded its time budget before " + stage + " could complete");
        this.stage = stage;
    }
    public String stage() { return stage; }
}
