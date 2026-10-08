package com.studyos.assessment;

import static org.assertj.core.api.Assertions.assertThat;
import com.studyos.ingestion.DocumentType;
import org.junit.jupiter.api.Test;

/**
 * Source-type resolution decides whether a document gets torn into assessment items at all, so
 * getting it wrong is expensive in both directions: a mislabelled lecture deck becomes dozens of
 * fake exam questions, and a missed exam contributes nothing to exam prediction.
 */
class AssessmentSourceTypeTest {
    private static final String OTHER = DocumentType.OTHER.name();

    @Test void anExplicitChoiceIsNotOverriddenByTheFilename() {
        assertThat(AssessmentExtractionService.effectiveType("midterm-review-slides.pdf", DocumentType.LECTURE.name(), "Week 7 recap"))
                .isEqualTo(DocumentType.LECTURE.name());
        assertThat(AssessmentExtractionService.effectiveType("exam-prep-notes.pdf", DocumentType.STUDENT_NOTE.name(), "my notes"))
                .isEqualTo(DocumentType.STUDENT_NOTE.name());
    }

    @Test void anUnsetTypeIsStillInferredFromTheFilename() {
        assertThat(AssessmentExtractionService.effectiveType("midterm-2024.pdf", OTHER, "Question 1")).isEqualTo(DocumentType.PAST_EXAM.name());
        assertThat(AssessmentExtractionService.effectiveType("final.pdf", null, "Question 1")).isEqualTo(DocumentType.PAST_EXAM.name());
        assertThat(AssessmentExtractionService.effectiveType("homework-3.pdf", OTHER, "Exercise 1")).isEqualTo(DocumentType.HOMEWORK.name());
        assertThat(AssessmentExtractionService.effectiveType("hw2.pdf", OTHER, "Exercise 1")).isEqualTo(DocumentType.HOMEWORK.name());
    }

    @Test void assessmentWordsInsideOtherWordsDoNotCountAsAssessments() {
        assertThat(AssessmentExtractionService.effectiveType("latest-notes.pdf", OTHER, "some reading"))
                .isNotEqualTo(DocumentType.PAST_EXAM.name());
        assertThat(AssessmentExtractionService.effectiveType("worked-examples.pdf", OTHER, "some reading"))
                .isNotEqualTo(DocumentType.PAST_EXAM.name());
        assertThat(AssessmentExtractionService.effectiveType("finalize-the-model.pdf", OTHER, "some reading"))
                .isNotEqualTo(DocumentType.PAST_EXAM.name());
        assertThat(AssessmentExtractionService.effectiveType("attestation-guide.pdf", OTHER, "some reading"))
                .isNotEqualTo(DocumentType.PAST_EXAM.name());
    }

    @Test void separatorsAndPluralsInProblemSetNamesAreAllRecognised() {
        for (String name : new String[]{"problemset4.pdf", "problem-set-4.pdf", "problem_set_4.pdf", "problem set 4.pdf", "problemsets.pdf"})
            assertThat(AssessmentExtractionService.effectiveType(name, OTHER, "")).as(name).isEqualTo(DocumentType.HOMEWORK.name());
    }

    @Test void assessmentWordingInTheTextIsEnoughWhenTheFilenameIsUninformative() {
        assertThat(AssessmentExtractionService.effectiveType("scan001.pdf", OTHER, "Past exam, autumn sitting"))
                .isEqualTo(DocumentType.PAST_EXAM.name());
        assertThat(AssessmentExtractionService.effectiveType("scan002.pdf", OTHER, "Exercise sheet 4"))
                .isEqualTo(DocumentType.HOMEWORK.name());
    }

    @Test void remainingTypesComeFromTheSharedClassifierRatherThanASecondCopyOfIt() {
        assertThat(AssessmentExtractionService.effectiveType("course-info.pdf", OTHER, "Syllabus and grading policy"))
                .isEqualTo(DocumentType.SYLLABUS.name());
        assertThat(AssessmentExtractionService.effectiveType("lecture-04.pdf", OTHER, "Slides")).isEqualTo(DocumentType.LECTURE.name());
        assertThat(AssessmentExtractionService.effectiveType("quiz-1.pdf", OTHER, "")).isEqualTo(DocumentType.QUIZ.name());
    }

    /** The same filename shapes have to resolve identically whatever the course is about. */
    @Test void resolutionDependsOnDocumentShapeNotOnTheSubject() {
        for (String subject : new String[]{"organic-chemistry", "constitutional-law", "distributed-systems", "microeconomics"}) {
            assertThat(AssessmentExtractionService.effectiveType(subject + "-final-2023.pdf", OTHER, ""))
                    .as(subject).isEqualTo(DocumentType.PAST_EXAM.name());
            assertThat(AssessmentExtractionService.effectiveType(subject + "-homework-2.pdf", OTHER, ""))
                    .as(subject).isEqualTo(DocumentType.HOMEWORK.name());
            assertThat(AssessmentExtractionService.effectiveType(subject + "-lecture-2.pdf", OTHER, ""))
                    .as(subject).isEqualTo(DocumentType.LECTURE.name());
        }
    }

    @Test void aMissingNameOrSampleIsSafe() {
        assertThat(AssessmentExtractionService.effectiveType(null, null, null)).isEqualTo(OTHER);
        assertThat(AssessmentExtractionService.effectiveType("", "", "")).isEqualTo(OTHER);
    }
}
