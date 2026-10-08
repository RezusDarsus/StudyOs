package com.studyos.mastery;

/** Pure Bayesian-style mastery/evidence update. */
public final class BetaEvidenceModel {
    private BetaEvidenceModel() {}

    public static Result update(State current, double score, double difficulty) { return update(current, score, difficulty, 1); }

    /**
     * @param evidenceWeight how much this attempt should count, e.g. discounted when the student
     *                       needed hints or a revealed solution, raised for higher-stakes activities
     */
    public static Result update(State current, double score, double difficulty, double evidenceWeight) {
        double boundedScore = clamp(score);
        double weight = weight(difficulty, evidenceWeight);
        double alpha = current.alpha() + boundedScore * weight;
        double beta = current.beta() + (1 - boundedScore) * weight;
        int evidence = current.evidenceCount() + 1;
        double mastery = alpha / (alpha + beta);
        double confidence = (double) evidence / (evidence + 8);
        return new Result(alpha, beta, evidence, boundedScore, weight, mastery, confidence, mastery >= .8 ? 14 : mastery >= .6 ? 5 : 1);
    }

    /** Harder work counts for more; heavily supported work counts for less. Bounded either way. */
    public static double weight(double difficulty, double evidenceWeight) {
        double byDifficulty = .5 + 1.5 * difficulty;
        double scaled = byDifficulty * Math.max(.1, Math.min(1.5, evidenceWeight));
        return Math.max(.5, Math.min(2, scaled));
    }

    public static double clamp(double value) { return Math.max(0, Math.min(1, value)); }
    public record State(double alpha, double beta, int evidenceCount) {}
    public record Result(double alpha, double beta, int evidenceCount, double boundedScore, double weight,
                         double mastery, double confidence, int reviewDays) {}
}
