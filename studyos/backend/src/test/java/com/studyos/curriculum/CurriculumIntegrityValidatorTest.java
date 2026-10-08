package com.studyos.curriculum;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class CurriculumIntegrityValidatorTest {
    private static final UUID T_DI = UUID.randomUUID();
    private static final UUID T_SECURITY = UUID.randomUUID();
    private static final UUID T_BEANS = UUID.randomUUID();
    private static final UUID T_CRYPTO = UUID.randomUUID();

    private CurriculumIntegrityValidator.LessonInput lesson(String title, UUID topicId, int module, int ordinal, int level) {
        return new CurriculumIntegrityValidator.LessonInput(UUID.randomUUID(), topicId, title, module, ordinal, level, 25, "Work with " + title);
    }

    @AfterEach
    void cleanThreadState() {
        // The validator is pure; nothing registers global state any more. Kept as a guard.
    }

    @Test
    void missingTopicIsAnError() {
        var ghost = UUID.randomUUID();
        var report = CurriculumIntegrityValidator.validate(new CurriculumIntegrityValidator.Input(
                List.of(lesson("Ghost lesson", ghost, 0, 0, 3)), List.of(),
                Set.of(T_DI), Map.of(T_DI, 3L), Map.of(), Map.of()));
        assertThat(report.items()).anySatisfy(finding -> {
            assertThat(finding.code()).isEqualTo("MISSING_TOPIC");
            assertThat(finding.severity()).isEqualTo(CurriculumIntegrityValidator.Severity.ERROR);
        });
        assertThat(report.needsRegeneration()).isTrue();
    }

    @Test
    void unsupportedLessonWarnsButDoesNotRegenerate() {
        var report = CurriculumIntegrityValidator.validate(new CurriculumIntegrityValidator.Input(
                List.of(lesson("Dependency injection", T_DI, 0, 0, 3)), List.of(),
                Set.of(T_DI), Map.of(T_DI, 0L), Map.of(), Map.of()));
        assertThat(report.items()).anySatisfy(finding -> {
            assertThat(finding.code()).isEqualTo("UNSUPPORTED_LESSON");
            assertThat(finding.severity()).isEqualTo(CurriculumIntegrityValidator.Severity.WARNING);
        });
        assertThat(report.needsRegeneration()).isFalse();
    }

    @Test
    void duplicateLessonsAreFoundAndRepairable() {
        var first = lesson("Dependency injection", T_DI, 0, 0, 3);
        var second = lesson("dependency  injection", T_DI, 0, 1, 3);
        var report = CurriculumIntegrityValidator.validate(new CurriculumIntegrityValidator.Input(
                List.of(first, second), List.of(), Set.of(T_DI), Map.of(T_DI, 3L), Map.of(), Map.of()));
        assertThat(report.items()).anySatisfy(finding -> {
            assertThat(finding.code()).isEqualTo("DUPLICATE_LESSON");
            assertThat(finding.lessonId()).isEqualTo(second.id());
        });
        assertThat(CurriculumIntegrityValidator.removableDuplicates(report)).containsExactly(second.id());
    }

    @Test
    void prerequisiteOrderingViolationIsAnError() {
        var security = lesson("Spring Security", T_SECURITY, 0, 0, 4);
        var di = lesson("Dependency Injection", T_DI, 0, 1, 3);
        var report = CurriculumIntegrityValidator.validate(new CurriculumIntegrityValidator.Input(
                List.of(security, di), List.of(new CurriculumIntegrityValidator.EdgeInput(security.id(), di.id())),
                Set.of(T_SECURITY, T_DI), Map.of(T_SECURITY, 2L, T_DI, 2L), Map.of(), Map.of()));
        assertThat(report.items()).anySatisfy(finding -> {
            assertThat(finding.code()).isEqualTo("PREREQUISITE_ORDER");
            assertThat(finding.severity()).isEqualTo(CurriculumIntegrityValidator.Severity.ERROR);
        });
    }

    @Test
    void cycleIsDetected() {
        var a = lesson("A", T_BEANS, 0, 0, 3);
        var b = lesson("B", T_SECURITY, 0, 1, 3);
        var report = CurriculumIntegrityValidator.validate(new CurriculumIntegrityValidator.Input(
                List.of(a, b), List.of(new CurriculumIntegrityValidator.EdgeInput(a.id(), b.id()), new CurriculumIntegrityValidator.EdgeInput(b.id(), a.id())),
                Set.of(T_BEANS, T_SECURITY), Map.of(T_BEANS, 2L, T_SECURITY, 2L), Map.of(), Map.of()));
        assertThat(report.items()).anySatisfy(finding -> {
            assertThat(finding.code()).isEqualTo("CYCLE");
            assertThat(finding.severity()).isEqualTo(CurriculumIntegrityValidator.Severity.ERROR);
        });
    }

    @Test
    void highImportanceOmissionWarns() {
        var report = CurriculumIntegrityValidator.validate(new CurriculumIntegrityValidator.Input(
                List.of(lesson("Dependency injection", T_DI, 0, 0, 3)), List.of(),
                Set.of(T_DI, T_SECURITY), Map.of(T_DI, 3L, T_SECURITY, 3L), Map.of(T_SECURITY, 0.9), Map.of()));
        assertThat(report.items()).anySatisfy(finding -> {
            assertThat(finding.code()).isEqualTo("IMPORTANT_TOPIC_OMITTED");
            assertThat(finding.topicId()).isEqualTo(T_SECURITY);
        });
    }

    @Test
    void topicPrerequisiteUncoveredWarns() {
        var report = CurriculumIntegrityValidator.validate(new CurriculumIntegrityValidator.Input(
                List.of(lesson("Spring Security", T_SECURITY, 0, 0, 4)), List.of(),
                Set.of(T_DI, T_SECURITY), Map.of(T_DI, 3L, T_SECURITY, 3L), Map.of(), Map.of(),
                Map.of(T_SECURITY, Set.of(T_DI))));
        assertThat(report.items()).anySatisfy(finding -> {
            assertThat(finding.code()).isEqualTo("TOPIC_PREREQUISITE_UNCOVERED");
            assertThat(finding.severity()).isEqualTo(CurriculumIntegrityValidator.Severity.WARNING);
        });
    }

    @Test
    void difficultyJumpWarns() {
        var basics = lesson("Basic syntax", T_BEANS, 0, 0, 1);
        var recovery = lesson("Distributed transaction recovery", T_CRYPTO, 0, 1, 6);
        var report = CurriculumIntegrityValidator.validate(new CurriculumIntegrityValidator.Input(
                List.of(basics, recovery), List.of(), Set.of(T_BEANS, T_CRYPTO), Map.of(T_BEANS, 3L, T_CRYPTO, 3L), Map.of(),
                Map.of(T_BEANS, 0.1, T_CRYPTO, 0.9)));
        assertThat(report.items()).anySatisfy(finding -> {
            assertThat(finding.code()).isEqualTo("DIFFICULTY_JUMP");
            assertThat(finding.lessonId()).isEqualTo(recovery.id());
        });
    }

    @Test
    void emptyModuleAndMissingObjectiveAreReported() {
        // The single lesson sits in module 1, so module 0 is empty.
        var report = CurriculumIntegrityValidator.validate(new CurriculumIntegrityValidator.Input(
                List.of(new CurriculumIntegrityValidator.LessonInput(UUID.randomUUID(), T_DI, "Dependency injection", 1, 0, 3, 25, null)),
                List.of(), Set.of(T_DI), Map.of(T_DI, 3L), Map.of(), Map.of()));
        assertThat(report.items()).anySatisfy(finding -> assertThat(finding.code()).isEqualTo("MISSING_OBJECTIVE"));
        assertThat(report.items()).anySatisfy(finding -> assertThat(finding.code()).isEqualTo("EMPTY_MODULE"));
    }

    @Test
    void aCleanCurriculumProducesNoFindings() {
        var di = lesson("Dependency injection", T_DI, 0, 0, 3);
        var security = lesson("Spring Security", T_SECURITY, 0, 1, 4);
        var report = CurriculumIntegrityValidator.validate(new CurriculumIntegrityValidator.Input(
                List.of(di, security), List.of(new CurriculumIntegrityValidator.EdgeInput(security.id(), di.id())),
                Set.of(T_DI, T_SECURITY), Map.of(T_DI, 3L, T_SECURITY, 3L), Map.of(T_DI, 0.5, T_SECURITY, 0.8),
                Map.of(T_DI, 0.2, T_SECURITY, 0.4), Map.of(T_SECURITY, Set.of(T_DI))));
        assertThat(report.items()).isEmpty();
        assertThat(report.findings()).isZero();
    }
}
