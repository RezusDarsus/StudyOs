package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.assessment.QuizService;
import com.studyos.assessment.SyllabusLlmParser;
import com.studyos.chat.PredictionVerificationBatch;
import com.studyos.curriculum.CurriculumService;
import com.studyos.knowledge.TopicExtractionService;
import com.studyos.research.ResearchGoalDecomposer;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The deterministic structured-reliability benchmark: every provider-shaped fixture in the matrix is
 * pushed through the real normalizer against the real target DTOs on every build, and the run is
 * scored into what the live report tracks — exact compliance, recovered compliance, and honest
 * failures. No AI, no database; this is the structured path's behavioural specification.
 *
 * <p>The exact/recovered split is the honest signal: a 100% usable rate achieved only through repair
 * means the prompts or the provider still need work, so the benchmark asserts the split, not just
 * the total.
 */
class StructuredReliabilityBenchmarkTest {
    private final StructuredOutputNormalizer normalizer = new StructuredOutputNormalizer(new ObjectMapper());

    private enum Outcome { EXACT, RECOVERED, FAILED }

    private record Fixture(String family, String name, String raw, String finishReason, Class<?> type, Outcome expected) {
        Fixture(String family, String name, String raw, Class<?> type, Outcome expected) { this(family, name, raw, "stop", type, expected); }
    }

    private static final List<Fixture> FIXTURES = List.of(
            // quiz generation
            new Fixture("quiz", "exact wrapper", "{\"questions\":[{\"prompt\":\"Q\",\"answer\":\"A\"}]}", QuizService.QuestionBatch.class, Outcome.EXACT),
            new Fixture("quiz", "fenced wrapper", "```json\n{\"questions\":[{\"prompt\":\"Q\",\"answer\":\"A\"}]}\n```", QuizService.QuestionBatch.class, Outcome.RECOVERED),
            new Fixture("quiz", "bare array", "[{\"prompt\":\"Q\",\"answer\":\"A\"}]", QuizService.QuestionBatch.class, Outcome.RECOVERED),
            new Fixture("quiz", "bare single question", "{\"prompt\":\"Q\",\"answer\":\"A\"}", QuizService.QuestionBatch.class, Outcome.RECOVERED),
            new Fixture("quiz", "prose + payload", "Sure:\n{\"questions\":[{\"prompt\":\"Q\",\"answer\":\"A\"}]}", QuizService.QuestionBatch.class, Outcome.RECOVERED),
            new Fixture("quiz", "trailing commas", "{\"questions\":[{\"prompt\":\"Q\",\"answer\":\"A\",},],}", QuizService.QuestionBatch.class, Outcome.RECOVERED),
            new Fixture("quiz", "two payloads", "{\"questions\":[]} {\"questions\":[{\"prompt\":\"Q\",\"answer\":\"A\"}]}", QuizService.QuestionBatch.class, Outcome.FAILED),
            new Fixture("quiz", "unrelated object", "{\"foo\":\"bar\"}", QuizService.QuestionBatch.class, Outcome.FAILED),
            new Fixture("quiz", "truncated", "{\"questions\":[{\"prompt\":\"Q\",\"answer\":\"", "length", QuizService.QuestionBatch.class, Outcome.FAILED),
            // grading: not a single-list wrapper, so no wrapping is ever applied
            new Fixture("grading", "exact wrapper", "{\"score\":0.8,\"feedback\":\"ok\",\"conceptScores\":[],\"mistakes\":[]}", QuizService.GradeResult.class, Outcome.EXACT),
            new Fixture("grading", "bare grade object", "{\"score\":0.8,\"feedback\":\"ok\"}", QuizService.GradeResult.class, Outcome.EXACT),
            new Fixture("grading", "bare array refused", "[{\"score\":1}]", QuizService.GradeResult.class, Outcome.FAILED),
            new Fixture("grading", "semantic type error", "{\"score\":\"high\"}", QuizService.GradeResult.class, Outcome.FAILED),
            // topic extraction
            new Fixture("topics", "exact wrapper", "{\"topics\":[{\"name\":\"T\",\"relevance\":0.9}]}", TopicExtractionService.TopicResponse.class, Outcome.EXACT),
            new Fixture("topics", "bare array", "[{\"name\":\"T\",\"relevance\":0.9}]", TopicExtractionService.TopicResponse.class, Outcome.RECOVERED),
            new Fixture("topics", "single candidate", "{\"name\":\"T\",\"relevance\":0.9}", TopicExtractionService.TopicResponse.class, Outcome.RECOVERED),
            new Fixture("topics", "invalid candidate", "{\"topics\":[{\"relevance\":\"high\"}]}", TopicExtractionService.TopicResponse.class, Outcome.FAILED),
            new Fixture("topics", "truncated", "{\"topics\":[{\"name\":\"T\",\"relevan", "length", TopicExtractionService.TopicResponse.class, Outcome.FAILED),
            // syllabus
            new Fixture("syllabus", "exact wrapper", "{\"units\":[{\"title\":\"W1\"}]}", SyllabusLlmParser.LlmSyllabus.class, Outcome.EXACT),
            new Fixture("syllabus", "fenced", "```json\n{\"units\":[{\"title\":\"W1\"}]}\n```", SyllabusLlmParser.LlmSyllabus.class, Outcome.RECOVERED),
            new Fixture("syllabus", "bare unit object", "{\"title\":\"W1\"}", SyllabusLlmParser.LlmSyllabus.class, Outcome.RECOVERED),
            // curriculum: wrapper-level fields exist, so bare arrays are refused
            new Fixture("curriculum", "exact wrapper", "{\"title\":\"C\",\"summary\":\"S\",\"modules\":[]}", CurriculumService.CurriculumDraft.class, Outcome.EXACT),
            new Fixture("curriculum", "fenced", "```json\n{\"title\":\"C\",\"summary\":\"S\",\"modules\":[]}\n```", CurriculumService.CurriculumDraft.class, Outcome.RECOVERED),
            new Fixture("curriculum", "bare array refused", "[{\"title\":\"M\"}]", CurriculumService.CurriculumDraft.class, Outcome.FAILED),
            // research
            new Fixture("research", "exact wrapper", "{\"needs\":[{\"name\":\"N\",\"importance\":0.5}]}", ResearchGoalDecomposer.LlmNeeds.class, Outcome.EXACT),
            new Fixture("research", "prose + payload", "Result:\n{\"needs\":[{\"name\":\"N\",\"importance\":0.5}]}", ResearchGoalDecomposer.LlmNeeds.class, Outcome.RECOVERED),
            new Fixture("research", "bare array", "[{\"name\":\"N\",\"importance\":0.5}]", ResearchGoalDecomposer.LlmNeeds.class, Outcome.RECOVERED),
            // verification (frozen family: behaviour must hold, gates untouched)
            new Fixture("verification", "exact wrapper", "{\"candidates\":[{\"candidateId\":\"c1\",\"scopeViolation\":false,\"groundingOk\":true,\"wellDefined\":true,\"nearCopy\":false,\"confidence\":0.9}]}", PredictionVerificationBatch.class, Outcome.EXACT),
            new Fixture("verification", "alias key", "{\"verifications\":[{\"candidateId\":\"c1\",\"scopeViolation\":false,\"groundingOk\":true,\"wellDefined\":true,\"nearCopy\":false,\"confidence\":0.9}]}", PredictionVerificationBatch.class, Outcome.EXACT),
            new Fixture("verification", "bare array", "[{\"candidateId\":\"c1\",\"scopeViolation\":false,\"groundingOk\":true,\"wellDefined\":true,\"nearCopy\":false,\"confidence\":0.9}]", PredictionVerificationBatch.class, Outcome.RECOVERED)
    );

    @Test
    void everyFixtureLandsInItsExpectedOutcomeClass() {
        List<String> violations = new ArrayList<>();
        int exact = 0;
        int recovered = 0;
        int failed = 0;
        for (Fixture fixture : FIXTURES) {
            StructuredNormalizationResult result = normalizer.normalize(fixture.raw(), fixture.type(), fixture.finishReason());
            Outcome actual = result.success() ? (result.repaired() ? Outcome.RECOVERED : Outcome.EXACT) : Outcome.FAILED;
            if (actual != fixture.expected()) {
                violations.add(fixture.family() + "/" + fixture.name() + ": expected " + fixture.expected() + " but was " + actual
                        + (result.failure() == null ? "" : " (" + result.failure() + ")"));
            }
            if (actual == Outcome.EXACT) exact++;
            if (actual == Outcome.RECOVERED) recovered++;
            if (actual == Outcome.FAILED) failed++;
        }
        System.out.printf("[structured-reliability] fixtures=%d exact=%d recovered=%d failed=%d exactRate=%.2f repairShareOfUsable=%.2f%n",
                FIXTURES.size(), exact, recovered, failed, (double) exact / FIXTURES.size(), usable(exact, recovered) == 0 ? 0 : (double) recovered / usable(exact, recovered));
        assertThat(violations).as("fixture outcome mismatches: %s", violations).isEmpty();
        // The matrix is deliberately adversarial, so its exact rate reflects fixture design, not the
        // model's live compliance; what is asserted here is that classification never drifts, and
        // the exact/recovered split is printed for the report. Live compliance is measured against
        // the provider, where a repair-heavy split is the prompt-quality signal.
        assertThat(exact).isGreaterThan(0);
        assertThat(exact + recovered + failed).isEqualTo(FIXTURES.size());
        // Every failure must carry a classified reason, never a bare exception.
        for (Fixture fixture : FIXTURES) {
            if (fixture.expected() != Outcome.FAILED) continue;
            StructuredNormalizationResult result = normalizer.normalize(fixture.raw(), fixture.type(), fixture.finishReason());
            assertThat(result.failure()).as("classified failure for %s/%s", fixture.family(), fixture.name()).isNotNull();
        }
    }

    private static int usable(int exact, int recovered) { return exact + recovered; }
}
