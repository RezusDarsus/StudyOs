package com.studyos.assessment;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

/**
 * The activity kind is what separates "I practised this with hints" from "I did this alone under exam
 * conditions". Both facts end up in the same mastery record, so if the evidence multipliers or the
 * support rules blur, guided practice starts reading as proof the student can work unaided.
 */
class ActivityKindTest {

    @Test void hintsAreOnlyAvailableWhereTheyBelong() {
        assertThat(ActivityKind.PRACTICE.supportAllowed()).isTrue();
        assertThat(ActivityKind.GUIDED_PRACTICE.supportAllowed()).isTrue();
        assertThat(ActivityKind.INDEPENDENT_EXERCISE.supportAllowed()).isTrue();
        assertThat(ActivityKind.QUIZ.supportAllowed()).isFalse();
        assertThat(ActivityKind.CHECKPOINT.supportAllowed()).isFalse();
        assertThat(ActivityKind.MOCK_EXAM.supportAllowed()).isFalse();
        assertThat(ActivityKind.FINAL_ASSESSMENT.supportAllowed()).isFalse();
    }

    @Test void guidedPracticeIsTheOnlyKindThatOpensWithASupportRungAlreadyShown() {
        for (ActivityKind kind : ActivityKind.values())
            assertThat(kind.openingSupportLevel()).as(kind.name()).isEqualTo(kind == ActivityKind.GUIDED_PRACTICE ? 1 : 0);
    }

    @Test void anythingOpeningWithSupportMustAllowSupport() {
        for (ActivityKind kind : ActivityKind.values())
            if (kind.openingSupportLevel() > 0) assertThat(kind.supportAllowed()).as(kind.name()).isTrue();
    }

    @Test void unaidedWorkCountsForMoreThanGuidedWork() {
        assertThat(ActivityKind.GUIDED_PRACTICE.evidenceMultiplier()).isLessThan(ActivityKind.PRACTICE.evidenceMultiplier());
        assertThat(ActivityKind.PRACTICE.evidenceMultiplier()).isLessThan(ActivityKind.QUIZ.evidenceMultiplier());
        assertThat(ActivityKind.QUIZ.evidenceMultiplier()).isLessThan(ActivityKind.CHECKPOINT.evidenceMultiplier());
        assertThat(ActivityKind.CHECKPOINT.evidenceMultiplier()).isLessThan(ActivityKind.MOCK_EXAM.evidenceMultiplier());
        assertThat(ActivityKind.MOCK_EXAM.evidenceMultiplier()).isLessThan(ActivityKind.FINAL_ASSESSMENT.evidenceMultiplier());
    }

    @Test void everyKindThatForbidsHintsIsTreatedAsHighStakes() {
        for (ActivityKind kind : ActivityKind.values())
            assertThat(kind.highStakes()).as(kind.name()).isEqualTo(!kind.supportAllowed());
    }

    @Test void storedAndUserSuppliedNamesAreParsedTolerantly() {
        assertThat(ActivityKind.of("CHECKPOINT")).isEqualTo(ActivityKind.CHECKPOINT);
        assertThat(ActivityKind.of("guided practice")).isEqualTo(ActivityKind.GUIDED_PRACTICE);
        assertThat(ActivityKind.of("guided-practice")).isEqualTo(ActivityKind.GUIDED_PRACTICE);
        assertThat(ActivityKind.of("  Mock_Exam  ")).isEqualTo(ActivityKind.MOCK_EXAM);
    }

    @Test void anUnknownNameFallsBackWithoutThrowing() {
        assertThat(ActivityKind.of(null)).isEqualTo(ActivityKind.PRACTICE);
        assertThat(ActivityKind.of("")).isEqualTo(ActivityKind.PRACTICE);
        assertThat(ActivityKind.of("oral defence")).isEqualTo(ActivityKind.PRACTICE);
        assertThat(ActivityKind.of("oral defence", ActivityKind.CHECKPOINT)).isEqualTo(ActivityKind.CHECKPOINT);
        assertThat(ActivityKind.of(null, ActivityKind.MOCK_EXAM)).isEqualTo(ActivityKind.MOCK_EXAM);
    }

    @Test void everyKindIsLabelledForTheStudent() {
        for (ActivityKind kind : ActivityKind.values()) {
            assertThat(kind.label()).as(kind.name()).isNotBlank();
            assertThat(ActivityKind.of(kind.name())).isEqualTo(kind);
            assertThat(ActivityKind.of(kind.label())).as("round trip through the label of %s", kind.name()).isEqualTo(kind);
        }
    }
}
