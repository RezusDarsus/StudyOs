package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.assessment.QuizService;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * A quiz reply is assembled from generated questions rather than written by the model, which is what makes it
 * impossible for an answer to appear in it. These tests pin the assembly, including the two ways an answer
 * could still leak back in: an expansion that offers a worked example, and a hint printed alongside the question.
 */
class QuizTurnServiceTest {
    private final QuizTurnService service = new QuizTurnService(null, null);
    private final SemanticAnswerService renderer = new SemanticAnswerService(null, null);

    private QuizService.Question question(String prompt, String document, String pages) {
        return question(prompt, List.of(Map.of("document", document, "pages", pages)));
    }

    private QuizService.Question question(String prompt, List<Map<String,Object>> sourceBasis) {
        return new QuizService.Question(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), prompt, .5, "TEXT", 4,
                sourceBasis, 3, "Apply", "PRACTICE", true, false);
    }

    @Test void asksEveryQuestionAndNumbersThem() {
        String reply = renderer.render(service.packet(List.of(question("First prompt", "notes.pdf", "3-4"), question("Second prompt", "notes.pdf", "3-4")), "Error detection"));
        assertThat(reply).contains("Question 1").contains("First prompt").contains("Question 2").contains("Second prompt");
        assertThat(reply).contains("are 2 questions on Error detection");
    }

    /** Nothing in a question record can hold an answer, and nothing in the packet may offer to produce one. */
    @Test void offersNoExpansionThatWouldRevealAnAnswer() {
        SemanticAnswerPacket packet = service.packet(List.of(question("Compute the check bits", "notes.pdf", "7")), null);
        assertThat(packet.expansions()).isEmpty();
        assertThat(renderer.render(packet)).doesNotContain("Worked example").doesNotContain("worked_example");
    }

    @Test void invitesAnAttemptAndSaysHintsComeOneStepAtATime() {
        String reply = renderer.render(service.packet(List.of(question("Only prompt", "slides.pdf", "1")), null));
        assertThat(reply).contains("is one question.").contains("Answer in your own words").contains("hint");
    }

    /** A support-free activity must not promise hints that {@code support} would refuse to release. */
    @Test void promisesNoHintsWhenTheActivityForbidsThem() {
        QuizService.Question examStyle = new QuizService.Question(UUID.randomUUID(), UUID.randomUUID(), null, "Under exam conditions", .7, "TEXT", 4, List.of(), 4, "Analyse", "MOCK_EXAM", false, false);
        assertThat(renderer.render(service.packet(List.of(examStyle), null))).doesNotContain("hint");
    }

    @Test void citesEachSourceOnceInTheOrderItWasFirstUsed() {
        SemanticAnswerPacket packet = service.packet(List.of(question("A", "week3.pdf", "2"), question("B", "week3.pdf", "2"), question("C", "week4.pdf", "5")), null);
        assertThat(packet.sources()).extracting(SemanticAnswerPacket.SourceRef::document).containsExactly("week3.pdf", "week4.pdf");
    }

    @Test void citesNothingWhenTheQuestionsCarryNoEvidence() {
        java.util.Map<String,Object> nameless = new java.util.HashMap<>(); nameless.put("document", null); nameless.put("pages", "2");
        assertThat(service.packet(List.of(question("A", List.of()), question("B", List.of(nameless))), null).sources()).isEmpty();
    }
}
