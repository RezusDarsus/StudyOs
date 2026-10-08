package com.studyos.assessment;

import static org.junit.jupiter.api.Assertions.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class SyllabusParsePipelineTest {
    private static final UUID CHUNK_A = UUID.randomUUID();
    private static final UUID CHUNK_B = UUID.randomUUID();
    private static final UUID CHUNK_C = UUID.randomUUID();

    private static List<SyllabusParser.ChunkInput> chunks(String... texts) {
        return List.of(
                new SyllabusParser.ChunkInput(CHUNK_A, texts.length > 0 ? texts[0] : ""),
                new SyllabusParser.ChunkInput(CHUNK_B, texts.length > 1 ? texts[1] : ""),
                new SyllabusParser.ChunkInput(CHUNK_C, texts.length > 2 ? texts[2] : ""));
    }

    @Test
    void cleanWeekSyllabusParsesWithHighConfidence() {
        String text = """
                Course Schedule
                Week 1: Introduction to Distributed Systems
                Basic concepts
                Learning objective: reason about failure modes
                Reading: Chapter 1
                Week 2: Clocks and Ordering
                Lamport clocks
                Week 3: Consensus Basics
                """;
        var detection = SyllabusParser.detect(text);
        assertTrue(detection.detected());
        var result = SyllabusParser.parseDocument(chunks(text), detection);
        assertEquals(SyllabusParser.ParseStatus.PARSED, result.status());
        assertEquals(SyllabusParser.ParseConfidence.HIGH, result.confidence());
        assertEquals(3, result.units().size());
        assertEquals(1, result.units().get(0).week());
        assertTrue(result.units().get(0).topics().contains("Basic concepts"));
        assertFalse(result.units().get(0).readings().isEmpty());
        assertEquals(List.of(CHUNK_A), result.units().get(0).sourceChunkIds());
    }

    @Test
    void moduleBasedSyllabusParsesWithOrdinals() {
        String text = """
                Module 1 Foundations
                Variables and types
                Module 2 Control Flow
                Conditionals
                Module 3 Functions
                """;
        var result = SyllabusParser.parseDocument(chunks(text), null);
        assertEquals(SyllabusParser.ParseStatus.PARSED, result.status());
        assertEquals(3, result.units().size());
        assertEquals(2, result.units().get(1).ordinal());
        assertNull(result.units().get(1).week());
        assertTrue(result.units().get(1).topics().contains("Conditionals"));
    }

    @Test
    void romanNumeralUnitsParse() {
        String text = """
                Unit I: Mechanics
                Kinematics
                Unit II: Energy
                Work and kinetic energy
                Unit III: Momentum
                """;
        var result = SyllabusParser.parseDocument(chunks(text), null);
        assertEquals(3, result.units().size());
        assertEquals(2, result.units().get(1).ordinal());
        assertTrue(result.units().get(1).topics().contains("Work and kinetic energy"));
    }

    @Test
    void tableSyllabusParses() {
        String text = """
                | Week | Topic | Reading |
                |------|-------|---------|
                | 1 | Vector clocks | Chapter 2 |
                | 2 | Leader election | Chapter 3 |
                """;
        var detection = SyllabusParser.detect(text);
        assertTrue(detection.detected(), "a syllabus table must be detected");
        var result = SyllabusParser.parseDocument(chunks(text), detection);
        assertEquals(SyllabusParser.ParseStatus.PARSED, result.status());
        assertEquals(2, result.units().size());
        assertEquals("Leader election", result.units().get(1).title());
        assertEquals(2, result.units().get(1).week());
        assertEquals(List.of("Chapter 3"), result.units().get(1).readings());
    }

    @Test
    void nonEnglishHeadingsParse() {
        String german = """
                Woche 1: Einführung
                Grundbegriffe
                Woche 2: Sortierverfahren
                """;
        var germanResult = SyllabusParser.parseDocument(chunks(german), null);
        assertEquals(2, germanResult.units().size());
        assertTrue(germanResult.units().get(0).topics().contains("Grundbegriffe"));

        String russian = "Неделя 1: Введение\nОсновные понятия\nНеделя 2: Сортировка\n";
        var russianResult = SyllabusParser.parseDocument(chunks(russian), null);
        assertEquals(2, russianResult.units().size());

        String georgian = "კვირა 1: შესავალი\nძირითადი ცნებები\nკვირა 2: სორტირება\n";
        var georgianResult = SyllabusParser.parseDocument(chunks(georgian), null);
        assertEquals(2, georgianResult.units().size());
    }

    @Test
    void dateRangeHeadingsParse() {
        String text = """
                Aug 25 - Aug 29: Introduction
                What is operating system
                Sep 1 - Sep 5: Processes
                """;
        var result = SyllabusParser.parseDocument(chunks(text), null);
        assertEquals(2, result.units().size());
        assertEquals("Introduction", result.units().get(0).title());
        assertNotNull(result.units().get(0).ordinal());
    }

    @Test
    void syllabusLookingDocumentWithZeroResultsIsFlagged() {
        String text = """
                Course policies.
                Please read the university guidelines about attendance and conduct.
                Late work is not accepted. Contact the coordinator for accommodations.
                """;
        var detection = SyllabusParser.detect(text);
        // Policies prose must not be mistaken for course structure.
        var result = SyllabusParser.parseDocument(chunks(text), detection);
        assertTrue(result.status() == SyllabusParser.ParseStatus.NOT_SYLLABUS || result.status() == SyllabusParser.ParseStatus.SYLLABUS_DETECTED_BUT_UNPARSED,
                "a zero-result parse must be explicit, got " + result.status());
        if (result.status() == SyllabusParser.ParseStatus.SYLLABUS_DETECTED_BUT_UNPARSED) {
            assertEquals(0, result.units().size());
        }
    }

    @Test
    void unitSpanningChunkBoundaryGroundsAcrossChunks() {
        String first = "Week 1: Introduction to Networking";
        String second = "Layered models\nLearning objective: describe the OSI layers";
        var result = SyllabusParser.parseDocument(chunks(first, second), null);
        assertEquals(1, result.units().size());
        assertTrue(result.units().get(0).sourceChunkIds().contains(CHUNK_A) || result.units().get(0).sourceChunkIds().contains(CHUNK_B));
    }

    @Test
    void ungroundedUnitsAreDropped() {
        String text = "Week 1: Real Content\nSomething real\n";
        var result = SyllabusParser.parseDocument(chunks(text, "an unrelated chunk about nothing relevant"), null);
        assertEquals(1, result.units().size());
    }

    @Test
    void assignmentsAreExtractedPerUnit() {
        String text = """
                Week 1: Basics
                Values
                Assignment 1 due Friday
                Week 2: Loops
                """;
        var result = SyllabusParser.parseDocument(chunks(text), null);
        assertFalse(result.units().get(0).assignments().isEmpty());
    }

    @Test
    void duplicatesAreSuppressed() {
        String text = """
                | Week | Topic | Reading |
                |------|-------|---------|
                | 1 | Vector clocks | Chapter 2 |
                | 1 | Vector clocks | Chapter 2 |
                """;
        var result = SyllabusParser.parseDocument(chunks(text), null);
        assertEquals(1, result.units().size());
        assertTrue(result.issues().stream().anyMatch(issue -> issue.contains("Duplicate")));
    }

    @Test
    void legacyWeekParsingStillWorks() {
        List<SyllabusParser.Unit> units = SyllabusParser.parse("Week 1 - Reliability\nCRC\nWeek 2: Coordination\nLeader Election");
        assertEquals(2, units.size());
        assertEquals("Reliability", units.get(0).title());
    }

    // ------------------------------------------------------------- LLM fallback validation

    private static SyllabusLlmParser.LlmUnit llmUnit(String title, Integer ordinal, Integer week, String date,
                                                     List<String> topics, List<String> chunkIds) {
        return new SyllabusLlmParser.LlmUnit(title, ordinal, week, date, topics, List.of(), List.of(), chunkIds);
    }

    @Test
    void llmUnitsAreValidatedAgainstChunkText() {
        Map<UUID, String> chunkText = Map.of(
                CHUNK_A, "Module 1: Sorting algorithms covers merge sort and quicksort.",
                CHUNK_B, "Module 2: Graph traversal covers breadth first search.");
        List<String> issues = new java.util.ArrayList<>();
        var validated = SyllabusLlmParser.validate(List.of(
                llmUnit("Sorting algorithms", 1, null, null, List.of("merge sort", "quicksort"), List.of(CHUNK_A.toString())),
                llmUnit("Invented unit", 2, null, null, List.of("hallucinated topic"), List.of(CHUNK_A.toString())),
                llmUnit("Graph traversal", 2, null, null, List.of("breadth first search"), List.of(CHUNK_B.toString())),
                llmUnit("Phantom chunk unit", 3, null, null, List.of(), List.of(UUID.randomUUID().toString()))), chunkText, issues);
        assertEquals(2, validated.size());
        assertEquals("Sorting algorithms", validated.get(0).title());
        assertEquals(List.of("merge sort", "quicksort"), validated.get(0).topics());
        assertTrue(issues.stream().anyMatch(issue -> issue.contains("not grounded")));
        assertTrue(issues.stream().anyMatch(issue -> issue.contains("no valid source chunk")));
    }

    @Test
    void llmDatesMustBeRealOrNull() {
        Map<UUID, String> chunkText = Map.of(CHUNK_A, "Week 1 2026-09-01 Introduction. Week 2 Sorting.");
        var validated = SyllabusLlmParser.validate(List.of(
                llmUnit("Introduction", 1, 1, "2026-09-01", List.of(), List.of(CHUNK_A.toString())),
                llmUnit("Sorting", 2, 2, "September the eighth, in the year of our lord", List.of(), List.of(CHUNK_A.toString()))), chunkText, new java.util.ArrayList<>());
        assertEquals(java.time.LocalDate.of(2026, 9, 1), validated.get(0).date());
        assertNull(validated.get(1).date(), "an unparseable date must become null, never invented");
    }

    @Test
    void llmOrdinalsAreSanityChecked() {
        Map<UUID, String> chunkText = Map.of(CHUNK_A, "Topic 3 Dependency injection. Topic 4 Configuration.");
        var validated = SyllabusLlmParser.validate(List.of(
                llmUnit("Dependency injection", 3, null, null, List.of(), List.of(CHUNK_A.toString())),
                llmUnit("Configuration", 412, null, null, List.of(), List.of(CHUNK_A.toString()))), chunkText, new java.util.ArrayList<>());
        assertEquals(3, validated.get(0).ordinal());
        assertNull(validated.get(1).ordinal(), "insane ordinals must not be stored");
    }
}
