package com.studyos.curriculum;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import com.studyos.curriculum.LessonBriefComposer.Brief;
import com.studyos.curriculum.LessonBriefComposer.Check;
import com.studyos.curriculum.LessonBriefComposer.Citation;
import com.studyos.curriculum.LessonBriefComposer.Draft;
import com.studyos.curriculum.LessonBriefComposer.Excerpt;
import com.studyos.curriculum.LessonBriefComposer.Request;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * A lesson brief is the one place StudyOS speaks at length, so the rules about what may appear in it
 * are worth pinning down. Two of them matter most: a section that says nothing is dropped rather than
 * shown, and a brief written without evidence is never passed off as grounded.
 *
 * <p>The inputs here are chemistry, contract law and statistics on purpose. The composer applies the
 * same rules to all of them because it reads structure, not subject matter.
 */
class LessonBriefComposerTest {

    private static final Request TITRATION = new Request("Titration curves", "Read the equivalence point off a curve.",
            List.of("equivalence point", "buffer region"), 3, List.of());

    @Test
    void keepsTheSectionsADraftGotRightInTheOrderALessonIsTaught() {
        Draft draft = new Draft("A titration curve records how pH answers each drop of added base.",
                "The equivalence point is where moles of added titrant equal moles of analyte.",
                "Adding 25.0 mL of 0.100 M NaOH to 25.0 mL of 0.100 M HCl gives 2.50 mmol each, so pH = 7.",
                List.of(new Check("Where does the steepest part of the curve sit?", "At the equivalence point.")),
                List.of("Reading the midpoint of the steep rise as the buffer region"), "Try a weak-acid curve next.");

        Brief brief = LessonBriefComposer.compose(TITRATION, draft, List.of(excerpt("Lab manual", 12, 13, "The equivalence point is where moles of titrant equal moles of analyte.")));

        assertThat(brief.intuition()).startsWith("A titration curve records");
        assertThat(brief.formalDefinition()).contains("moles of added titrant");
        assertThat(brief.workedExample()).contains("2.50 mmol");
        assertThat(brief.checks()).extracting(Check::question).containsExactly("Where does the steepest part of the curve sit?");
        assertThat(brief.commonMistakes()).hasSize(1);
        assertThat(brief.nextStep()).isEqualTo("Try a weak-acid curve next.");
        assertThat(brief.complete()).isTrue();
        assertThat(brief.missing()).isEmpty();
        assertThat(LessonBriefComposer.contentStatus(brief)).isEqualTo("READY");
    }

    /** A section holding "N/A" is worse than an absent one: it looks like teaching and teaches nothing. */
    @Test
    void dropsSectionsThatSayNothingAndReportsThemAsMissing() {
        Draft draft = new Draft("  ", "N/A", "The full derivation is in the notes and is worth reading twice before the seminar.",
                List.of(new Check("  ", "unused"), new Check("Why?", "too short to be a check")), List.of(), null);

        Brief brief = LessonBriefComposer.compose(TITRATION, draft, List.of(excerpt("Lab manual", 12, 12, "…")));

        assertThat(brief.intuition()).isNull();
        assertThat(brief.formalDefinition()).as("a two-letter placeholder is not a definition").isNull();
        assertThat(brief.workedExample()).isNotNull();
        assertThat(brief.checks()).isEmpty();
        assertThat(brief.complete()).isFalse();
        assertThat(brief.missing()).containsExactly("intuition", "precise statement", "check questions");
        assertThat(LessonBriefComposer.contentStatus(brief)).isEqualTo("PARTIAL");
    }

    @Test
    void whatTheStudentAlreadyGotWrongIsListedBeforeWhatIsGenerallyGotWrong() {
        Request consideration = new Request("Consideration", "Identify valid consideration in an agreement.", List.of(), 4,
                List.of("Treated a past act as consideration"));
        Draft draft = new Draft(null, null, null, List.of(),
                List.of("treated a PAST act as consideration", "Confusing consideration with motive"), null);

        Brief brief = LessonBriefComposer.compose(consideration, draft, List.of());

        assertThat(brief.commonMistakes())
                .as("the student's own recorded error comes first, and the draft's restatement of it is not repeated")
                .containsExactly("Treated a past act as consideration", "Confusing consideration with motive");
    }

    @Test
    void neverClaimsToBeGroundedWhenNothingWasRetrieved() {
        Brief withEvidence = LessonBriefComposer.compose(TITRATION, new Draft(null, null, null, List.of(), List.of(), null),
                List.of(excerpt("Lecture 4", 3, 3, "pH at the equivalence point.")));
        Brief without = LessonBriefComposer.compose(TITRATION, new Draft(null, null, null, List.of(), List.of(), null), List.of());

        assertThat(withEvidence.grounded()).isTrue();
        assertThat(without.grounded()).isFalse();
        assertThat(without.citations()).isEmpty();
    }

    @Test
    void citesEachSourcePlaceOnceEvenWhenSeveralPassagesCameFromIt() {
        List<Excerpt> evidence = List.of(
                excerpt("Lecture 4", 3, 5, "First passage."),
                excerpt("Lecture 4", 3, 5, "A second passage from the same pages."),
                excerpt("Lecture 4", 7, 7, "A passage from later on."),
                excerpt("  ", 1, 1, "An excerpt with no document name."));

        Brief brief = LessonBriefComposer.compose(TITRATION, new Draft(null, null, null, List.of(), List.of(), null), evidence);

        assertThat(brief.citations()).extracting(Citation::documentName, Citation::pageStart, Citation::pageEnd)
                .containsExactly(tuple("Lecture 4", 3, 5), tuple("Lecture 4", 7, 7));
    }

    /**
     * The honest failure mode. With no draft the student still gets their own material, cited, and the
     * brief admits what it does not have — rather than opening with prose nothing supports.
     */
    @Test
    void fallbackShowsTheStudentsOwnMaterialInsteadOfInventingALesson() {
        Excerpt passage = excerpt("Statistics notes", 8, 9,
                "The central limit theorem states that the sample mean approaches a normal distribution. This holds for any finite-variance population. A proof follows in the appendix. Further remarks appear later.");

        Brief brief = LessonBriefComposer.fallback(new Request("Central limit theorem", "State the theorem.", List.of(), 2, List.of()), List.of(passage));

        assertThat(brief.formalDefinition())
                .startsWith("The central limit theorem states")
                .contains("finite-variance population")
                .doesNotContain("Further remarks");
        assertThat(brief.intuition()).isNull();
        assertThat(brief.workedExample()).isNull();
        assertThat(brief.grounded()).isTrue();
        assertThat(brief.complete()).isFalse();
        assertThat(brief.citations()).containsExactly(new Citation("Statistics notes", 8, 9));
        assertThat(LessonBriefComposer.contentStatus(brief)).isEqualTo("PARTIAL");
    }

    @Test
    void aLessonWithNothingBehindItStaysPendingRatherThanOpeningEmpty() {
        Brief brief = LessonBriefComposer.fallback(TITRATION, List.of(excerpt("Lab manual", 1, 1, "   ")));

        assertThat(brief.grounded()).isFalse();
        assertThat(brief.missing()).containsExactly("intuition", "precise statement", "worked example", "check questions");
        assertThat(LessonBriefComposer.contentStatus(brief)).isEqualTo("PENDING");
        assertThat(LessonBriefComposer.contentStatus(null)).isEqualTo("PENDING");
    }

    @Test
    void holdsALessonToOneSittingByCappingWhatItCanContain() {
        Draft draft = new Draft(null, null, null,
                List.of(new Check("First question here?", null), new Check("Second question here?", "b"),
                        new Check("Third question here?", "c"), new Check("Fourth question here?", "d")),
                List.of("First mistake", "Second mistake", "Third mistake", "Fourth mistake"), null);

        Brief brief = LessonBriefComposer.compose(TITRATION, draft, List.of());

        assertThat(brief.checks()).hasSize(LessonBriefComposer.MAX_CHECKS);
        assertThat(brief.checks().getFirst().answer()).as("a question worth asking survives a missing answer").isNull();
        assertThat(brief.commonMistakes()).hasSize(LessonBriefComposer.MAX_MISTAKES);
    }

    @Test
    void truncatesAnOverlongSectionWithoutLosingTheLesson() {
        String rambling = "Step one follows. ".repeat(200);

        Brief brief = LessonBriefComposer.compose(TITRATION, new Draft(null, null, rambling, List.of(), List.of(), null), List.of());

        assertThat(brief.workedExample()).hasSizeLessThan(2100).endsWith("…").startsWith("Step one follows.");
    }

    @Test
    void anUnknownTargetLevelBecomesAWorkableOne() {
        Brief brief = LessonBriefComposer.compose(new Request("Osmosis", null, null, 0, null),
                new Draft(null, null, null, List.of(), List.of(), null), null);

        assertThat(brief.targetLevel()).isEqualTo(3);
        assertThat(brief.targetLevelLabel()).isEqualTo("Apply");
        assertThat(brief.keyIdeas()).isEmpty();
        assertThat(brief.commonMistakes()).isEmpty();
        assertThat(brief.citations()).isEmpty();
    }

    @Test
    void survivesAMissingDraftEntirely() {
        Brief brief = LessonBriefComposer.compose(TITRATION, null, List.of(excerpt("Lab manual", 2, 2, "text")));

        assertThat(brief.complete()).isFalse();
        assertThat(brief.grounded()).isTrue();
        assertThat(brief.checks()).isEmpty();
    }

    @Test
    void writesTheLessonOutInTheOrderItIsTaught() {
        Draft draft = new Draft("A buffer resists change in pH when small amounts of acid are added to it.",
                "A buffer is a solution of a weak acid and its conjugate base in comparable amounts.",
                "Mixing 0.10 mol acetic acid with 0.10 mol acetate gives pH equal to the pKa of 4.76.",
                List.of(new Check("What happens to pH when the ratio doubles?", "It rises by log 2.")),
                List.of("Assuming a buffer works at any pH"), "Practise the Henderson-Hasselbalch rearrangement.");

        String text = LessonBriefComposer.markdown(LessonBriefComposer.compose(
                new Request("Buffers", "Explain why a buffer holds pH steady.", List.of("weak acid", "conjugate base"), 3, List.of()),
                draft, List.of(excerpt("Lab manual", 12, 13, "A buffer is a weak acid with its conjugate base."))));

        assertThat(text).startsWith("# Buffers");
        assertThat(text).contains("_Explain why a buffer holds pH steady._")
                .contains("Key ideas: weak acid, conjugate base")
                .contains("## In plain terms").contains("## Stated precisely").contains("## Worked example")
                .contains("1. What happens to pH when the ratio doubles?").contains("   Answer: It rises by log 2.")
                .contains("- Assuming a buffer works at any pH")
                .contains("## From your material").contains("- Lab manual p.12–13");
        assertThat(text.indexOf("## In plain terms")).isLessThan(text.indexOf("## Stated precisely"));
        assertThat(text.indexOf("## Stated precisely")).isLessThan(text.indexOf("## Worked example"));
        assertThat(text.indexOf("## Worked example")).isLessThan(text.indexOf("## Check yourself"));
    }

    @Test
    void leavesOutHeadingsForSectionsThatWereNeverWritten() {
        String text = LessonBriefComposer.markdown(LessonBriefComposer.fallback(
                new Request("Estoppel", null, List.of(), 4, List.of()),
                List.of(excerpt("Case notes", 0, 0, "Estoppel bars retracting a promise that was relied upon by the other party."))));

        assertThat(text).contains("# Estoppel").contains("## Stated precisely")
                .doesNotContain("## In plain terms").doesNotContain("## Worked example").doesNotContain("## Check yourself");
        assertThat(text).as("a source with no page numbers is still named").contains("- Case notes");
    }

    @Test
    void namesTheSourceThePlaceTheStudentWouldLookForIt() {
        assertThat(LessonBriefComposer.reference(new Citation("Lecture 4", 3, 5))).isEqualTo("Lecture 4 p.3–5");
        assertThat(LessonBriefComposer.reference(new Citation("Lecture 4", 3, 3))).isEqualTo("Lecture 4 p.3");
        assertThat(LessonBriefComposer.reference(new Citation("Lecture 4", 3, 1))).as("a nonsensical range still points at the page it starts on").isEqualTo("Lecture 4 p.3");
        assertThat(LessonBriefComposer.reference(new Citation("Lecture 4", 0, 0))).isEqualTo("Lecture 4");
        assertThat(LessonBriefComposer.reference(new Citation(null, 2, 2))).isEqualTo("Course material p.2");
    }

    @Test
    void cutsAPassageAtASentenceRatherThanMidClause() {
        assertThat(LessonBriefComposer.sentences("One. Two. Three.", 2)).isEqualTo("One. Two.");
        assertThat(LessonBriefComposer.sentences("A single sentence with no stop", 3)).isEqualTo("A single sentence with no stop");
        assertThat(LessonBriefComposer.sentences("  Spread\nover   lines. And more.  ", 1)).isEqualTo("Spread over lines.");
        assertThat(LessonBriefComposer.sentences("Anything.", 0)).as("a nonsensical limit still returns something readable").isEqualTo("Anything.");
        assertThat(LessonBriefComposer.sentences("   ", 2)).isNull();
    }

    private static Excerpt excerpt(String document, int pageStart, int pageEnd, String content) {
        return new Excerpt(document, pageStart, pageEnd, content);
    }
}
