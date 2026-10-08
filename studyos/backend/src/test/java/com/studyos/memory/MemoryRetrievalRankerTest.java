package com.studyos.memory;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import org.junit.jupiter.api.Test;

class MemoryRetrievalRankerTest {
    @Test void oldRelevantMemoryOutranksIrrelevantRecentMemory() {
        double oldRelevant = MemoryRetrievalRanker.score(.95, .8, .1);
        double recentIrrelevant = MemoryRetrievalRanker.score(.05, .1, 1);
        assertThat(oldRelevant).isGreaterThan(recentIrrelevant);
    }

    @Test void clampsUntrustedRankInputs() {
        assertThat(MemoryRetrievalRanker.score(2, -1, 1)).isCloseTo(.8, within(.0000001));
    }
}
