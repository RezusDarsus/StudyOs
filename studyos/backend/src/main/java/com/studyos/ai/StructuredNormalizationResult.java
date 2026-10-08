package com.studyos.ai;

/**
 * The outcome of structural normalization: the JSON that may be handed to strict deserialization,
 * the one repair that produced it (if any), and, when normalization failed, the classified reason
 * and whether the response looked truncated. Pure data — no parsing happens here.
 */
public record StructuredNormalizationResult(
        String normalizedJson,
        StructuredRepairKind repairKind,
        boolean repaired,
        StructuredOutputFailure failure,
        boolean truncated,
        String detail) {

    public boolean success() { return failure == null; }

    static StructuredNormalizationResult success(String normalizedJson, StructuredRepairKind repairKind, boolean repaired) {
        return new StructuredNormalizationResult(normalizedJson, repairKind, repaired, null, false, null);
    }

    static StructuredNormalizationResult failure(StructuredOutputFailure failure, StructuredRepairKind repairKind, boolean repaired, boolean truncated) {
        return new StructuredNormalizationResult(null, repairKind, repaired, failure, truncated, null);
    }

    static StructuredNormalizationResult failure(StructuredOutputFailure failure, StructuredRepairKind repairKind, boolean repaired, boolean truncated, String detail) {
        return new StructuredNormalizationResult(null, repairKind, repaired, failure, truncated, detail);
    }
}
