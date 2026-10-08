package com.studyos.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import com.studyos.knowledge.TopicSignalExtractor.Candidate;
import com.studyos.knowledge.TopicSignalExtractor.Signal;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Topic extraction is where StudyOS learns what a course is about, and it has to work for a course
 * nobody anticipated. So these tests deliberately mix biology, law, chemistry, statistics, economics
 * and invented vocabulary: every one of them has to be found by the same structural rules, because a
 * built-in list of concepts would only ever fit one syllabus.
 *
 * <p>The other half of the job is restraint. A heading that says "Chapter 3" or "Exercise 2" describes
 * the document, not something to learn, and proposing it would pollute the curriculum graph with
 * scaffolding the student can never master.
 */
class TopicSignalExtractorTest {

    @Test
    void findsTheDefinedTermInAnySubject() {
        assertThat(TopicSignalExtractor.extract("A cell membrane is a selectively permeable barrier."))
                .extracting(Candidate::name, Candidate::signal)
                .containsExactly(tuple("cell membrane", Signal.DEFINITION));
        assertThat(TopicSignalExtractor.extract("Consideration refers to something of value exchanged between the parties."))
                .extracting(Candidate::name)
                .containsExactly("Consideration");
        assertThat(TopicSignalExtractor.extract("Definition 2.1 (Le Chatelier's Principle): a system at equilibrium shifts to oppose the change."))
                .extracting(Candidate::name)
                .containsExactly("Le Chatelier's Principle");
    }

    /** Nonsense terms prove the mechanism is structural: no vocabulary list could contain these. */
    @Test
    void extractsATermThatCouldNotBeInAnyBuiltInVocabulary() {
        List<Candidate> candidates = TopicSignalExtractor.extract("Zylophage transduction refers to a two-stage exchange of carriers.");

        assertThat(candidates).extracting(Candidate::name).containsExactly("Zylophage transduction");
    }

    @Test
    void identicalStructureYieldsIdenticalEvidenceAcrossSubjects() {
        List<Candidate> biology = TopicSignalExtractor.extract("# Mitosis\nMitosis refers to nuclear division producing two identical nuclei.");
        List<Candidate> law = TopicSignalExtractor.extract("# Estoppel\nEstoppel refers to a bar on retracting a promise that was relied upon.");

        assertThat(biology).extracting(Candidate::name).containsExactly("Mitosis");
        assertThat(law).extracting(Candidate::name).containsExactly("Estoppel");
        assertThat(biology.getFirst().signal()).isEqualTo(law.getFirst().signal());
        assertThat(biology.getFirst().confidence()).isEqualTo(law.getFirst().confidence());
    }

    @Test
    void readsHeadingsInTheFormsCourseMaterialActuallyUses() {
        String notes = """
                # Photosynthesis
                Chapter 4 — Enzyme Kinetics
                3.2 Michaelis-Menten equation
                """;

        assertThat(TopicSignalExtractor.extract(notes))
                .extracting(Candidate::name)
                .containsExactly("Photosynthesis", "Enzyme Kinetics", "Michaelis-Menten equation");
    }

    @Test
    void restoresReadableCasingForAllCapsHeadings() {
        String slide = """
                CENTRAL LIMIT THEOREM
                The sample mean of many independent draws tends toward a normal distribution.
                """;

        assertThat(TopicSignalExtractor.extract(slide))
                .extracting(Candidate::name, Candidate::signal)
                .containsExactly(tuple("Central Limit Theorem", Signal.HEADING));
    }

    @Test
    void documentScaffoldingIsNeverProposedAsATopic() {
        String frontMatter = """
                Chapter 3
                EXERCISE 2
                Homework 4
                Summary
                1. Introduction
                Solutions
                """;

        assertThat(TopicSignalExtractor.extract(frontMatter)).isEmpty();
    }

    @Test
    void aPhraseMentionedOnceIsNotEvidenceButATwiceRepeatedOneIs() {
        assertThat(TopicSignalExtractor.extract("Judicial Review limits statutory power.")).isEmpty();

        assertThat(TopicSignalExtractor.extract("Judicial Review limits statutory power. Later cases narrowed Judicial Review again."))
                .extracting(Candidate::name, Candidate::signal)
                .containsExactly(tuple("Judicial Review", Signal.REPEATED_TERM));
    }

    @Test
    void twoIndependentSignalsOutweighTheStrongestSingleOne() {
        List<Candidate> candidates = TopicSignalExtractor.extract("# Osmosis\nOsmosis refers to the movement of solvent across a semipermeable membrane.");

        assertThat(candidates).hasSize(1);
        assertThat(candidates.getFirst().name()).isEqualTo("Osmosis");
        assertThat(candidates.getFirst().signal()).isEqualTo(Signal.DEFINITION);
        assertThat(candidates.getFirst().confidence())
                .as("a heading corroborated by a definition is worth more than either alone, but never certainty")
                .isGreaterThan(Signal.DEFINITION.confidence())
                .isLessThanOrEqualTo(.9);
    }

    @Test
    void returnsTheStrongestCandidatesFirstAndHonoursTheLimit() {
        String lecture = """
                # Nash Equilibrium
                Nash Equilibrium refers to a strategy profile where no player benefits from deviating.
                **Dominant strategy** removal simplifies the game.
                Repeated Game analysis extends this. Repeated Game payoffs depend on discounting.
                """;

        List<Candidate> candidates = TopicSignalExtractor.extract(lecture);

        assertThat(candidates).extracting(Candidate::name).containsExactly("Nash Equilibrium", "Dominant strategy", "Repeated Game");
        assertThat(candidates.get(0).confidence()).isGreaterThan(candidates.get(1).confidence());
        assertThat(candidates.get(1).confidence()).isGreaterThan(candidates.get(2).confidence());
        assertThat(TopicSignalExtractor.extract(lecture, 2)).extracting(Candidate::name).containsExactly("Nash Equilibrium", "Dominant strategy");
    }

    @Test
    void emptyInputProducesNoCandidates() {
        assertThat(TopicSignalExtractor.extract(null)).isEmpty();
        assertThat(TopicSignalExtractor.extract("")).isEmpty();
        assertThat(TopicSignalExtractor.extract("   \n\t  \n")).isEmpty();
        assertThat(TopicSignalExtractor.extract("# Osmosis", 0)).as("a nonsensical limit still returns something usable").hasSize(1);
    }

    @Test
    void trimsThePackagingAPhraseArrivesIn() {
        assertThat(TopicSignalExtractor.clean("  ## The Krebs Cycle:  ")).isEqualTo("Krebs Cycle");
        assertThat(TopicSignalExtractor.clean("• the law of demand")).as("only dangling function words go, not the ones holding the phrase together").isEqualTo("law of demand");
        assertThat(TopicSignalExtractor.clean("ENTROPY")).isEqualTo("Entropy");
        assertThat(TopicSignalExtractor.clean("of the")).isEmpty();
    }

    @Test
    void rejectsNamesThatCannotBeATopic() {
        assertThat(TopicSignalExtractor.acceptable("Week 3")).isFalse();
        assertThat(TopicSignalExtractor.acceptable("2024")).as("a bare number is a label, not a concept").isFalse();
        assertThat(TopicSignalExtractor.acceptable("of")).isFalse();
        assertThat(TopicSignalExtractor.acceptable(null)).isFalse();
        assertThat(TopicSignalExtractor.acceptable("a very long chain of eight or more words in a heading like this one")).isFalse();
        assertThat(TopicSignalExtractor.acceptable("Hydrostatic equilibrium")).isTrue();
    }
}
