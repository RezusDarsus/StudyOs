package com.studyos.knowledge;

import com.studyos.ingestion.Chunk;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Locale;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The cross-subject matrix. Every fixture below is written the way the subject actually writes,
 * and the same three assertions are made of each: the generic signal extractor finds the concepts
 * the material is about, the generic relation extractor reads the stated relation and its
 * direction, and the registry folds the spellings together. If any of that needed distributed
 * systems vocabulary, the physics or the history fixtures would fail.
 */
class CrossSubjectKnowledgePipelineTest {

    // ---- fixtures: one structured passage per subject family -----------------------------------

    private static final String CS = """
            # Transactions
            A transaction is a sequence of operations that executes as one unit.
            ## Isolation Levels
            Serializability is defined as the correctness criterion that isolation levels aim at.
            Weak isolation levels depend on serializability to keep anomalies out.
            """;

    private static final String MATH = """
            # Functions
            A function is a rule that assigns each input exactly one output.
            ## Derivatives
            The derivative measures how a function changes.
            ## Gradient
            The gradient relies on the derivative of a function in many variables.
            """;

    private static final String PHYSICS = """
            # Velocity
            Velocity is the rate of change of position.
            ## Acceleration
            Acceleration is the rate of change of velocity.
            Newton's second law uses acceleration and requires velocity.
            """;

    private static final String BIOLOGY = """
            # DNA
            DNA is the molecule that carries genetic information.
            ## Transcription
            Transcription is the synthesis of RNA from DNA.
            Transcription depends on DNA and on the enzymes that unwind it.
            ## Translation
            Translation is the synthesis of protein from RNA.
            Translation uses transcription as its template.
            """;

    private static final String HISTORY = """
            # World War I
            World War I reshaped the political order of Europe.
            ## Treaty of Versailles
            The Treaty of Versailles formalised the end of World War I, and it led to the post-war political consequences.
            The post-war political consequences are part of the interwar period.
            """;

    private static final String ECONOMICS = """
            # Supply and Demand
            Supply and demand is the model of price formation in markets.
            ## Elasticity
            Elasticity is computed from supply and demand curves.
            ## Price Controls
            Price controls are applied in regulated markets and presupposes elasticity.
            """;

    private static Chunk chunk(String content) {
        return new Chunk(UUID.randomUUID(), 0, 1, 1, content, content.length() / 4);
    }

    private static List<String> extractSignalNames(String text) {
        return TopicSignalExtractor.extract(text, 12).stream().map(candidate -> TopicRegistry.normalize(candidate.name())).toList();
    }

    private static List<TopicRelationExtractor.Candidate> relations(String content, String... known) {
        return new TopicRelationExtractor().extract(chunk(content), List.of(known));
    }

    // ---- every subject: signal extraction is subject-neutral -----------------------------------

    @Test
    void signalsSurfaceCoreConceptsInEverySubject() {
        assertTrue(anyContains(extractSignalNames(CS), "transaction", "isolation levels", "serializability"), "CS signals: " + extractSignalNames(CS));
        assertTrue(anyContains(extractSignalNames(MATH), "function", "derivative", "gradient"), "math signals: " + extractSignalNames(MATH));
        assertTrue(anyContains(extractSignalNames(PHYSICS), "velocity", "acceleration"), "physics signals: " + extractSignalNames(PHYSICS));
        assertTrue(anyContains(extractSignalNames(BIOLOGY), "dna", "transcription", "translation"), "biology signals: " + extractSignalNames(BIOLOGY));
        assertTrue(anyContains(extractSignalNames(HISTORY), "world war i", "treaty of versailles"), "history signals: " + extractSignalNames(HISTORY));
        assertTrue(anyContains(extractSignalNames(ECONOMICS), "supply and demand", "elasticity"), "economics signals: " + extractSignalNames(ECONOMICS));
    }

    private static boolean anyContains(List<String> found, String... expected) {
        for (String wanted : expected) {
            boolean matched = found.stream().anyMatch(name -> name.equals(wanted) || name.startsWith(wanted));
            if (!matched) return false;
        }
        return true;
    }

    // ---- every subject: relation extraction reads structural wording, not subject words ---------

    @Test
    void dependencyWordingYieldsPrerequisiteEdgesInEverySubject() {
        // "weak isolation levels depend on serializability" — serializability is the foundation.
        assertEquals(TopicRelationType.PREREQUISITE_OF, typeOf(relations(CS, "transactions", "isolation levels", "serializability"), "serializability", "isolation levels"));
        // "the gradient ... relies on the derivative" — the derivative comes first.
        assertEquals(TopicRelationType.PREREQUISITE_OF, typeOf(relations(MATH, "function", "derivative", "gradient"), "derivative", "gradient"));
        // "Newton's second law uses acceleration" — the law is stated with acceleration as its base.
        assertEquals(TopicRelationType.PREREQUISITE_OF, typeOf(relations(PHYSICS, "velocity", "acceleration", "Newton's second law"), "acceleration", "Newton's second law"));
        // ... and "requires velocity" in the same passage makes velocity the base of acceleration.
        assertEquals(TopicRelationType.PREREQUISITE_OF, typeOf(relations(PHYSICS, "velocity", "acceleration", "Newton's second law"), "velocity", "acceleration"));
        // "transcription ... depends on DNA".
        assertEquals(TopicRelationType.PREREQUISITE_OF, typeOf(relations(BIOLOGY, "dna", "transcription", "translation"), "dna", "transcription"));
        // "translation ... uses transcription".
        assertEquals(TopicRelationType.PREREQUISITE_OF, typeOf(relations(BIOLOGY, "dna", "transcription", "translation"), "transcription", "translation"));
        // "price controls ... presupposes elasticity".
        assertEquals(TopicRelationType.PREREQUISITE_OF, typeOf(relations(ECONOMICS, "supply and demand", "elasticity", "price controls"), "elasticity", "price controls"));
    }

    @Test
    void containmentAndComparisonWordingYieldsTheirOwnEdges() {
        // History containment: "the post-war political consequences are part of the interwar period".
        var historyRelations = relations(HISTORY, "world war i", "treaty of versailles", "post-war political consequences", "interwar period");
        assertEquals(TopicRelationType.PART_OF, typeOf(historyRelations, "post-war political consequences", "interwar period"));
        // Economics structural dependency: "elasticity is computed from supply and demand".
        var economicsRelations = relations(ECONOMICS, "supply and demand", "elasticity");
        assertEquals(TopicRelationType.PREREQUISITE_OF, typeOf(economicsRelations, "supply and demand", "elasticity"));
        // Physics: "acceleration is the rate of change of velocity" reads as a dependency the other way round.
        var physicsRelations = relations(PHYSICS, "velocity", "acceleration", "newton s second law");
        assertTrue(physicsRelations.stream().anyMatch(candidate -> candidate.type() == TopicRelationType.PREREQUISITE_OF),
                "physics fixture should state at least one dependency");
    }

    @Test
    void relationsKeepTheDirectionTheSentenceStated() {
        var math = relations(MATH, "function", "derivative", "gradient");
        assertTrue(math.stream().anyMatch(candidate -> candidate.type() == TopicRelationType.PREREQUISITE_OF
                        && TopicRegistry.normalize(candidate.sourceName()).startsWith("derivative")
                        && TopicRegistry.normalize(candidate.targetName()).startsWith("gradient")),
                "the derivative is the foundation of the gradient, and the edge must say so: " + math);
    }

    // ---- topic identity across every subject ---------------------------------------------------

    @Test
    void normalizationFoldsSpellingsTogetherInEverySubject() {
        assertEquals(TopicRegistry.normalize("Lamport clock"), TopicRegistry.normalize("Lamport  clock."));
        assertEquals(TopicRegistry.normalize("DNA"), TopicRegistry.normalize("dna"));
        assertEquals(TopicRegistry.normalize("Treaty of Versailles"), TopicRegistry.normalize("treaty  of  versailles"));
        // Singular and plural fold at the identity stage, not in the raw normalisation.
        assertEquals(TopicRegistry.singularForm("lamport clocks"), TopicRegistry.singularForm("lamport clock"));
        assertEquals(TopicRegistry.singularForm("isolation levels"), TopicRegistry.singularForm("isolation level"));
        assertEquals(TopicRegistry.singularForm("velocity"), TopicRegistry.singularForm("velocities"));
        // ... and safe folding declines to touch words where stripping an s would lie.
        assertEquals("analysis", TopicRegistry.singularForm("analysis"));
        assertEquals("class", TopicRegistry.singularForm("class"));
        assertEquals("newton s second law", TopicRegistry.singularForm("newton s second law"));
        // ... but genuinely different concepts stay different, in every subject.
        assertFalse(TopicRegistry.normalize("supply and demand").equals(TopicRegistry.normalize("demand curve")));
        assertFalse(TopicRegistry.normalize("velocity").equals(TopicRegistry.normalize("acceleration")));
        assertFalse(TopicRegistry.normalize("transcription").equals(TopicRegistry.normalize("translation")));
    }

    @Test
    void extensionWordingIsItsOwnRelationInEverySubject() {
        // "X generalizes/extends Y" is deliberately not PREREQUISITE_OF: the vocabulary records it as
        // BUILDS_ON (V41), and the topic_prerequisites view flips the endpoints so the learning order
        // still puts the base first. The extractor must keep that wording out of plain dependency.
        var math = relations(MATH + "\nThe gradient extends the derivative to many variables.\n", "function", "derivative", "gradient");
        assertEquals(TopicRelationType.BUILDS_ON, typeOf(math, "gradient", "derivative"));
        var physics = relations(PHYSICS + "\nMomentum extends velocity into a conserved quantity.\n", "velocity", "acceleration", "momentum");
        assertEquals(TopicRelationType.BUILDS_ON, typeOf(physics, "momentum", "velocity"));
    }

    // ---- objectives across every subject --------------------------------------------------------

    @Test
    void objectiveSentencesAreReadInEverySubject() {
        String outcomes = """
                Learning objectives
                - Explain why transaction isolation is required
                - Differentiate READ COMMITTED and SERIALIZABLE
                """;
        var objectives = ObjectiveExtractor.extract(outcomes);
        assertFalse(objectives.isEmpty(), "CS-style objectives should be recognised");
        assertTrue(objectives.stream().anyMatch(objective -> objective.statement().toLowerCase(Locale.ROOT).contains("isolation")));

        String biologyOutcomes = """
                Objectives
                - Describe the process of transcription
                """;
        var biologyObjectives = ObjectiveExtractor.extract(biologyOutcomes);
        assertTrue(biologyObjectives.stream().anyMatch(objective -> objective.statement().toLowerCase(Locale.ROOT).contains("transcription")));
    }

    // ---- helpers --------------------------------------------------------------------------------

    private static TopicRelationType typeOf(List<TopicRelationExtractor.Candidate> candidates, String expectedSource, String expectedTarget) {
        String foldedSource = TopicRegistry.normalize(expectedSource);
        String foldedTarget = TopicRegistry.normalize(expectedTarget);
        return candidates.stream()
                .filter(candidate -> TopicRegistry.normalize(candidate.sourceName()).startsWith(foldedSource)
                        && TopicRegistry.normalize(candidate.targetName()).startsWith(foldedTarget))
                .map(TopicRelationExtractor.Candidate::type)
                .findFirst()
                .orElseThrow(() -> new AssertionError("no relation found from " + expectedSource + " to " + expectedTarget + " in " + candidates));
    }
}
