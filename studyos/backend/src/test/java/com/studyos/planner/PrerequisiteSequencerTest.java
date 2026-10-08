package com.studyos.planner;

import static org.assertj.core.api.Assertions.assertThat;
import java.util.*;
import org.junit.jupiter.api.Test;

class PrerequisiteSequencerTest {
    private static final PrerequisiteSequencer.Settings SETTINGS = new PrerequisiteSequencer.Settings(.6, 3, 3, 8, 15);
    private static final java.util.function.ToIntFunction<PrerequisiteSequencer.Node<String>> THIRTY = ignored -> 30;

    @Test void emitsWeakPrerequisiteBeforeDependentTopic() {
        var selected = PrerequisiteSequencer.sequence(List.of(new PrerequisiteSequencer.Node<>("target", .2), new PrerequisiteSequencer.Node<>("base", .2)), Map.of("target", List.of("base")), 60, SETTINGS, THIRTY);
        assertThat(selected).extracting(value -> value.node().id()).containsExactly("base", "target");
        assertThat(selected.getFirst().injectedPrerequisite()).isTrue();
    }

    @Test void schedulesPrerequisiteAndDefersDependentWhenBudgetDoesNotFit() {
        var selected = PrerequisiteSequencer.sequence(List.of(new PrerequisiteSequencer.Node<>("target", .2), new PrerequisiteSequencer.Node<>("base", .2)), Map.of("target", List.of("base")), 45, SETTINGS, THIRTY);
        assertThat(selected).extracting(value -> value.node().id()).containsExactly("base");
    }

    @Test void deduplicatesSharedPrerequisiteTask() {
        var selected = PrerequisiteSequencer.sequence(List.of(new PrerequisiteSequencer.Node<>("first", .2), new PrerequisiteSequencer.Node<>("second", .2), new PrerequisiteSequencer.Node<>("base", .2)), Map.of("first", List.of("base"), "second", List.of("base")), 90, SETTINGS, THIRTY);
        assertThat(selected).extracting(value -> value.node().id()).containsExactly("base", "first", "second");
    }

    @Test void respectsMaximumInjectedPrerequisites() {
        var settings = new PrerequisiteSequencer.Settings(.6, 3, 1, 8, 15);
        var selected = PrerequisiteSequencer.sequence(List.of(new PrerequisiteSequencer.Node<>("target", .2), new PrerequisiteSequencer.Node<>("middle", .2), new PrerequisiteSequencer.Node<>("base", .2)), Map.of("target", List.of("middle"), "middle", List.of("base")), 90, settings, THIRTY);
        assertThat(selected).extracting(value -> value.node().id()).containsExactly("base");
        assertThat(selected).extracting(value -> value.node().id()).doesNotContain("middle", "target");
    }
}
