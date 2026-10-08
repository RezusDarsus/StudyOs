package com.studyos.planner;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

class TimeAllocatorTest {
    @Test void allocatesLearningAndReviewDurations() {
        assertThat(TimeAllocator.minutesFor("LEARN")).isEqualTo(30);
        assertThat(TimeAllocator.minutesFor("REVIEW")).isEqualTo(20);
    }

    @Test void allocatesExamAndDefaultDurations() {
        assertThat(TimeAllocator.minutesFor("EXAM_STYLE_TEST")).isEqualTo(30);
        assertThat(TimeAllocator.minutesFor("PRACTICE")).isEqualTo(25);
        assertThat(TimeAllocator.minutesFor("QUIZ")).isEqualTo(15);
    }
}
