package com.studyos.ingestion;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

class SourceClassifierTest {
    @Test void detectsSyllabusFromStructure() {
        var result = SourceClassifier.classify("distributed-systems.pdf", "Course schedule\nLearning objectives\nGrading policy");
        assertThat(result.type()).isEqualTo(DocumentType.SYLLABUS);
        assertThat(result.confidence()).isGreaterThan(.8);
    }

    @Test void detectsDatedPastExam() {
        assertThat(SourceClassifier.classify("final_exam_2025.pdf", "Answer every question").type()).isEqualTo(DocumentType.PAST_EXAM);
    }

    @Test void leavesAmbiguousMaterialUnclassified() {
        assertThat(SourceClassifier.classify("reading.pdf", "A short discussion of networks.").type()).isEqualTo(DocumentType.OTHER);
    }
}
