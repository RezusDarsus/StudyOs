package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.assessment.QuizService;
import com.studyos.assessment.SyllabusLlmParser;
import com.studyos.chat.PredictionVerificationBatch;
import com.studyos.curriculum.CurriculumService;
import com.studyos.knowledge.TopicExtractionService;
import com.studyos.research.ResearchGoalDecomposer;
import com.studyos.retrieval.LlmRerankerProvider;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Contract regressions per structured output family, using the real DTOs the services deserialize
 * into. The gateway may repair structure; these tests pin down exactly which repairs each family
 * gets — and that domain validation downstream is never bypassed by a repair.
 */
class StructuredOutputFamilyContractTest {
    private final StructuredOutputNormalizer normalizer = new StructuredOutputNormalizer(new ObjectMapper());

    // ---- quiz generation ---------------------------------------------------------------------

    @Test void quizGenerationAcceptsExactWrapperUnchanged() {
        var result = normalizer.normalize("{\"questions\":[{\"prompt\":\"Q1\",\"answer\":\"A1\"}]}", QuizService.QuestionBatch.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repaired()).isFalse();
        assertThat(parse(QuizService.QuestionBatch.class, result).questions()).hasSize(1);
    }

    @Test void quizSingleQuestionAsBareObjectIsWrappedIntoTheQuestionsArray() {
        // The measured failure this tranche exists for: count=1 requests answered with the question
        // object itself. Without the repair this parsed "successfully" into an empty batch.
        var result = normalizer.normalize("{\"prompt\":\"Q1\",\"answer\":\"A1\",\"hints\":[\"h1\",\"h2\",\"h3\",\"h4\"]}", QuizService.QuestionBatch.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.WRAPPED_SINGLE_OBJECT);
        List<QuizService.QuestionDraft> questions = parse(QuizService.QuestionBatch.class, result).questions();
        assertThat(questions).hasSize(1);
        assertThat(questions.getFirst().prompt()).isEqualTo("Q1");
    }

    @Test void quizBatchAsBareArrayIsWrapped() {
        var result = normalizer.normalize("[{\"prompt\":\"Q1\",\"answer\":\"A1\"},{\"prompt\":\"Q2\",\"answer\":\"A2\"}]", QuizService.QuestionBatch.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.WRAPPED_BARE_ARRAY);
        assertThat(parse(QuizService.QuestionBatch.class, result).questions()).hasSize(2);
    }

    @Test void quizTruncatedBatchIsClassifiedNotSilentlyEmptied() {
        var result = normalizer.normalize("{\"questions\":[{\"prompt\":\"Q1\"}", QuizService.QuestionBatch.class);
        assertThat(result.success()).isFalse();
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.TRUNCATED);
    }

    // ---- grading -----------------------------------------------------------------------------

    @Test void gradingAcceptsTheValidWrapperUnchanged() {
        var result = normalizer.normalize("{\"score\":0.75,\"feedback\":\"partly right\",\"errorType\":\"PARTIAL\",\"misconception\":null,\"conceptScores\":[],\"mistakes\":[]}", QuizService.GradeResult.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.NONE);
    }

    @Test void gradingBareGradeObjectIsNotWrappedAndStillParsesOnItsOwnProperties() {
        var result = normalizer.normalize("{\"score\":0.8,\"feedback\":\"ok\"}", QuizService.GradeResult.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repaired()).isFalse();
    }

    @Test void gradingSemanticTypeErrorsStillFail() {
        var result = normalizer.normalize("{\"score\":\"nearly right\",\"feedback\":\"ok\"}", QuizService.GradeResult.class);
        assertThat(result.success()).isFalse();
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.SCHEMA_MISMATCH);
    }

    // ---- topic extraction --------------------------------------------------------------------

    @Test void topicExtractionBareArrayIsWrappedIntoTopics() {
        var result = normalizer.normalize("[{\"name\":\"TCP flow control\",\"relevance\":0.9}]", TopicExtractionService.TopicResponse.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.WRAPPED_BARE_ARRAY);
        List<TopicExtractionService.TopicCandidate> topics = parse(TopicExtractionService.TopicResponse.class, result).topics();
        assertThat(topics).hasSize(1);
        assertThat(topics.getFirst().name()).isEqualTo("TCP flow control");
    }

    @Test void topicExtractionSingleCandidateObjectIsWrapped() {
        var result = normalizer.normalize("{\"name\":\"Congestion control\",\"description\":\"d\",\"relevance\":0.7,\"aliases\":[],\"chunkIds\":[]}", TopicExtractionService.TopicResponse.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.WRAPPED_SINGLE_OBJECT);
    }

    @Test void topicExtractionInvalidCandidateStructureStillFailsBeforeTheQualityGate() {
        var result = normalizer.normalize("{\"topics\":[{\"relevance\":\"high\"}]}", TopicExtractionService.TopicResponse.class);
        assertThat(result.success()).isFalse();
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.SCHEMA_MISMATCH);
    }

    // ---- syllabus ----------------------------------------------------------------------------

    @Test void syllabusFallbackRecoversFencedJson() {
        var result = normalizer.normalize("```json\n{\"units\":[{\"title\":\"Week 1 — Overview\",\"sourceChunkIds\":[]}]}\n```", SyllabusLlmParser.LlmSyllabus.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.STRIPPED_CODE_FENCE);
    }

    // ---- curriculum --------------------------------------------------------------------------

    @Test void curriculumFencedObjectParses() {
        var result = normalizer.normalize("```json\n{\"title\":\"Course\",\"summary\":\"s\",\"modules\":[]}\n```", CurriculumService.CurriculumDraft.class);
        assertThat(result.success()).isTrue();
    }

    @Test void curriculumBareArrayIsRefusedBecauseTheTargetHasWrapperLevelFields() {
        // A bare array cannot supply title/summary; wrapping would invent them. Conservative refusal.
        var result = normalizer.normalize("[{\"title\":\"Module A\",\"lessons\":[]}]", CurriculumService.CurriculumDraft.class);
        assertThat(result.success()).isFalse();
        assertThat(result.repaired()).isFalse();
    }

    // ---- research ----------------------------------------------------------------------------

    @Test void researchDecompositionProsePayloadIsExtracted() {
        var result = normalizer.normalize("Here is the decomposition:\n{\"needs\":[{\"name\":\"Dependency injection\",\"importance\":0.9,\"reason\":\"r\",\"researchQueries\":[\"dependency injection explained\"]}]}", ResearchGoalDecomposer.LlmNeeds.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.EXTRACTED_SINGLE_JSON_PAYLOAD);
        assertThat(parse(ResearchGoalDecomposer.LlmNeeds.class, result).needs()).hasSize(1);
    }

    // ---- verification ------------------------------------------------------------------------

    @Test void verificationBatchIsRecognizedThroughItsAliasesWithoutWrapping() {
        var result = normalizer.normalize("{\"verifications\":[{\"candidateId\":\"candidate-1\",\"scopeViolation\":false,\"groundingOk\":true,\"wellDefined\":true,\"nearCopy\":false,\"confidence\":0.9}]}", PredictionVerificationBatch.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repaired()).isFalse();
        assertThat(parse(PredictionVerificationBatch.class, result).candidates()).hasSize(1);
    }

    // ---- reranking ---------------------------------------------------------------------------

    @Test void rerankerBareScoreArrayIsWrapped() {
        var result = normalizer.normalize("[{\"id\":1,\"relevance\":0.9}]", LlmRerankerProvider.Scores.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.WRAPPED_BARE_ARRAY);
    }

    // ---- shared invariants -------------------------------------------------------------------

    @Test void noRepairEverBypassesStrictDeserializationOfEnumUuidOrNumberTypes() {
        UUID chunkId = UUID.randomUUID();
        // A valid UUID parses; a fabricated one does not — the gateway refuses rather than invents.
        var valid = normalizer.normalize("{\"topics\":[{\"name\":\"T\",\"relevance\":0.5,\"chunkIds\":[\"" + chunkId + "\"]}]}", TopicExtractionService.TopicResponse.class);
        assertThat(valid.success()).isTrue();
        var invalid = normalizer.normalize("{\"topics\":[{\"name\":\"T\",\"relevance\":0.5,\"chunkIds\":[\"not-a-uuid\"]}]}", TopicExtractionService.TopicResponse.class);
        assertThat(invalid.success()).isFalse();
    }

    private <T> T parse(Class<T> type, StructuredNormalizationResult result) {
        try {
            return new ObjectMapper().readValue(result.normalizedJson(), type);
        } catch (Exception error) {
            throw new IllegalStateException("fixture should have parsed: " + result.normalizedJson(), error);
        }
    }
}
