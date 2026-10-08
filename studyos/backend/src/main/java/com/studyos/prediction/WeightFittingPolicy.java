package com.studyos.prediction;

/**
 * The data-requirement policy for touching model weights. Written down as code so the thresholds
 * are a decision, not a mood: below five historical exams no fitting happens at all, five to nine
 * exams allow diagnostics only, ten or more permit limited calibration, and twenty or more make
 * fitted weights defensible. Any weight that clears the policy still has to win its held-out
 * backtest before a new model version is registered.
 */
public final class WeightFittingPolicy {

    private WeightFittingPolicy() {}

    public enum Permission { NO_FITTING, DIAGNOSTIC_ONLY, LIMITED_CALIBRATION, RELIABLE_FITTING }

    public static final int MINIMUM_FOR_DIAGNOSTICS = 5;
    public static final int MINIMUM_FOR_LIMITED_CALIBRATION = 10;
    public static final int MINIMUM_FOR_RELIABLE_FITTING = 20;

    public static Permission permissionFor(int historicalExams) {
        if (historicalExams >= MINIMUM_FOR_RELIABLE_FITTING) return Permission.RELIABLE_FITTING;
        if (historicalExams >= MINIMUM_FOR_LIMITED_CALIBRATION) return Permission.LIMITED_CALIBRATION;
        if (historicalExams >= MINIMUM_FOR_DIAGNOSTICS) return Permission.DIAGNOSTIC_ONLY;
        return Permission.NO_FITTING;
    }

    public static String rationale(int historicalExams) {
        return switch (permissionFor(historicalExams)) {
            case NO_FITTING -> historicalExams + " exam(s): no fitting. Fewer than " + MINIMUM_FOR_DIAGNOSTICS
                    + " folds cannot distinguish signal from noise, so EXAM_TOPIC_V1 stays exactly as it is.";
            case DIAGNOSTIC_ONLY -> historicalExams + " exams: diagnostics only. Sensitivity analysis may be read, but any weight change would fit the noise.";
            case LIMITED_CALIBRATION -> historicalExams + " exams: limited calibration possible. Single-coefficient adjustments may be tested on held-out folds.";
            case RELIABLE_FITTING -> historicalExams + " exams: reliable fitting possible, subject to winning its held-out backtest.";
        };
    }
}
