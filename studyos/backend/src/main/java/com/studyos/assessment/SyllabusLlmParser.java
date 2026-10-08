package com.studyos.assessment;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.studyos.ai.AiGateway;
import com.studyos.ai.AiOperation;
import com.studyos.ai.AiResult;
import com.studyos.ai.AiUsageService;
import com.studyos.ai.GenerationPolicyRegistry;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Structured LLM fallback for syllabi the deterministic parser could not read (messy tables,
 * layouts without unit headings). The model is allowed to <em>read</em> the document, never to
 * <em>write</em> it: every extracted unit is validated against the chunk text it claims as its
 * source, and anything not grounded there is dropped. A unit that names a chunk that does not
 * exist, or a topic that appears in no chunk, cannot survive validation.
 */
@Service
public class SyllabusLlmParser {
    private static final Logger log = LoggerFactory.getLogger(SyllabusLlmParser.class);
    private static final int MAX_UNITS = 30;

    private final AiGateway ai;
    private final GenerationPolicyRegistry policies;
    private final AiUsageService usage;

    public SyllabusLlmParser(AiGateway ai, GenerationPolicyRegistry policies, AiUsageService usage) {
        this.ai = ai;
        this.policies = policies;
        this.usage = usage;
    }

    public record Fallback(List<SyllabusParser.ParsedUnit> units, List<SyllabusParser.ParsedAssessment> assessments, List<String> issues, boolean used) {}

    /**
     * Runs one structured extraction over the provided chunks. Any provider failure is contained:
     * the caller keeps its deterministic result and the document is not failed because of this.
     */
    public Fallback extract(List<SyllabusParser.ChunkInput> chunks) {
        if (chunks == null || chunks.isEmpty()) return new Fallback(List.of(), List.of(), List.of("No chunks provided"), false);
        StringBuilder prompt = new StringBuilder("This document is a course syllabus that automatic parsing could not read. Extract its units in order.\n")
                .append("Rules: use ONLY text present in the chunks. Never invent dates, assignments or topics; if a field is unknown, use null or an empty array. ")
                .append("Every unit must list sourceChunkIds copied exactly from the CHUNK ids below, containing only the chunks the unit's text appears in.\n");
        for (SyllabusParser.ChunkInput chunk : chunks) {
            prompt.append("CHUNK ").append(chunk.chunkId()).append(":\n").append(trim(chunk.text(), 2400)).append("\n\n");
        }
        prompt.append("Return JSON only: {\"units\":[{\"title\":\"...\",\"ordinal\":1,\"week\":null,\"date\":\"YYYY-MM-DD or null\",\"topics\":[],\"readings\":[],\"assignments\":[],\"sourceChunkIds\":[]}]}");
        long started = System.nanoTime();
        AiResult<LlmSyllabus> result = null;
        boolean success = false;
        try {
            result = ai.generateStructuredResult("You extract course syllabus structure verbatim from provided text. You never invent content. Return only valid JSON.",
                    prompt.toString(), LlmSyllabus.class, policies.policy(AiOperation.SYLLABUS_PARSING));
            success = true;
            Map<UUID, String> chunkText = new LinkedHashMap<>();
            for (SyllabusParser.ChunkInput chunk : chunks) chunkText.put(chunk.chunkId(), chunk.text() == null ? "" : chunk.text());
            List<String> issues = new ArrayList<>();
            List<SyllabusParser.ParsedUnit> units = validate(result.value() == null ? null : result.value().units(), chunkText, issues);
            return new Fallback(units, List.of(), issues, true);
        } catch (RuntimeException error) {
            log.info("LLM syllabus fallback unavailable: {}", error.getMessage());
            return new Fallback(List.of(), List.of(), List.of("LLM fallback failed: " + trim(error.getMessage(), 200)), false);
        } finally {
            usage.record(AiOperation.SYLLABUS_PARSING, result, null, null, null, (System.nanoTime() - started) / 1_000_000, success);
        }
    }

    /**
     * Grounding validator, pure so it is directly testable. A unit survives only when its title and
     * every topic it claims appear in the chunks it references.
     */
    static List<SyllabusParser.ParsedUnit> validate(List<LlmUnit> units, Map<UUID, String> chunkText, List<String> issues) {
        List<SyllabusParser.ParsedUnit> validated = new ArrayList<>();
        if (units == null) return validated;
        for (LlmUnit unit : units) {
            if (validated.size() >= MAX_UNITS) { issues.add("LLM returned more than " + MAX_UNITS + " units; the remainder were dropped"); break; }
            if (unit.title() == null || unit.title().isBlank()) { issues.add("Unit without a title dropped"); continue; }
            List<UUID> chunkIds = new ArrayList<>();
            if (unit.sourceChunkIds() != null) {
                for (String id : unit.sourceChunkIds()) {
                    try { UUID parsed = UUID.fromString(id.trim()); if (chunkText.containsKey(parsed) && !chunkIds.contains(parsed)) chunkIds.add(parsed); }
                    catch (IllegalArgumentException error) { issues.add("Unit '" + unit.title() + "' referenced a non-provided chunk id: " + id); }
                }
            }
            if (chunkIds.isEmpty()) { issues.add("Unit '" + unit.title() + "' has no valid source chunk; dropped"); continue; }
            String grounded = chunkIds.stream().map(chunkText::get).collect(java.util.stream.Collectors.joining(" "));
            String foldedGround = SyllabusParser.TopicGrounding.fold(grounded);
            if (!foldedGround.contains(SyllabusParser.TopicGrounding.fold(unit.title()))) {
                issues.add("Unit title not grounded in its source chunks: " + unit.title());
                continue;
            }
            List<String> topics = new ArrayList<>();
            if (unit.topics() != null) {
                for (String topic : unit.topics()) {
                    if (topic == null || topic.isBlank()) continue;
                    if (foldedGround.contains(SyllabusParser.TopicGrounding.fold(topic))) topics.add(topic.trim());
                    else issues.add("Topic not grounded, dropped: " + topic);
                }
            }
            Integer ordinal = unit.ordinal() == null ? null : (unit.ordinal() >= 1 && unit.ordinal() <= 99 ? unit.ordinal() : null);
            Integer week = unit.week() == null ? null : (unit.week() >= 1 && unit.week() <= 99 ? unit.week() : null);
            java.time.LocalDate date = unit.date() == null || unit.date().isBlank() ? null : safeDate(unit.date().trim());
            List<String> readings = groundedList(unit.readings(), foldedGround, issues, unit.title());
            List<String> assignments = groundedList(unit.assignments(), foldedGround, issues, unit.title());
            validated.add(new SyllabusParser.ParsedUnit(unit.title().trim(), ordinal, week, date, topics, readings, assignments, List.copyOf(chunkIds)));
        }
        return validated;
    }

    private static List<String> groundedList(List<String> values, String foldedGround, List<String> issues, String unitTitle) {
        List<String> result = new ArrayList<>();
        if (values == null) return result;
        for (String value : values) {
            if (value == null || value.isBlank()) continue;
            if (foldedGround.contains(SyllabusParser.TopicGrounding.fold(value))) result.add(value.trim());
            else issues.add("Item not grounded, dropped from '" + unitTitle + "': " + value);
        }
        return result;
    }

    private static java.time.LocalDate safeDate(String value) {
        try {
            return java.time.LocalDate.parse(value);
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static String trim(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, max);
    }

    public record LlmSyllabus(List<LlmUnit> units) {
        @JsonCreator public LlmSyllabus(@JsonProperty("units") List<LlmUnit> units) { this.units = units == null ? List.of() : units; }
    }

    public record LlmUnit(String title, Integer ordinal, Integer week, String date, List<String> topics,
                          List<String> readings, List<String> assignments, List<String> sourceChunkIds) {
        @JsonCreator public LlmUnit(@JsonProperty("title") String title, @JsonProperty("ordinal") Integer ordinal,
                                    @JsonProperty("week") Integer week, @JsonProperty("date") String date,
                                    @JsonProperty("topics") List<String> topics, @JsonProperty("readings") List<String> readings,
                                    @JsonProperty("assignments") List<String> assignments, @JsonProperty("sourceChunkIds") List<String> sourceChunkIds) {
            this.title = title; this.ordinal = ordinal; this.week = week; this.date = date;
            this.topics = topics; this.readings = readings; this.assignments = assignments; this.sourceChunkIds = sourceChunkIds;
        }
    }
}
