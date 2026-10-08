package com.studyos.assessment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The required cross-domain matrix, at the parser level: the same deterministic pipeline must read
 * course structure from every subject. Nothing here knows the subject vocabulary — that is the
 * point of the matrix.
 */
class CrossSubjectSyllabusMatrixTest {
    private static List<SyllabusParser.ChunkInput> one(String text) {
        return List.of(new SyllabusParser.ChunkInput(UUID.randomUUID(), text));
    }

    @Test
    void computerScienceSpringBootModuleSyllabus() {
        String text = """
                Module 1 Spring Fundamentals
                Inversion of Control
                Module 2 Web Layer
                REST controllers and validation
                Module 3 Persistence
                Spring Data JPA
                """;
        var result = SyllabusParser.parseDocument(one(text), null);
        assertEquals(3, result.units().size());
        assertTrue(result.units().get(2).topics().contains("Spring Data JPA"));
    }

    @Test
    void mathematicsCalculusWeeklySyllabus() {
        String text = """
                Week 1: Limits and continuity
                Epsilon-delta definition
                Week 2: Derivatives
                Chain rule
                Week 3: Applications
                Optimization problems
                Week 4: Integration
                """;
        var result = SyllabusParser.parseDocument(one(text), null);
        assertEquals(4, result.units().size());
        assertTrue(result.units().get(1).topics().contains("Chain rule"));
    }

    @Test
    void biologyGeneticsTableSyllabus() {
        String text = """
                | Week | Topic | Reading |
                |------|-------|---------|
                | 1 | Mendelian inheritance | Ch. 2 |
                | 2 | Gene expression | Ch. 3 |
                | 3 | Linkage and recombination | Ch. 4 |
                """;
        var result = SyllabusParser.parseDocument(one(text), null);
        assertEquals(3, result.units().size());
        assertEquals("Linkage and recombination", result.units().get(2).title());
    }

    @Test
    void economicsMicroeconomicsDateRangeSyllabus() {
        String text = """
                Aug 25 - Aug 29: Supply and demand
                Market equilibrium
                Sep 1 - Sep 5: Elasticity
                Sep 8 - Sep 12: Consumer theory
                """;
        var result = SyllabusParser.parseDocument(one(text), null);
        assertEquals(3, result.units().size());
        assertTrue(result.units().get(0).topics().contains("Market equilibrium"));
    }

    @Test
    void historyInterwarEuropeRomanUnitSyllabus() {
        String text = """
                Unit I: The aftermath of the Great War
                Treaty of Versailles
                Unit II: The League of Nations
                Unit III: The Great Depression and its political consequences
                """;
        var result = SyllabusParser.parseDocument(one(text), null);
        assertEquals(3, result.units().size());
        assertTrue(result.units().get(0).topics().contains("Treaty of Versailles"));
        assertEquals(3, result.units().get(2).ordinal());
    }

    @Test
    void physicsClassicalMechanicsGermanSyllabus() {
        String text = """
                Woche 1: Kinematik
                Bewegungsgleichungen
                Woche 2: Newtonsche Axiome
                Woche 3: Energie und Arbeit
                """;
        var result = SyllabusParser.parseDocument(one(text), null);
        assertEquals(3, result.units().size());
        assertTrue(result.units().get(0).topics().contains("Bewegungsgleichungen"));
    }
}
