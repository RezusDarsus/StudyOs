package com.studyos.adaptive;

/** What the difficulty ladder decided to do after an attempt. */
public enum LadderAction {
    /** Move up one cognitive level: the topic is held securely enough. */
    PROMOTE,
    /** Stay at the same level and keep gathering evidence. */
    HOLD,
    /** Step down one level after repeated failure below the diagnostic floor. */
    DEMOTE,
    /** Repeated failure at an applied level: probe lower to find what is actually missing. */
    DIAGNOSE,
    /** The diagnostic failed too: teach the weakest prerequisite before returning. */
    REMEDIATE_PREREQUISITE,
    /** The diagnostic passed: go back to the level that was failing. */
    RESUME_AFTER_DIAGNOSTIC
}
