package com.studyos.research;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ResearchCoverageCoreTest {

    @Test
    void oneSourceIsNeverStrongWhateverTheQuality() {
        double single = ResearchCoverageCore.support(1, 1.0, 40, 1.0);
        assertThat(single).isLessThan(ResearchCoverageCore.STRONG);
        assertThat(ResearchCoverageCore.level(single)).isEqualTo(ResearchCoverageCore.Level.MODERATE);
    }

    @Test
    void independentSourcesBeatRepetitionFromOnePage() {
        double independent = ResearchCoverageCore.support(4, 0.6, 8, 0.5);
        double repeated = ResearchCoverageCore.support(1, 0.6, 40, 0.5);
        assertThat(independent).isGreaterThan(repeated);
    }

    @Test
    void noEvidenceIsNoneAndNeverNegative() {
        double empty = ResearchCoverageCore.support(0, 0, 0, 0);
        assertThat(empty).isEqualTo(0);
        assertThat(ResearchCoverageCore.level(empty)).isEqualTo(ResearchCoverageCore.Level.NONE);
        assertThat(ResearchCoverageCore.support(3, -5, 2, Double.NaN)).isBetween(0.0, 1.0);
    }

    @Test
    void theCanonicalWeakCaseIsAWeakOrNoneLevel() {
        // One generic article, no objectives supported.
        double thin = ResearchCoverageCore.support(1, 0.3, 2, 0.0);
        assertThat(ResearchCoverageCore.level(thin)).isIn(ResearchCoverageCore.Level.NONE, ResearchCoverageCore.Level.WEAK);
    }

    @Test
    void theCanonicalStrongCaseIsStrong() {
        // Official reference + guide, deep chunks, objectives supported.
        double strong = ResearchCoverageCore.support(4, 0.9, 20, 0.9);
        assertThat(ResearchCoverageCore.level(strong)).isEqualTo(ResearchCoverageCore.Level.STRONG);
    }

    @Test
    void gapsNeedBothImportanceAndThinSupport() {
        assertThat(ResearchCoverageCore.isResearchGap(0.9, 0.2)).isTrue();
        assertThat(ResearchCoverageCore.isResearchGap(0.9, 0.8)).isFalse(); // well covered: not a gap
        assertThat(ResearchCoverageCore.isResearchGap(0.3, 0.1)).isFalse(); // unimportant: not a candidate
        assertThat(ResearchCoverageCore.isResearchGap(Double.NaN, 0.2)).isFalse();
    }
}
