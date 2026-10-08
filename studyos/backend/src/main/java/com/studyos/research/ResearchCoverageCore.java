package com.studyos.research;

/**
 * Pure arithmetic for per-topic research support: how well the workspace's sources actually back a
 * topic. This is deliberately NOT a truth probability — a high score means "well evidenced by the
 * collected material", never "verified true". Names in the API say support and coverage for
 * exactly that reason.
 */
public final class ResearchCoverageCore {

    public static final double STRONG = 0.70;
    public static final double MODERATE = 0.45;
    public static final double WEAK = 0.15;

    /** Importance at or above which an unsupported topic becomes a research candidate. */
    public static final double GAP_IMPORTANCE = 0.60;
    /** Support below which a sufficiently important topic becomes a research candidate. */
    public static final double GAP_SUPPORT = 0.45;

    private ResearchCoverageCore() {}

    public enum Level { STRONG, MODERATE, WEAK, NONE }

    /**
     * Evidence-support score from the raw counts. Independent sources (distinct documents/domains)
     * matter most — five paragraphs from one page are one source, not five — then quality, then
     * depth, then how many objectives the material can actually support.
     *
     * @param independentSources distinct documents binding this topic
     * @param meanQuality mean retrieval-quality of the research/document sources, 0..1
     * @param depthChunks bound chunks giving the topic text to learn from
     * @param objectiveCoverage share of the topic's objectives that have any source behind them, 0..1
     */
    public static double support(long independentSources, double meanQuality, long depthChunks, double objectiveCoverage) {
        double breadth = 1 - Math.exp(-Math.max(0, independentSources) / 2.5);
        double depth = 1 - Math.exp(-Math.max(0, depthChunks) / 6.0);
        double quality = clamp01(meanQuality);
        double objectives = clamp01(objectiveCoverage);
        // Depth and quality only count fully once more than one source stands behind them: forty
        // chunks of a single page are one document's word, not independent evidence.
        double effectiveDepth = depth * (0.3 + 0.7 * breadth);
        double effectiveQuality = quality * breadth;
        double raw = .45 * breadth + .20 * effectiveQuality + .20 * effectiveDepth + .15 * objectives;
        return clamp01(raw);
    }

    public static Level level(double support) {
        double value = clamp01(support);
        if (value >= STRONG) return Level.STRONG;
        if (value >= MODERATE) return Level.MODERATE;
        if (value >= WEAK) return Level.WEAK;
        return Level.NONE;
    }

    /**
     * A gap is an important topic with thin support. Importance alone is not a gap — a topic the
     * material covers well is not a candidate no matter how important it is.
     */
    public static boolean isResearchGap(double importance, double support) {
        return clamp01(importance) >= GAP_IMPORTANCE && clamp01(support) < GAP_SUPPORT;
    }

    private static double clamp01(double value) {
        if (Double.isNaN(value)) return 0;
        return Math.max(0, Math.min(1, value));
    }
}
