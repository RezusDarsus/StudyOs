package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

class ModelRoutingFixturesTest {
    private final ModelRoutingFixtures fixtures = new ModelRoutingFixtures();
    /** Stands in for whatever an installation's material happens to cover; nothing here depends on the subject. */
    private final List<String> concepts = IntStream.rangeClosed(1, 25).mapToObj(index -> "course concept " + index).toList();

    @Test void exercisesEveryInternalOperationWithOneFixturePerSuppliedConcept() {
        for (AiOperation operation : ModelRoutingFixtures.internalOperations()) {
            var operationFixtures = fixtures.fixtures(operation, concepts);
            assertThat(operationFixtures).as(operation.name()).hasSize(ModelRoutingFixtures.FIXTURES_PER_OPERATION);
            assertThat(operationFixtures).allSatisfy(fixture -> assertThat(fixture.input()).contains(fixture.requiredConcepts().getFirst()));
        }
    }

    @Test void neverRoutesStudentChatIntoInternalFixtureSet() {
        assertThat(fixtures.fixtures(AiOperation.CHAT, concepts)).isEmpty();
    }

    /** No material means no evidence about the cheaper model, which must read as zero fixtures, not as a pass. */
    @Test void producesNoFixturesWhenTheCorpusOffersNoConcepts() {
        assertThat(fixtures.fixtures(AiOperation.GRADING, List.of())).isEmpty();
        assertThat(fixtures.fixtures(AiOperation.GRADING, null)).isEmpty();
        assertThat(fixtures.fixtures(AiOperation.GRADING, List.of("  ", ""))).isEmpty();
    }

    @Test void countsARepeatedConceptOnce() {
        assertThat(fixtures.fixtures(AiOperation.SUMMARY, List.of("one", "one", " one ", "two"))).hasSize(2);
    }

    @Test void usesAsManyConceptsAsExistWhenTheCorpusIsSmall() {
        assertThat(fixtures.fixtures(AiOperation.MEMORY_EXTRACTION, List.of("a", "b", "c"))).hasSize(3);
    }
}
