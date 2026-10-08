package com.studyos.research;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ResearchQueryPlannerTest {

    private final ResearchQueryPlanner planner = new ResearchQueryPlanner();

    @Test
    void theSameGoalAlwaysPlansTheSameQueries() {
        assertEquals(planner.plan("Learn Kubernetes", 8), planner.plan("Learn Kubernetes", 8));
    }

    @Test
    void thePlanNeverExceedsItsBound() {
        assertTrue(planner.plan("Learn Kubernetes", 5).size() <= 5);
        assertTrue(planner.plan("Learn Kubernetes", 1).size() <= 1);
    }

    @Test
    void aGoalExpandsAcrossDistinctKindsOfMaterial() {
        List<String> queries = planner.plan("Learn Kubernetes", 10);
        assertTrue(queries.size() > 1, "one query cannot cover a course: " + queries);
        assertTrue(queries.contains("kubernetes"), "the plain goal itself is the first query: " + queries);
        long distinct = queries.stream().distinct().count();
        assertEquals(queries.size(), distinct, "queries must be distinct");
    }

    @Test
    void verbFightingIsStrippedBeforeSearching() {
        assertEquals("spring boot", planner.subject("I want to learn Spring Boot from scratch"));
        assertEquals("linear algebra", planner.subject("Understand linear algebra"));
        assertEquals("organic chemistry", planner.subject("teach me organic chemistry basics"));
    }

    @Test
    void everySubjectGetsTheSameTreatment() {
        // The planner is subject-neutral: a self-study goal in law or biology plans exactly the way
        // a software goal does, and none of the aspects name a subject.
        List<String> law = planner.plan("Master contract law", 6);
        List<String> biology = planner.plan("Understand cell biology", 6);
        assertEquals(law.size(), biology.size());
        assertTrue(law.stream().allMatch(query -> query.contains("contract law")));
        assertTrue(biology.stream().allMatch(query -> query.contains("cell biology")));
    }

    @Test
    void anEmptyGoalPlansNothing() {
        assertTrue(planner.plan("", 5).isEmpty());
        assertTrue(planner.plan(null, 5).isEmpty());
    }
}
