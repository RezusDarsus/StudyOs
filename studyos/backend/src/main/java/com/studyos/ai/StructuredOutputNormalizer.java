package com.studyos.ai;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Optional;

/**
 * Turns one raw provider response into JSON that is ready for strict deserialization into the
 * requested type, applying only deterministic, structure-level repairs.
 *
 * <p>The pipeline: strip harmless wrappers (code fences), extract the one unambiguous JSON payload,
 * tolerate trailing commas through the parser (never by rewriting text), then — and only when the
 * target type <em>proves</em> it is a {@link SingleListWrapperShape single-list wrapper} — wrap a
 * bare array or a bare single object into the target's single collection field. Every candidate
 * repair is validated by a strict trial parse before it is accepted; anything ambiguous, any
 * unknown field shape, any schema violation is refused rather than papered over.
 *
 * <p>Content is never repaired: no invented scores, no substituted enums, no generated text, no
 * default values. Semantics stay the caller's business. No database, no provider calls — this class
 * is pure and directly unit-testable.
 */
public final class StructuredOutputNormalizer {
    private final ObjectMapper mapper;
    private final ObjectMapper tolerantMapper;

    public StructuredOutputNormalizer(ObjectMapper mapper) {
        this.mapper = mapper;
        // One notch more lenient than the strict mapper, used only after the strict parse failed:
        // trailing commas are a syntax habit, not a content change, and tolerating them through the
        // parser cannot corrupt string literals the way a text rewrite would.
        this.tolerantMapper = mapper.copy().configure(JsonParser.Feature.ALLOW_TRAILING_COMMA, true);
    }

    public StructuredNormalizationResult normalize(String raw, Class<?> targetType) {
        return normalize(raw, targetType, null);
    }

    /**
     * @param finishReason the provider's finish reason for this response, when known; a length-capped
     *                     finish turns unparseable output into a {@code TRUNCATED} classification
     */
    public StructuredNormalizationResult normalize(String raw, Class<?> targetType, String finishReason) {
        if (raw == null || raw.isBlank()) return failure(StructuredOutputFailure.EMPTY_OUTPUT, StructuredRepairKind.NONE, false, lengthCapped(finishReason));
        StructuredPayloadScanner.Scan scan = StructuredPayloadScanner.scan(raw);
        if (scan.payloads().size() > 1) {
            return failure(StructuredOutputFailure.MULTIPLE_JSON_PAYLOADS, StructuredRepairKind.NONE, false,
                    scan.unterminated() || lengthCapped(finishReason));
        }
        if (scan.payloads().isEmpty()) {
            return failure(StructuredOutputFailure.NO_JSON_PAYLOAD, StructuredRepairKind.NONE, false,
                    scan.unterminated() || lengthCapped(finishReason));
        }
        StructuredPayloadScanner.Payload payload = scan.payloads().getFirst();
        boolean extracted = !payload.text().equals(raw.trim());
        JsonNode root = parse(mapper, payload.text());
        boolean tolerated = false;
        if (root == null) {
            root = parse(tolerantMapper, payload.text());
            tolerated = root != null;
        }
        if (root == null) {
            return failure(StructuredOutputFailure.INVALID_JSON, kind(payload.fenced(), extracted, tolerated), tolerated || extracted || payload.fenced(),
                    scan.unterminated() || lengthCapped(finishReason));
        }
        StructuredRepairKind kind = kind(payload.fenced(), extracted, tolerated);
        boolean repaired = kind != StructuredRepairKind.NONE;
        if (!root.isObject() && !root.isArray()) {
            return failure(StructuredOutputFailure.UNSUPPORTED_ROOT_SHAPE, kind, repaired, scan.unterminated());
        }
        if (targetType == null) {
            return StructuredNormalizationResult.success(root.toString(), kind, repaired);
        }
        return normalizeAgainstType(root, targetType, kind, repaired, scan.unterminated());
    }

    private StructuredNormalizationResult normalizeAgainstType(JsonNode root, Class<?> targetType, StructuredRepairKind kind,
                                                               boolean repaired, boolean unterminated) {
        Optional<SingleListWrapperShape.Shape> shape = SingleListWrapperShape.of(targetType);
        if (root.isArray()) {
            if (shape.isEmpty()) {
                // An array can only ever satisfy a single-list wrapper; against any other target the
                // root shape itself is unusable, not merely schema-wrong.
                return parses(root, targetType)
                        ? StructuredNormalizationResult.success(root.toString(), kind, repaired)
                        : failure(StructuredOutputFailure.UNSUPPORTED_ROOT_SHAPE, kind, repaired, unterminated);
            }
            // A bare array can only go to the wrapper's single collection field; the whole wrapped
            // document must still pass the strict parse, element schema included.
            ObjectNode wrapped = mapper.createObjectNode();
            wrapped.set(shape.get().field(), root);
            if (parses(wrapped, targetType)) {
                return StructuredNormalizationResult.success(wrapped.toString(), StructuredRepairKind.WRAPPED_BARE_ARRAY, true);
            }
            return failure(StructuredOutputFailure.REPAIR_REJECTED, StructuredRepairKind.WRAPPED_BARE_ARRAY, true, unterminated);
        }
        if (shape.isPresent() && !presentIn(shape.get(), root) && root.size() > 0) {
            // A bare object where exactly one list was expected. Repairable only when the object
            // structurally matches the element type: shares a property with it and deserializes
            // into it cleanly. Anything else is refused instead of silently deserialized empty.
            SingleListWrapperShape.Shape wrapper = shape.get();
            if (sharesPropertyWith(root, wrapper.elementNames()) && parses(root, wrapper.element())) {
                ObjectNode wrapped = mapper.createObjectNode();
                wrapped.putArray(wrapper.field()).add(root);
                if (parses(wrapped, targetType)) {
                    return StructuredNormalizationResult.success(wrapped.toString(), StructuredRepairKind.WRAPPED_SINGLE_OBJECT, true);
                }
                return failure(StructuredOutputFailure.REPAIR_REJECTED, StructuredRepairKind.WRAPPED_SINGLE_OBJECT, true, unterminated);
            }
            return failure(StructuredOutputFailure.REPAIR_REJECTED, StructuredRepairKind.WRAPPED_SINGLE_OBJECT, false, unterminated);
        }
        if (sharesNoKnownProperty(root, targetType)) {
            // The payload is an object that names none of the target's properties: deserializing it
            // would silently produce an empty result. Refuse with a schema failure instead.
            return failure(StructuredOutputFailure.SCHEMA_MISMATCH, kind, repaired, unterminated);
        }
        return parseDirect(root, targetType, kind, repaired, unterminated);
    }

    private StructuredNormalizationResult parseDirect(JsonNode root, Class<?> targetType, StructuredRepairKind kind,
                                                      boolean repaired, boolean unterminated) {
        try {
            mapper.treeToValue(root, targetType);
            return StructuredNormalizationResult.success(root.toString(), kind, repaired);
        } catch (RuntimeException | com.fasterxml.jackson.core.JsonProcessingException error) {
            // A payload that parsed as JSON but fails the schema is a schema problem, not truncation,
            // even when the provider reported a length cap: the JSON itself was complete. The exact
            // deserialization complaint names the offending field, so it travels with the failure.
            String detail = String.valueOf(error.getMessage()).split("\n")[0];
            return StructuredNormalizationResult.failure(StructuredOutputFailure.SCHEMA_MISMATCH, kind, repaired, unterminated,
                    detail.length() <= 300 ? detail : detail.substring(0, 300));
        }
    }

    private boolean sharesNoKnownProperty(JsonNode root, Class<?> targetType) {
        if (!root.isObject() || root.size() == 0) return false;
        java.util.Set<String> known = SingleListWrapperShape.propertyNames(targetType);
        if (known == null || known.isEmpty()) return false;
        java.util.Iterator<String> names = root.fieldNames();
        while (names.hasNext()) if (known.contains(names.next())) return false;
        return true;
    }

    private boolean sharesPropertyWith(JsonNode root, java.util.Set<String> elementNames) {
        java.util.Iterator<String> names = root.fieldNames();
        while (names.hasNext()) if (elementNames.contains(names.next())) return true;
        return false;
    }

    private boolean presentIn(SingleListWrapperShape.Shape shape, JsonNode root) {
        for (String accepted : shape.acceptedNames()) if (root.has(accepted)) return true;
        return false;
    }

    private boolean parses(JsonNode node, Class<?> type) {
        try {
            mapper.treeToValue(node, type);
            return true;
        } catch (RuntimeException | com.fasterxml.jackson.core.JsonProcessingException error) {
            return false;
        }
    }

    private JsonNode parse(ObjectMapper target, String text) {
        try {
            return target.readTree(text);
        } catch (RuntimeException | java.io.IOException error) {
            return null;
        }
    }

    private StructuredRepairKind kind(boolean fenced, boolean extracted, boolean tolerated) {
        if (fenced) return StructuredRepairKind.STRIPPED_CODE_FENCE;
        if (extracted) return StructuredRepairKind.EXTRACTED_SINGLE_JSON_PAYLOAD;
        if (tolerated) return StructuredRepairKind.REMOVED_TRAILING_COMMA;
        return StructuredRepairKind.NONE;
    }

    private boolean lengthCapped(String finishReason) {
        if (finishReason == null) return false;
        String normalized = finishReason.trim().toLowerCase(java.util.Locale.ROOT);
        return normalized.equals("length") || normalized.equals("max_tokens");
    }

    private StructuredNormalizationResult failure(StructuredOutputFailure failureKind, StructuredRepairKind repairKind,
                                                  boolean repaired, boolean truncated) {
        StructuredOutputFailure classified = truncated ? StructuredOutputFailure.TRUNCATED : failureKind;
        return StructuredNormalizationResult.failure(classified, repairKind, repaired, truncated);
    }
}
