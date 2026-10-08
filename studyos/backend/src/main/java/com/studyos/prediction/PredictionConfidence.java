package com.studyos.prediction;

/**
 * Evidence-volume confidence for predictions. Probability says how likely a topic is; confidence
 * says how much the evidence behind that probability can be trusted. They are different questions
 * and this class exists so the second is never derived from the first.
 */
public final class PredictionConfidence {

    private PredictionConfidence() {}

    public record Evidence(int historicalExams, int topicObservations, int totalQuestions,
                           int distinctExamYears, double topicConsistency) {}

    /**
     * Confidence label from evidence volume. Deliberately coarse: with two historical exams even a
     * probability of 0.9 is LOW confidence, because the probability itself rests on almost nothing.
     */
    public static String label(int historicalExams, int universeSize) {
        return band(historicalExams).name();
    }

    public static Band band(int historicalExams) {
        if (historicalExams >= 10) return Band.HIGH;
        if (historicalExams >= 3) return Band.MEDIUM;
        return Band.LOW;
    }

    public enum Band { LOW, MEDIUM, HIGH }

    /**
     * Evidence-backed confidence for one topic's prediction, combining the count of historical
     * exams, how often the topic itself was observed, recency of the observations and the
     * consistency of its appearance. Deterministic and explainable: each factor is reported.
     */
    public static Band topicBand(int historicalExams, int topicObservations, int lastSeenAgo, double consistency) {
        if (historicalExams < 3) return Band.LOW;
        int score = 0;
        if (historicalExams >= 5) score += 1;
        if (historicalExams >= 10) score += 1;
        if (topicObservations >= 3) score += 1;
        if (lastSeenAgo <= 2) score += 1;
        if (consistency >= 0.6) score += 1;
        if (score >= 4) return Band.HIGH;
        if (score >= 2) return Band.MEDIUM;
        return Band.LOW;
    }
}
