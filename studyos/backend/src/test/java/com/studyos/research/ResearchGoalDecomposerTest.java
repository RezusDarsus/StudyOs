package com.studyos.research;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

class ResearchGoalDecomposerTest {
    private static final ResearchQueryPlanner PLANNER = new ResearchQueryPlanner();

    private static ResearchGoalDecomposer.ResearchNeed need(String name, double importance, String... queries) {
        return new ResearchGoalDecomposer.ResearchNeed(name, importance, "reason", List.of(queries));
    }

    @Test
    void deterministicNeedsAnchorThePlanWithoutAI() {
        List<ResearchGoalDecomposer.ResearchNeed> needs = ResearchGoalDecomposer.deterministicNeeds(PLANNER, "Learn Spring Boot");
        assertThat(needs).hasSize(1);
        assertThat(needs.get(0).name()).isEqualTo("spring boot");
        assertThat(needs.get(0).researchQueries()).contains("spring boot official documentation");
        var merged = ResearchGoalDecomposer.merge("Learn Spring Boot", needs, List.of(), List.of());
        assertThat(merged.llmUsed()).isFalse();
        assertThat(merged.needs().get(0).researchQueries().size()).isLessThanOrEqualTo(ResearchGoalDecomposer.MAX_QUERIES_PER_NEED);
    }

    @Test
    void deterministicNeedsForBlankGoalAreEmpty() {
        assertThat(ResearchGoalDecomposer.deterministicNeeds(PLANNER, "  ")).isEmpty();
        assertThat(ResearchGoalDecomposer.deterministicNeeds(PLANNER, null)).isEmpty();
    }

    @Test
    void llmNeedsAreValidatedDedupedAndCapped() {
        List<ResearchGoalDecomposer.ResearchNeed> llm = List.of(
                need("Spring Security", 0.85, "spring security authentication documentation", "spring security method security"),
                need("spring  security", 0.7, "duplicate name query"),
                need("JPA", 0.6, "https://docs.spring.io/spring-data/jpa/", "jpa entity mapping"),
                need("x", 0.9, "tiny name"),
                need("Transactions", 1.4, "spring transactions guide", "spring transactions propagation", "spring transactions rollback", "spring transactions isolation"));
        var decomposition = ResearchGoalDecomposer.merge("Learn Spring Boot", ResearchGoalDecomposer.deterministicNeeds(PLANNER, "Learn Spring Boot"), llm, List.of());
        assertThat(decomposition.llmUsed()).isTrue();
        var names = decomposition.needs().stream().map(ResearchGoalDecomposer.ResearchNeed::name).toList();
        assertThat(names).contains("Spring Security", "JPA", "Transactions");
        // duplicate name collapsed
        assertThat(names).allMatch(name -> !name.equals("spring  security"));
        // URL query rejected, valid one kept
        var jpa = decomposition.needs().stream().filter(n -> n.name().equals("JPA")).findFirst().orElseThrow();
        assertThat(jpa.researchQueries()).containsExactly("jpa entity mapping");
        // query cap per need enforced
        var transactions = decomposition.needs().stream().filter(n -> n.name().equals("Transactions")).findFirst().orElseThrow();
        assertThat(transactions.researchQueries().size()).isLessThanOrEqualTo(ResearchGoalDecomposer.MAX_QUERIES_PER_NEED);
        // importance clamped
        assertThat(transactions.importance()).isEqualTo(1.0);
        assertThat(decomposition.issues()).isNotEmpty();
    }

    @Test
    void uncoveredNeedsRankAboveCoveredOnes() {
        List<ResearchGoalDecomposer.ResearchNeed> needs = List.of(
                need("REST controllers", 0.9, "rest controllers guide"),
                need("Spring Security", 0.8, "spring security docs"));
        List<ResearchGoalDecomposer.TopicCoverage> coverage = List.of(
                new ResearchGoalDecomposer.TopicCoverage("REST controllers", 5),
                new ResearchGoalDecomposer.TopicCoverage("Spring Security", 0));
        List<ResearchGoalDecomposer.ResearchNeed> ordered = ResearchGoalDecomposer.gapPrioritize(needs, coverage);
        assertThat(ordered.get(0).name()).isEqualTo("Spring Security");
    }

    @Test
    void totalQueryBudgetIsCapped() {
        List<ResearchGoalDecomposer.ResearchNeed> llm = new java.util.ArrayList<>();
        for (int index = 0; index < 20; index++) {
            llm.add(need("Topic " + index, 0.5, "topic " + index + " documentation", "topic " + index + " examples"));
        }
        var decomposition = ResearchGoalDecomposer.merge("goal", ResearchGoalDecomposer.deterministicNeeds(PLANNER, "goal"), llm, List.of());
        int totalQueries = decomposition.needs().stream().mapToInt(need -> need.researchQueries().size()).sum();
        assertThat(totalQueries).isLessThanOrEqualTo(ResearchGoalDecomposer.MAX_QUERIES_TOTAL);
        assertThat(decomposition.needs().size()).isLessThanOrEqualTo(ResearchGoalDecomposer.MAX_NEEDS + 1); // + deterministic backbone
    }

    @Test
    void queriesThatAreUrlsOrUnsafeAreRejected() {
        assertThat(ResearchGoalDecomposer.queryVerdict("https://docs.spring.io", java.util.Set.of())).isNotNull();
        assertThat(ResearchGoalDecomposer.queryVerdict("www.spring.io reference", java.util.Set.of())).isNotNull();
        assertThat(ResearchGoalDecomposer.queryVerdict("file:///etc/passwd", java.util.Set.of())).isNotNull();
        assertThat(ResearchGoalDecomposer.queryVerdict("short", java.util.Set.of())).isNotNull();
        assertThat(ResearchGoalDecomposer.queryVerdict("spring security authentication guide", java.util.Set.of())).isNull();
        assertThat(ResearchGoalDecomposer.queryVerdict("spring security authentication guide", java.util.Set.of("spring security authentication guide"))).isNotNull();
    }

    @Test
    void decomposerServiceDegradesGracefullyWithoutAI() {
        // A stub gateway that throws means no LLM decomposition; the deterministic plan must survive.
        var decomposer = new ResearchGoalDecomposer(stubGateway(), Mockito.mock(com.studyos.ai.GenerationPolicyRegistry.class),
                Mockito.mock(com.studyos.ai.AiUsageService.class), Mockito.mock(org.springframework.jdbc.core.JdbcTemplate.class), PLANNER);
        Mockito.when(stubGateway().generateStructuredResult(Mockito.anyString(), Mockito.anyString(), Mockito.any(), Mockito.any()))
                .thenThrow(new UnsupportedOperationException("no AI configured"));
        var decomposition = decomposer.decompose(null, "Learn Spring Boot");
        assertThat(decomposition.llmUsed()).isFalse();
        assertThat(decomposition.needs()).isNotEmpty();
        assertThat(decomposition.needs().get(0).name()).isEqualTo("spring boot");
    }

    private com.studyos.ai.AiGateway stubGateway() {
        return Mockito.mock(com.studyos.ai.AiGateway.class);
    }
}
