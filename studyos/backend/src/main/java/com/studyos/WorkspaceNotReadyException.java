package com.studyos;

/**
 * The workspace cannot satisfy this request yet, and the student is the one who can change that —
 * usually by adding source material, stating a goal, or waiting for processing to finish.
 *
 * <p>Deliberately not an {@link IllegalStateException}: that type also covers genuine internal
 * failures whose messages must never reach a client ("Generation request failed", provider response
 * bodies). This one exists so a reason written for the student can travel verbatim to the UI.
 */
public class WorkspaceNotReadyException extends RuntimeException {
    public WorkspaceNotReadyException(String message) { super(message); }
}
