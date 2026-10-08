package com.studyos.adaptive;

/**
 * The six cognitive demand levels StudyOS schedules against. Each level owns a difficulty band so
 * the existing 0..1 difficulty contract used by generation, grading and mastery stays unchanged.
 */
public enum CognitiveLevel {
    L1_RECALL(1, "Recall", "State the definition, rule, or fact from memory.", .15, .28),
    L2_UNDERSTAND(2, "Understand", "Explain the idea in your own words and say why it holds.", .28, .42),
    L3_APPLY(3, "Apply", "Use the rule on a straightforward new case.", .42, .58),
    L4_ANALYZE(4, "Analyze", "Break a case apart, compare options, and justify the choice.", .58, .72),
    L5_COMBINE(5, "Combine concepts", "Solve a problem that needs several concepts together.", .72, .86),
    L6_NOVEL(6, "Novel / exam level", "Solve an unfamiliar problem of the kind an examiner would set.", .86, 1.0);

    private final int rank;
    private final String label;
    private final String demand;
    private final double lowerDifficulty;
    private final double upperDifficulty;

    CognitiveLevel(int rank, String label, String demand, double lowerDifficulty, double upperDifficulty) {
        this.rank = rank;
        this.label = label;
        this.demand = demand;
        this.lowerDifficulty = lowerDifficulty;
        this.upperDifficulty = upperDifficulty;
    }

    public int rank() { return rank; }
    public String label() { return label; }
    public String demand() { return demand; }
    public double lowerDifficulty() { return lowerDifficulty; }
    public double upperDifficulty() { return upperDifficulty; }
    public double difficulty() { return (lowerDifficulty + upperDifficulty) / 2; }

    public static CognitiveLevel lowest() { return L1_RECALL; }
    public static CognitiveLevel highest() { return L6_NOVEL; }

    public static CognitiveLevel ofRank(int rank) {
        int bounded = Math.max(L1_RECALL.rank, Math.min(L6_NOVEL.rank, rank));
        for (CognitiveLevel level : values()) if (level.rank == bounded) return level;
        return L1_RECALL;
    }

    /** Closest level for a legacy 0..1 difficulty so existing rows keep a meaningful level. */
    public static CognitiveLevel ofDifficulty(double difficulty) {
        double bounded = Math.max(0, Math.min(1, difficulty));
        CognitiveLevel closest = L1_RECALL;
        double bestDistance = Double.MAX_VALUE;
        for (CognitiveLevel level : values()) {
            double distance = bounded < level.lowerDifficulty ? level.lowerDifficulty - bounded
                    : bounded > level.upperDifficulty ? bounded - level.upperDifficulty : 0;
            if (distance < bestDistance) { bestDistance = distance; closest = level; }
        }
        return closest;
    }

    public CognitiveLevel up() { return ofRank(rank + 1); }
    public CognitiveLevel down() { return ofRank(rank - 1); }
    public CognitiveLevel shift(int steps) { return ofRank(rank + steps); }

    /** Difficulty inside this level's band, nudged by how securely the topic is currently held. */
    public double difficultyFor(double effectiveMastery) {
        double bounded = Math.max(0, Math.min(1, effectiveMastery));
        return lowerDifficulty + (upperDifficulty - lowerDifficulty) * bounded;
    }
}
