package com.studyos.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.ingestion.Chunk;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The concept graph is built from what this class reads out of ordinary course prose, so a misread cue puts a
 * false edge into durable state — and edges order the plan, gate the ladder and pick remediation.
 *
 * <p>The failures guarded hardest are direction and over-reach. A relation pointing the wrong way teaches a course
 * backwards, which is why every new type is asserted with both endpoints named rather than by type alone. And a
 * bare co-mention must never be promoted: two topics in one sentence with nothing said between them is a
 * {@code RELATED_TO} at most, and never survives beside a stated relation on the same pair.
 *
 * <p>Subjects are mixed on purpose — routing, contract law, biology, physics, logic. The cues are English
 * structure and the topic names are the course's own; no subject vocabulary is known to the extractor, and a
 * course it has never seen has to come out the same.
 */
class TopicRelationExtractorTest {
    private final TopicRelationExtractor extractor = new TopicRelationExtractor();

    private Chunk chunk(String text) { return new Chunk(UUID.randomUUID(), 0, 4, 5, text, 20); }

    @Test
    void emitsDirectedPrerequisitesWithProvenance() {
        Chunk chunk = chunk("Dijkstra's algorithm relies on shortest paths.");

        var relations = extractor.extract(chunk, List.of("Shortest Paths", "Dijkstra Algorithm", "Routing"));

        assertThat(relations).anySatisfy(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Shortest Paths");
            assertThat(relation.targetName()).isEqualTo("Dijkstra Algorithm");
            assertThat(relation.type()).isEqualTo(TopicRelationType.PREREQUISITE_OF);
            assertThat(relation.sourceChunkId()).isEqualTo(chunk.id());
        });
    }

    @Test
    void readsSupportingWordingInTheOtherDirection() {
        var relations = extractor.extract(chunk("Shortest Paths is required for Routing."), List.of("Shortest Paths", "Routing"));

        assertThat(relations).singleElement().satisfies(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Shortest Paths");
            assertThat(relation.targetName()).isEqualTo("Routing");
            assertThat(relation.type()).isEqualTo(TopicRelationType.PREREQUISITE_OF);
        });
    }

    @Test
    void findsPrerequisitesInAnySubject() {
        var biology = extractor.extract(chunk("Protein synthesis depends on transcription."), List.of("Protein Synthesis", "Transcription"));
        var law = extractor.extract(chunk("A valid contract requires consideration."), List.of("Valid Contract", "Consideration"));
        var chemistry = extractor.extract(chunk("Titration uses molarity throughout."), List.of("Titration", "Molarity"));

        assertThat(biology).singleElement().satisfies(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Transcription");
            assertThat(relation.targetName()).isEqualTo("Protein Synthesis");
            assertThat(relation.type()).isEqualTo(TopicRelationType.PREREQUISITE_OF);
        });
        assertThat(law).anySatisfy(relation -> assertThat(relation.sourceName()).isEqualTo("Consideration"));
        assertThat(chemistry).anySatisfy(relation -> assertThat(relation.sourceName()).isEqualTo("Molarity"));
    }

    @Test
    void matchesPluralAndPossessiveSpellings() {
        var relations = extractor.extract(chunk("Newton's second law follows from conservation of momentum."),
                List.of("Newton Second Law", "Conservation of Momentum"));

        assertThat(relations).anySatisfy(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Conservation of Momentum");
            assertThat(relation.targetName()).isEqualTo("Newton Second Law");
        });
    }

    @Test
    void keepsOnlyThePrerequisiteWhenAPairAlsoLooksMerelyRelated() {
        var relations = extractor.extract(chunk("Routing and shortest paths. Routing relies on shortest paths."),
                List.of("Routing", "Shortest Paths"));

        assertThat(relations).allSatisfy(relation -> assertThat(relation.type()).isEqualTo(TopicRelationType.PREREQUISITE_OF));
    }

    @Test
    void doesNotInferRelationsFromTopicsTheCourseDoesNotHave() {
        assertThat(extractor.extract(chunk("Fair scheduling is discussed without routing algorithms."), List.of("Shortest Paths"))).isEmpty();
        assertThat(extractor.extract(chunk("Routing relies on shortest paths."), List.of())).isEmpty();
    }

    @Test
    void ignoresUnrelatedTopicsMentionedFarApart() {
        String text = "Routing is introduced in this lecture together with many other unrelated remarks that separate it clearly "
                + "from the later discussion of shortest paths.";

        assertThat(extractor.extract(chunk(text), List.of("Routing", "Shortest Paths"))).isEmpty();
    }

    /**
     * Composition, in the direction the sentence states it. A course that says a topic is one of another's elements
     * has said something the graph could not hold before this: the pair is neither a dependency nor a co-mention.
     */
    @Test
    void readsOneTopicAsAPieceOfAnother() {
        var relations = extractor.extract(chunk("Consideration is an element of a valid contract."), List.of("Consideration", "Valid Contract"));

        assertThat(relations).singleElement().satisfies(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Consideration");
            assertThat(relation.targetName()).isEqualTo("Valid Contract");
            assertThat(relation.type()).isEqualTo(TopicRelationType.PART_OF);
        });
    }

    /**
     * The same relation written from the whole's side. Both wordings have to land on one stored direction, or a
     * document that decomposes a process and one that places its stages would build two unrelated graphs.
     */
    @Test
    void readsCompositionFromTheWholesSideToo() {
        var fromTheWhole = extractor.extract(chunk("Cell respiration consists of glycolysis."), List.of("Cell Respiration", "Glycolysis"));
        var fromThePart = extractor.extract(chunk("Glycolysis is contained in cell respiration."), List.of("Cell Respiration", "Glycolysis"));

        assertThat(fromTheWhole).singleElement().satisfies(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Glycolysis");
            assertThat(relation.targetName()).isEqualTo("Cell Respiration");
            assertThat(relation.type()).isEqualTo(TopicRelationType.PART_OF);
        });
        assertThat(fromThePart).singleElement().satisfies(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Glycolysis");
            assertThat(relation.targetName()).isEqualTo("Cell Respiration");
        });
    }

    /**
     * Extension wording, which used to be stored as a plain dependency. The type is new; the learning order is not
     * — the base is still the topic that comes first, which is what {@code topic_prerequisites} reads it as.
     */
    @Test
    void readsOneTopicAsAnotherTakenFurther() {
        var relations = extractor.extract(chunk("Quantum mechanics extends classical mechanics."), List.of("Quantum Mechanics", "Classical Mechanics"));

        assertThat(relations).singleElement().satisfies(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Quantum Mechanics");
            assertThat(relation.targetName()).isEqualTo("Classical Mechanics");
            assertThat(relation.type()).isEqualTo(TopicRelationType.BUILDS_ON);
        });
    }

    /** Extension stated from the base's side, which points the other way and must be stored the other way. */
    @Test
    void readsExtensionStatedFromTheBasesSide() {
        var relations = extractor.extract(chunk("Propositional logic generalizes to predicate logic."), List.of("Propositional Logic", "Predicate Logic"));

        assertThat(relations).singleElement().satisfies(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Predicate Logic");
            assertThat(relation.targetName()).isEqualTo("Propositional Logic");
            assertThat(relation.type()).isEqualTo(TopicRelationType.BUILDS_ON);
        });
    }

    /**
     * Comparison, and the endpoint order that makes it one edge. A symmetric relation stored as the sentence
     * happened to mention it would be two edges for one fact, doubling the pair's weight wherever edges are
     * counted — so both phrasings, in either order, have to come out identical.
     */
    @Test
    void storesAComparisonOncePerPairWhicheverWayItIsWritten() {
        var confused = extractor.extract(chunk("Mitosis is often confused with meiosis."), List.of("Mitosis", "Meiosis"));
        var contrasted = extractor.extract(chunk("Meiosis differs from mitosis."), List.of("Mitosis", "Meiosis"));

        assertThat(confused).singleElement().satisfies(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Meiosis");
            assertThat(relation.targetName()).isEqualTo("Mitosis");
            assertThat(relation.type()).isEqualTo(TopicRelationType.COMPARES_WITH);
        });
        assertThat(contrasted).singleElement().satisfies(relation -> {
            assertThat(relation.sourceName()).isEqualTo("Meiosis");
            assertThat(relation.targetName()).isEqualTo("Mitosis");
        });
    }

    /**
     * The suppression rule generalised past prerequisites. Any stated relation beats a bare co-mention of the same
     * pair, or a graph would carry "these two words appeared together" beside the sentence that said what they
     * actually are.
     */
    @Test
    void dropsABareCoMentionWhenAnyStatedRelationCoversThePair() {
        var relations = extractor.extract(chunk("Glycolysis and cell respiration. Cell respiration consists of glycolysis."),
                List.of("Glycolysis", "Cell Respiration"));

        assertThat(relations).allSatisfy(relation -> assertThat(relation.type()).isEqualTo(TopicRelationType.PART_OF));
    }

    /**
     * When one passage yields more relations than a chunk may contribute, the ones dropped are the weakest.
     * Discovery order alone would let six co-mentions early in a page push out the one sentence that stated a
     * dependency — the edge the ladder gates on.
     */
    @Test
    void keepsStatedRelationsWhenAChunkYieldsMoreThanItsShare() {
        String text = "Alpha and beta. Gamma and delta. Epsilon and zeta. Kappa and lambda. Omega and sigma. Rho and tau. Chi relies on psi.";
        List<String> topics = List.of("Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Kappa", "Lambda", "Omega", "Sigma", "Rho", "Tau", "Chi", "Psi");

        var relations = extractor.extract(chunk(text), topics);

        assertThat(relations).hasSize(6);
        assertThat(relations.get(0).type()).isEqualTo(TopicRelationType.PREREQUISITE_OF);
        assertThat(relations.get(0).sourceName()).isEqualTo("Psi");
        assertThat(relations).filteredOn(relation -> relation.type() == TopicRelationType.RELATED_TO).hasSize(5);
        assertThat(relations).noneMatch(relation -> relation.targetName().equals("Tau") || relation.sourceName().equals("Tau"));
    }

    /** Confidence descends with how much the wording commits, and never leaves the range the column allows. */
    @Test
    void gradesConfidenceByHowMuchTheWordingCommits() {
        double dependency = only(extractor.extract(chunk("Routing relies on shortest paths."), List.of("Routing", "Shortest Paths"))).confidence();
        double part = only(extractor.extract(chunk("Glycolysis is part of cell respiration."), List.of("Glycolysis", "Cell Respiration"))).confidence();
        double extension = only(extractor.extract(chunk("Quantum mechanics extends classical mechanics."), List.of("Quantum Mechanics", "Classical Mechanics"))).confidence();
        double comparison = only(extractor.extract(chunk("Mitosis is often confused with meiosis."), List.of("Mitosis", "Meiosis"))).confidence();
        double coMention = only(extractor.extract(chunk("Routing and shortest paths."), List.of("Routing", "Shortest Paths"))).confidence();

        assertThat(dependency).isGreaterThan(part);
        assertThat(part).isGreaterThan(extension);
        assertThat(extension).isGreaterThan(comparison);
        assertThat(comparison).isGreaterThan(coMention);
        assertThat(coMention).isBetween(0.0, 1.0);
    }

    /** The same passage must always give the same edges; nothing here may depend on a set's iteration order. */
    @Test
    void isRepeatableForTheSamePassage() {
        Chunk chunk = chunk("Cell respiration consists of glycolysis. Glycolysis is often confused with fermentation. Fermentation relies on glycolysis.");
        List<String> topics = List.of("Cell Respiration", "Glycolysis", "Fermentation");

        assertThat(extractor.extract(chunk, topics)).isEqualTo(extractor.extract(chunk, topics));
    }

    private TopicRelationExtractor.Candidate only(List<TopicRelationExtractor.Candidate> candidates) {
        assertThat(candidates).hasSize(1);
        return candidates.get(0);
    }
}
