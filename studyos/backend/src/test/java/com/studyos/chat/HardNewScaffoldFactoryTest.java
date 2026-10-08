package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class HardNewScaffoldFactoryTest {
    private static final SemanticAnswerPacket.SourceRef SOURCE =
            new SemanticAnswerPacket.SourceRef("week.pdf", "1-2");

    @Test void transitionModelGetsCompleteReachabilityTaskWithoutPartialRuleRestatement() {
        AcademicSemanticProfile profile = profile(
                List.of("self-sending system"),
                List.of("internal step", "send step", "receive step"),
                List.of("define the transition system"));
        GenerationScope scope = scope(true, List.of(reference("Sending numbers", profile)), List.of());

        var candidate = HardNewScaffoldFactory.create(scope, SOURCE);

        assertThat(candidate.title()).contains("Reachability characterization");
        assertThat(candidate.exercise()).contains("every configuration reachable")
                .contains("prove both directions")
                .contains("every source-defined transition")
                .doesNotContain("fairness")
                .doesNotContain("integers")
                .doesNotContain("increments the number");
    }

    @Test void proceduralMaterialGetsConcreteVerificationCertificateTask() {
        AcademicSemanticProfile profile = profile(
                List.of("checksum"),
                List.of("polynomial division", "appending remainder", "bitwise XOR"),
                List.of("compute transmitted bit string"));
        GenerationScope scope = scope(false, List.of(reference("Checksum", profile)), List.of("Checksum"));

        var candidate = HardNewScaffoldFactory.create(scope, SOURCE);

        assertThat(candidate.title()).contains("Verification certificate");
        assertThat(candidate.exercise()).contains("exact source data")
                .contains("polynomial division")
                .contains("necessary and sufficient")
                .doesNotContain("different polynomial")
                .doesNotContain("1101");
    }

    @Test void twoTopicalReferencesProduceEndToEndSynthesis() {
        AcademicSemanticProfile first = profile(List.of("routing"), List.of("decomposing edges"), List.of("decompose edges"));
        AcademicSemanticProfile second = profile(List.of("recursive routing"), List.of("defining sub-permutations"), List.of("define recursive routing"));
        GenerationScope scope = scope(false, List.of(reference("Routing", first), reference("Recursive routing", second)), List.of("Routing"));

        var candidate = HardNewScaffoldFactory.create(scope, SOURCE);

        assertThat(candidate.title()).contains("End-to-end synthesis");
        assertThat(candidate.exercise()).contains("decompose edges")
                .contains("define recursive routing")
                .contains("both source specifications")
                .contains("exact data already stated in the source");
    }

    private static AcademicSemanticProfile profile(List<String> concepts, List<String> operations, List<String> tasks) {
        return new AcademicSemanticProfile(concepts, List.of(), List.of(), operations, concepts, tasks, List.of());
    }

    private static GenerationScope.ReferenceAssessment reference(String prompt, AcademicSemanticProfile profile) {
        return new GenerationScope.ReferenceAssessment(UUID.randomUUID().toString(), prompt, "HOMEWORK", "week.pdf", 1, 2, profile);
    }

    private static GenerationScope scope(boolean frozen, List<GenerationScope.ReferenceAssessment> references, List<String> topics) {
        return new GenerationScope(UUID.randomUUID(), "Week 1", List.of(1), topics, List.of(UUID.randomUUID()),
                List.of("week.pdf"), 1, "homework 1", frozen, references,
                "authoritative source evidence", List.of(), references.getFirst().semantics(), List.of());
    }
}
