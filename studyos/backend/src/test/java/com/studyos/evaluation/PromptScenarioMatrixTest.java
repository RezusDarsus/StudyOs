package com.studyos.evaluation;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.chat.QueryIntent;
import com.studyos.chat.QueryRouter;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class PromptScenarioMatrixTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final QueryRouter router = new QueryRouter();

    @Test
    void validatesThirtyPlusRepresentativeLearnerPromptsAndTracksKnownGaps() throws Exception {
        List<Scenario> scenarios;
        try (InputStream input = getClass().getResourceAsStream("/evaluation/phase3-prompt-scenarios.json")) {
            assertThat(input).as("prompt scenario resource").isNotNull();
            scenarios = mapper.readValue(input, new TypeReference<>() {});
        }

        List<String> unexpected = new ArrayList<>();
        List<String> confirmedKnownGaps = new ArrayList<>();
        for (Scenario scenario : scenarios) {
            QueryIntent actual = router.classify(scenario.prompt(), scenario.context());
            if (actual.name().equals(scenario.expectedIntent())) continue;
            String mismatch = scenario.id() + ": expected " + scenario.expectedIntent() + " but routed " + actual;
            if (scenario.knownGap()) confirmedKnownGaps.add(mismatch); else unexpected.add(mismatch);
        }

        assertThat(scenarios).hasSizeGreaterThanOrEqualTo(30);
        assertThat(unexpected).as("unexpected prompt-routing regressions").isEmpty();
        assertThat(confirmedKnownGaps).as("every prompt in the matrix now routes correctly — new gaps must be fixed, not tolerated").isEmpty();
        System.out.println("PROMPT_MATRIX total=" + scenarios.size() + " matched=" + (scenarios.size() - confirmedKnownGaps.size()) + " knownGaps=" + confirmedKnownGaps.size());
        confirmedKnownGaps.forEach(gap -> System.out.println("PROMPT_KNOWN_GAP " + gap));
    }

    record Scenario(String id, String category, String prompt, String context, String expectedIntent,
                    boolean knownGap, String expectedBehavior) {}
}
