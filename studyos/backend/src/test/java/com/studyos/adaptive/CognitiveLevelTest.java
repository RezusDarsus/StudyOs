package com.studyos.adaptive;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

/**
 * Levels are the contract between scheduling, generation and grading: the ladder speaks in levels while
 * generation and mastery still speak in 0..1 difficulty. If the bands overlap, tile with gaps, or fail
 * to round-trip, a promotion silently produces an easier question than the level it replaced.
 */
class CognitiveLevelTest {

    @Test void theSixLevelsAreOrderedAndDistinct() {
        CognitiveLevel[] levels = CognitiveLevel.values();
        assertThat(levels).hasSize(6);
        for (int index = 0; index < levels.length; index++) {
            assertThat(levels[index].rank()).isEqualTo(index + 1);
            assertThat(levels[index].label()).isNotBlank();
            assertThat(levels[index].demand()).isNotBlank();
        }
    }

    @Test void theBandsTileTheWholeDifficultyRangeWithoutGaps() {
        CognitiveLevel[] levels = CognitiveLevel.values();
        for (int index = 1; index < levels.length; index++)
            assertThat(levels[index].lowerDifficulty()).as("band start of %s", levels[index])
                    .isEqualTo(levels[index - 1].upperDifficulty());
        assertThat(CognitiveLevel.highest().upperDifficulty()).isEqualTo(1);
        for (CognitiveLevel level : levels) assertThat(level.lowerDifficulty()).isLessThan(level.upperDifficulty());
    }

    @Test void aHarderLevelNeverAsksAnEasierQuestion() {
        CognitiveLevel[] levels = CognitiveLevel.values();
        for (int index = 1; index < levels.length; index++)
            assertThat(levels[index].difficulty()).isGreaterThan(levels[index - 1].difficulty());
    }

    @Test void aRankOutsideTheLadderIsClampedRatherThanThrowing() {
        assertThat(CognitiveLevel.ofRank(0)).isEqualTo(CognitiveLevel.lowest());
        assertThat(CognitiveLevel.ofRank(-7)).isEqualTo(CognitiveLevel.lowest());
        assertThat(CognitiveLevel.ofRank(99)).isEqualTo(CognitiveLevel.highest());
        for (CognitiveLevel level : CognitiveLevel.values()) assertThat(CognitiveLevel.ofRank(level.rank())).isEqualTo(level);
    }

    @Test void steppingPastEitherEndStaysInRange() {
        assertThat(CognitiveLevel.lowest().down()).isEqualTo(CognitiveLevel.lowest());
        assertThat(CognitiveLevel.highest().up()).isEqualTo(CognitiveLevel.highest());
        assertThat(CognitiveLevel.L4_ANALYZE.shift(-2)).isEqualTo(CognitiveLevel.L2_UNDERSTAND);
        assertThat(CognitiveLevel.L4_ANALYZE.shift(2)).isEqualTo(CognitiveLevel.L6_NOVEL);
        assertThat(CognitiveLevel.L2_UNDERSTAND.shift(-9)).isEqualTo(CognitiveLevel.lowest());
    }

    @Test void aLegacyDifficultyRoundTripsToTheLevelThatOwnsIt() {
        for (CognitiveLevel level : CognitiveLevel.values()) {
            assertThat(CognitiveLevel.ofDifficulty(level.difficulty())).as("midpoint of %s", level).isEqualTo(level);
            assertThat(CognitiveLevel.ofDifficulty(level.difficultyFor(.5))).as("banded difficulty of %s", level).isEqualTo(level);
        }
    }

    @Test void difficultiesOutsideEveryBandFallToTheNearestLevel() {
        assertThat(CognitiveLevel.ofDifficulty(0)).isEqualTo(CognitiveLevel.lowest());
        assertThat(CognitiveLevel.ofDifficulty(-3)).isEqualTo(CognitiveLevel.lowest());
        assertThat(CognitiveLevel.ofDifficulty(1)).isEqualTo(CognitiveLevel.highest());
        assertThat(CognitiveLevel.ofDifficulty(42)).isEqualTo(CognitiveLevel.highest());
    }

    @Test void aSecurelyHeldTopicGetsTheHarderEndOfItsOwnBand() {
        CognitiveLevel level = CognitiveLevel.L3_APPLY;
        assertThat(level.difficultyFor(0)).isEqualTo(level.lowerDifficulty());
        assertThat(level.difficultyFor(1)).isEqualTo(level.upperDifficulty());
        assertThat(level.difficultyFor(.8)).isGreaterThan(level.difficultyFor(.2));
    }

    @Test void anOutOfRangeMasteryDoesNotEscapeTheBand() {
        for (CognitiveLevel level : CognitiveLevel.values()) {
            assertThat(level.difficultyFor(-5)).isEqualTo(level.lowerDifficulty());
            assertThat(level.difficultyFor(9)).isEqualTo(level.upperDifficulty());
        }
    }
}
