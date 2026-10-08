package com.studyos.learner;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.learner.LearnerStateService.TopicState;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class LearnerStatePartitionTest {
    private static final Timestamp ASSESSED = Timestamp.from(Instant.parse("2026-08-01T00:00:00Z"));

    private static TopicState topic(String name, double mastery, int evidenceCount, Timestamp lastAssessedAt) {
        return new TopicState(UUID.randomUUID(), name, mastery, .5, 1, lastAssessedAt, evidenceCount, null, null);
    }

    /**
     * The measured failure this partition exists for. A topic with no recorded attempt reads as mastery zero
     * because the query coalesces an absent row to zero, and reporting it as the learner's weakest area states
     * a measurement nobody took.
     */
    @Test void aTopicWithNoRecordedAttemptIsNeitherStrongNorWeak() {
        List<TopicState> topics = List.of(topic("Never tested", 0, 0, null), topic("Tested and failing", .1, 3, ASSESSED));
        assertThat(LearnerStateService.weaknesses(topics)).extracting(TopicState::topic).containsExactly("Tested and failing");
        assertThat(LearnerStateService.strengths(topics)).isEmpty();
        assertThat(LearnerStateService.unassessed(topics)).extracting(TopicState::topic).containsExactly("Never tested");
    }

    /** An attempt recorded without a surviving count still counts as evidence that the topic was assessed. */
    @Test void eitherRecordOfAnAttemptCountsAsAssessed() {
        assertThat(topic("Counted", .2, 1, null).assessed()).isTrue();
        assertThat(topic("Stamped", .2, 0, ASSESSED).assessed()).isTrue();
        assertThat(topic("Neither", .2, 0, null).assessed()).isFalse();
    }

    @Test void weaknessesAreOrderedWorstFirstAndStrengthsNeedRealMastery() {
        List<TopicState> topics = List.of(topic("Middling", .55, 2, ASSESSED), topic("Worst", .1, 2, ASSESSED),
                topic("Borderline strong", .75, 2, ASSESSED), topic("Not quite strong", .74, 2, ASSESSED));
        assertThat(LearnerStateService.weaknesses(topics)).extracting(TopicState::topic).containsExactly("Worst", "Middling");
        assertThat(LearnerStateService.strengths(topics)).extracting(TopicState::topic).containsExactly("Borderline strong");
    }

    /** Nothing in the middle band is reported as either, and nothing is reported twice. */
    @Test void theBandBetweenWeakAndStrongIsClaimedByNeitherList() {
        List<TopicState> topics = List.of(topic("Middle", .68, 4, ASSESSED));
        assertThat(LearnerStateService.weaknesses(topics)).isEmpty();
        assertThat(LearnerStateService.strengths(topics)).isEmpty();
        assertThat(LearnerStateService.unassessed(topics)).isEmpty();
    }

    @Test void everyListIsBoundedSoTheStateStaysReadable() {
        List<TopicState> many = java.util.stream.IntStream.range(0, 40)
                .mapToObj(index -> topic("Weak " + index, .01 * index, 1, ASSESSED)).toList();
        assertThat(LearnerStateService.weaknesses(many)).hasSize(8);
        List<TopicState> untested = java.util.stream.IntStream.range(0, 40)
                .mapToObj(index -> topic("Untested " + index, 0, 0, null)).toList();
        assertThat(LearnerStateService.unassessed(untested)).hasSize(12);
    }
}
