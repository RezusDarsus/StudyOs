package com.studyos.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import com.studyos.knowledge.ObjectiveExtractor.Cue;
import com.studyos.knowledge.ObjectiveExtractor.Objective;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * An objective is what "knowing this topic" means, so it is what assessment generates against and what mastery is
 * measured against. Getting one wrong aims a whole exercise wrongly, which is why the two failures tested hardest
 * here are over-reach and mis-levelling: a table-of-contents line under a heading called "Goals" must not become
 * something a learner is graded on, and a verb the lists do not know must leave the level null rather than guessed.
 *
 * <p>The subjects are mixed on purpose — coding theory, contract law, biology, and invented vocabulary. The verbs
 * ("define", "compare", "prove") are pedagogical and the same for every course; the nouns are not, and none of them
 * may need to be known for the objective to be found. A course this file has never heard of has to work the same.
 */
class ObjectiveExtractorTest {

    /** The commonest phrasing, stripped of the sentence that introduced it and levelled by its verb. */
    @Test
    void findsAStatedOutcomeAndReadsItsLevelFromTheVerb() {
        List<Objective> found = ObjectiveExtractor.extract(
                "By the end of this section, students should be able to explain why the parity check matrix is orthogonal to every codeword.");
        assertThat(found).extracting(Objective::statement, Objective::cognitiveLevel, Objective::cue)
                .containsExactly(tuple("Explain why the parity check matrix is orthogonal to every codeword.", 2, Cue.STATED_OUTCOME));
    }

    /**
     * One objective written two ways is stored once. Both phrasings reduce to the same clause, which is the whole
     * reason the introducing sentence is thrown away rather than kept.
     */
    @Test
    void storesOneFormForOneObjectiveHoweverItIsPhrased() {
        List<Objective> found = ObjectiveExtractor.extract("""
                By the end of this chapter you will be able to compute the syndrome of a received word.
                Students should be able to properly compute the syndrome of a received word.
                """);
        assertThat(found).extracting(Objective::statement).containsExactly("Compute the syndrome of a received word.");
    }

    /** A sentence that states no outcome is not an objective, however much course prose surrounds it. */
    @Test
    void ignoresOrdinaryProse() {
        assertThat(ObjectiveExtractor.extract("""
                The syndrome of a received word is defined as its product with the parity check matrix.
                This chapter assumes familiarity with finite fields.
                Table 3.2 lists the generator polynomials used throughout.
                """)).isEmpty();
        assertThat(ObjectiveExtractor.extract("")).isEmpty();
        assertThat(ObjectiveExtractor.extract(null)).isEmpty();
    }

    /** A list under an objectives heading, each item levelled, with the list ending where it ends. */
    @Test
    void collectsAListUnderAnObjectivesHeading() {
        List<Objective> found = ObjectiveExtractor.extract("""
                2.1 Learning Objectives
                - Define a linear block code over a finite field.
                - Compute the syndrome of a received word.
                - Prove that the minimum distance determines the correctable error count.
                The remainder of this section develops the decoding algorithm.
                """);
        assertThat(found).extracting(Objective::cognitiveLevel).containsExactly(1, 3, 6);
        assertThat(found).extracting(Objective::cue).containsOnly(Cue.OBJECTIVES_LIST);
        assertThat(found).extracting(Objective::statement).containsExactly("Define a linear block code over a finite field.",
                "Compute the syndrome of a received word.", "Prove that the minimum distance determines the correctable error count.");
    }

    /**
     * The restraint half. A contents list under a heading called "Goals" is still a contents list, and promoting
     * its entries would grade a learner on "Introduction to algebraic structures".
     */
    @Test
    void refusesListItemsThatAreNotSomethingToDo() {
        List<Objective> found = ObjectiveExtractor.extract("""
                Chapter Goals
                - Introduction to algebraic structures
                - Chapter 4
                - The Hamming bound and its consequences
                - Prove the Hamming bound for binary codes.
                """);
        assertThat(found).extracting(Objective::statement).containsExactly("Prove the Hamming bound for binary codes.");
    }

    /**
     * A blank line inside a list is a PDF extraction artefact, not the end of the list; two in a row are the end.
     * Stopping at the first would find one objective out of eight in a typical extracted lecture handout.
     */
    @Test
    void readsThroughASingleBlankLineButStopsAtTwo() {
        List<Objective> found = ObjectiveExtractor.extract("""
                Objectives:
                - Define a group.

                - Explain a ring homomorphism.


                - Prove the first isomorphism theorem.
                """);
        assertThat(found).extracting(Objective::statement).containsExactly("Define a group.", "Explain a ring homomorphism.");
    }

    /** A heading with a hundred bullets under it is being parsed wrongly; the list is bounded. */
    @Test
    void boundsHowManyItemsOneListMayContribute() {
        StringBuilder text = new StringBuilder("Learning Outcomes\n");
        for (int index = 0; index < 20; index++) text.append("- Define the closure property of set ").append(index).append('\n');
        assertThat(ObjectiveExtractor.extract(text.toString())).hasSize(12);
    }

    /**
     * The other stated-outcome phrasing, and the promise that an unrecognised verb keeps a null level. "Understand"
     * is deliberately absent from the lists — it names no observable act — and guessing a level for it would aim
     * every question generated from this objective at a level nobody stated.
     */
    @Test
    void keepsTheLevelNullWhenTheVerbIsNotPedagogicalVocabulary() {
        List<Objective> found = ObjectiveExtractor.extract("Students will understand the difference between systematic and non-systematic encoders.");
        assertThat(found).extracting(Objective::statement, Objective::cognitiveLevel)
                .containsExactly(tuple("Understand the difference between systematic and non-systematic encoders.", null));
    }

    /** Only the opening words carry the level: a verb further in belongs to the thing being done to. */
    @Test
    void levelsOnTheLeadingVerbNotTheDeepestOne() {
        assertThat(ObjectiveExtractor.level("Explain how to compute the syndrome")).isEqualTo(2);
        assertThat(ObjectiveExtractor.level("Describe how to prove the bound")).isEqualTo(2);
        assertThat(ObjectiveExtractor.level("Prove that the bound is tight")).isEqualTo(6);
        assertThat(ObjectiveExtractor.level("Compare void and voidable agreements")).isEqualTo(4);
        assertThat(ObjectiveExtractor.level("Zorbify the quantum manifold")).isNull();
        assertThat(ObjectiveExtractor.level("")).isNull();
        assertThat(ObjectiveExtractor.level(null)).isNull();
    }

    /**
     * Inflected verbs reach their base form. Both English conjugation classes are covered because the surface form
     * does not say which one a word belongs to — an earlier stemmer turned "explaining" into "explaine" and levelled
     * nothing.
     */
    @Test
    void readsInflectedVerbs() {
        assertThat(ObjectiveExtractor.level("Explaining the tradeoff between rate and distance")).isEqualTo(2);
        assertThat(ObjectiveExtractor.level("Defines the alphabet of the code")).isEqualTo(1);
        assertThat(ObjectiveExtractor.level("Illustrated with a worked example")).isEqualTo(2);
        assertThat(ObjectiveExtractor.level("Computed from the generator matrix")).isEqualTo(3);
    }

    /**
     * A source that already knows it holds objectives is not second-guessed on the verb. The instructor calling it
     * an objective is what makes it one, and rejecting it for an unfamiliar verb would silently drop the syllabus's
     * own words — which are the strongest provenance StudyOS has.
     */
    @Test
    void acceptsADeclaredObjectiveWhoseVerbIsUnknown() {
        assertThat(ObjectiveExtractor.declared("Zorbify the quantum manifold")).isEqualTo("Zorbify the quantum manifold.");
        assertThat(ObjectiveExtractor.declared("• define consideration in contract formation")).isEqualTo("Define consideration in contract formation.");
        assertThat(ObjectiveExtractor.declared("  Compare  void   and voidable  agreements ")).isEqualTo("Compare void and voidable agreements.");
    }

    /** Declared or not, it still has to be a statement: a syllabus's objectives array also collects headings. */
    @Test
    void rejectsADeclaredEntryThatIsNotAStatement() {
        assertThat(ObjectiveExtractor.declared("Objectives")).isNull();
        assertThat(ObjectiveExtractor.declared("Week 3")).isNull();
        assertThat(ObjectiveExtractor.declared("")).isNull();
        assertThat(ObjectiveExtractor.declared("   ")).isNull();
        assertThat(ObjectiveExtractor.declared(null)).isNull();
        assertThat(ObjectiveExtractor.declared("Define ".repeat(41))).isNull();
    }

    /**
     * The two paths have to agree, or the same objective would be stored twice: once from the syllabus that declared
     * it and once from the handout that states it.
     */
    @Test
    void reducesADeclaredObjectiveToTheSameFormAsAnExtractedOne() {
        String declared = ObjectiveExtractor.declared("By the end of the unit, you will be able to explain the proof of the bound.");
        String extracted = ObjectiveExtractor.extract("Students should be able to explain the proof of the bound.").get(0).statement();
        assertThat(declared).isEqualTo(extracted).isEqualTo("Explain the proof of the bound.");
    }

    /**
     * No subject knowledge anywhere. The same structural rules find objectives in law and in biology, and the
     * levels come from the verbs rather than from anything either subject contains.
     */
    @Test
    void worksTheSameWayForACourseItHasNeverSeen() {
        assertThat(ObjectiveExtractor.extract("""
                Learning Outcomes
                - Define consideration in the formation of a contract.
                - Compare void and voidable agreements.
                - Evaluate whether promissory estoppel applies to the facts.
                """)).extracting(Objective::cognitiveLevel).containsExactly(1, 4, 6);
        assertThat(ObjectiveExtractor.extract("The reader will be able to describe the stages of mitosis in order."))
                .extracting(Objective::statement, Objective::cognitiveLevel)
                .containsExactly(tuple("Describe the stages of mitosis in order.", 2));
    }
}
