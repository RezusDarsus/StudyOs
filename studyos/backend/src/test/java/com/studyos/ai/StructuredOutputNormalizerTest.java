package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The fixture matrix from the structured-output contract: for one single-list wrapper, every
 * recoverable provider shape is repaired deterministically and every ambiguous or invalid one is
 * refused. Type-driven, never hardcoded to a field name.
 */
class StructuredOutputNormalizerTest {
    private final StructuredOutputNormalizer normalizer = new StructuredOutputNormalizer(new ObjectMapper());

    record Item(String name) {}
    record Items(List<Item> items) { @com.fasterxml.jackson.annotation.JsonCreator Items(@com.fasterxml.jackson.annotation.JsonProperty("items") List<Item> items) { this.items = items == null ? List.of() : items; } }
    enum Verdict { A, B }
    record Scored(Verdict verdict) {}

    @Test void exactJsonIsAcceptedWithoutRepair() {
        var result = normalizer.normalize("{\"items\":[{\"name\":\"A\"}]}", Items.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.NONE);
        assertThat(result.repaired()).isFalse();
    }

    @Test void fencedJsonIsRecoveredByStrippingTheFence() {
        var result = normalizer.normalize("```json\n{\"items\":[{\"name\":\"A\"}]}\n```", Items.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.STRIPPED_CODE_FENCE);
        assertThat(result.repaired()).isTrue();
    }

    @Test void bareArrayIsWrappedIntoTheSingleListField() {
        var result = normalizer.normalize("[{\"name\":\"A\"}]", Items.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.WRAPPED_BARE_ARRAY);
        assertThat(result.normalizedJson()).isEqualTo("{\"items\":[{\"name\":\"A\"}]}");
    }

    @Test void bareSingleObjectIsWrappedAsTheSingleElement() {
        var result = normalizer.normalize("{\"name\":\"A\"}", Items.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.WRAPPED_SINGLE_OBJECT);
        assertThat(result.normalizedJson()).isEqualTo("{\"items\":[{\"name\":\"A\"}]}");
    }

    @Test void proseAroundASinglePayloadIsExtracted() {
        var result = normalizer.normalize("Sure, here is the result:\n{\"items\":[{\"name\":\"A\"}]}\nAnything else?", Items.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.EXTRACTED_SINGLE_JSON_PAYLOAD);
    }

    @Test void multiplePayloadsAreRejectedAsAmbiguous() {
        var result = normalizer.normalize("{\"items\":[]}\n{\"items\":[{\"name\":\"A\"}]}", Items.class);
        assertThat(result.success()).isFalse();
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.MULTIPLE_JSON_PAYLOADS);
    }

    @Test void wrongFieldsAreRejectedNotSilentlyEmptied() {
        var result = normalizer.normalize("{\"foo\":\"bar\"}", Items.class);
        assertThat(result.success()).isFalse();
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.REPAIR_REJECTED);
    }

    @Test void invalidEnumValuesStillFailValidation() {
        var result = normalizer.normalize("{\"verdict\":\"C\"}", Scored.class);
        assertThat(result.success()).isFalse();
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.SCHEMA_MISMATCH);
    }

    @Test void invalidValueTypesStillFailValidation() {
        var result = normalizer.normalize("{\"items\":[{\"name\":[\"a\",\"b\"]}]}", Items.class);
        assertThat(result.success()).isFalse();
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.SCHEMA_MISMATCH);
    }

    @Test void truncatedOutputIsClassifiedAsTruncated() {
        var result = normalizer.normalize("{\"items\":[{\"name\":\"A\"", Items.class);
        assertThat(result.success()).isFalse();
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.TRUNCATED);
        assertThat(result.truncated()).isTrue();
    }

    @Test void lengthCappedFinishReasonTurnsUnparseableOutputIntoTruncation() {
        var result = normalizer.normalize("{\"items\":[{\"name\":", Items.class, "length");
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.TRUNCATED);
        var blank = normalizer.normalize("", Items.class, "length");
        assertThat(blank.failure()).isEqualTo(StructuredOutputFailure.TRUNCATED);
    }

    @Test void completeJsonWithALengthCapIsNotCalledTruncated() {
        var result = normalizer.normalize("{\"items\":[{\"name\":\"A\"}]}", Items.class, "length");
        assertThat(result.success()).isTrue();
    }

    @Test void trailingCommasAreToleratedThroughTheParserNotTextRewrites() {
        var result = normalizer.normalize("{\"items\":[{\"name\":\"A\"},],}", Items.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.REMOVED_TRAILING_COMMA);
    }

    @Test void commaInsideAStringLiteralIsNeverTouched() {
        var result = normalizer.normalize("{\"items\":[{\"name\":\"ends with, ] here\"}]}", Items.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.NONE);
        assertThat(result.normalizedJson()).contains("ends with, ] here");
    }

    @Test void blankOutputIsClassifiedAsEmpty() {
        var result = normalizer.normalize("   ", Items.class);
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.EMPTY_OUTPUT);
    }

    @Test void scalarRootsAreTreatedAsMissingPayloads() {
        // The scanner only recognizes object/array payloads: a bare JSON scalar is prose-equivalent.
        assertThat(normalizer.normalize("\"just a string\"", Items.class).failure()).isEqualTo(StructuredOutputFailure.NO_JSON_PAYLOAD);
        assertThat(normalizer.normalize("42", Items.class).failure()).isEqualTo(StructuredOutputFailure.NO_JSON_PAYLOAD);
    }

    @Test void anEmptyObjectIsStillAcceptedWithAnEmptyList() {
        // Old behaviour preserved deliberately: an empty object deserializes to an empty wrapper.
        var result = normalizer.normalize("{}", Items.class);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.NONE);
    }

    @Test void normalizationWithoutATargetTypeStillExtractsPayload() {
        var result = normalizer.normalize("Answer: {\"items\":[{\"name\":\"A\"}]}", null);
        assertThat(result.success()).isTrue();
        assertThat(result.repairKind()).isEqualTo(StructuredRepairKind.EXTRACTED_SINGLE_JSON_PAYLOAD);
    }

    // ---- non-wrapper targets -----------------------------------------------------------------

    @Test void aTargetWithTwoCollectionFieldsIsNeverTreatedAsASingleListWrapper() {
        // Grading: a bare grade object must NOT be wrapped, because GradeResult has more than one
        // collection field and is not a single-list wrapper. Its own properties parse directly.
        var valid = normalizer.normalize("{\"score\":0.9,\"feedback\":\"ok\"}", QuizGradeFixture.class);
        assertThat(valid.success()).isTrue();
        assertThat(valid.repairKind()).isEqualTo(StructuredRepairKind.NONE);
    }

    @Test void unknownFieldsOnANonWrapperTargetAreASchemaMismatch() {
        var result = normalizer.normalize("{\"grade\":1,\"note\":\"x\"}", QuizGradeFixture.class);
        assertThat(result.success()).isFalse();
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.SCHEMA_MISMATCH);
    }

    @Test void aBareArrayAgainstANonWrapperTargetIsAnUnsupportedRootShape() {
        var result = normalizer.normalize("[{\"score\":1}]", QuizGradeFixture.class);
        assertThat(result.success()).isFalse();
        assertThat(result.failure()).isEqualTo(StructuredOutputFailure.UNSUPPORTED_ROOT_SHAPE);
    }

    /** Stands in for a grader response: several properties, two collection fields, no wrapping. */
    record QuizGradeFixture(double score, String feedback, List<String> conceptScores, List<String> mistakes) {}
}
