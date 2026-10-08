package com.studyos.assessment;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

/**
 * Linking an extracted question to a topic decides which mastery record the student's work updates, so
 * a wrong link credits or blames the wrong topic. These cases are drawn from unrelated subjects on
 * purpose: the matcher must work from the topic names and aliases the student's own uploads produced,
 * never from a built-in list of one course's vocabulary.
 */
class AssessmentTopicMatchTest {

    @Test void matchesATopicNameThatAppearsAsAWord() {
        assertThat(AssessmentExtractionService.phraseMatch("compute the cyclic redundancy check for this frame", "cyclic redundancy check")).isTrue();
        assertThat(AssessmentExtractionService.phraseMatch("state le chatelier s principle for this equilibrium", "le chatelier s principle")).isTrue();
        assertThat(AssessmentExtractionService.phraseMatch("explain the doctrine of consideration in contract law", "doctrine of consideration")).isTrue();
    }

    @Test void toleratesAnInflectedEnding() {
        assertThat(AssessmentExtractionService.phraseMatch("compare two hash tables", "hash table")).isTrue();
        assertThat(AssessmentExtractionService.phraseMatch("name the enzymes involved", "enzyme")).isTrue();
        assertThat(AssessmentExtractionService.phraseMatch("the reaction proceeded quickly", "react")).isFalse();
    }

    @Test void doesNotMatchInsideAnUnrelatedWord() {
        assertThat(AssessmentExtractionService.phraseMatch("the ionosphere reflects radio waves", "ion")).isFalse();
        assertThat(AssessmentExtractionService.phraseMatch("describe the constitution", "constitutional convention")).isFalse();
        assertThat(AssessmentExtractionService.phraseMatch("draw the tangent", "tan")).isFalse();
    }

    @Test void veryShortPhrasesAreNeverMatchedOnTheirOwn() {
        assertThat(AssessmentExtractionService.phraseMatch("solve for pi", "pi")).isFalse();
        assertThat(AssessmentExtractionService.phraseMatch("balance the equation", "")).isFalse();
        assertThat(AssessmentExtractionService.phraseMatch(null, "enzyme")).isFalse();
    }

    @Test void anAliasFromTheStudentsOwnMaterialCountsAsAMatch() {
        assertThat(AssessmentExtractionService.aliasMatch("crc|frame check sequence", "compute the crc for this frame")).isTrue();
        assertThat(AssessmentExtractionService.aliasMatch("sn1|unimolecular substitution", "predict the product of the sn1 pathway")).isTrue();
        assertThat(AssessmentExtractionService.aliasMatch("crc|frame check sequence", "explain congestion control")).isFalse();
    }

    @Test void anEmptyAliasListMatchesNothing() {
        assertThat(AssessmentExtractionService.aliasMatch("", "compute the crc")).isFalse();
        assertThat(AssessmentExtractionService.aliasMatch(null, "compute the crc")).isFalse();
        assertThat(AssessmentExtractionService.aliasMatch("|  |", "compute the crc")).isFalse();
    }

    @Test void headingDebrisIsNotExtractedAsAQuestion() {
        assertThat(AssessmentExtractionService.looksLikePrompt("Exercise/TTF 1 2 3 4 5 6 7 8")).isFalse();
        assertThat(AssessmentExtractionService.looksLikePrompt("Part II 4 5 6 (2 pt)")).isFalse();
        assertThat(AssessmentExtractionService.looksLikePrompt("short")).isFalse();
        assertThat(AssessmentExtractionService.looksLikePrompt(null)).isFalse();
    }

    @Test void realPromptsSurviveInAnyLanguage() {
        assertThat(AssessmentExtractionService.looksLikePrompt("Explain why the enzyme loses activity above 60 degrees.")).isTrue();
        assertThat(AssessmentExtractionService.looksLikePrompt("Erklären Sie, warum das Enzym seine Aktivität verliert.")).isTrue();
        assertThat(AssessmentExtractionService.looksLikePrompt("Explique por qué el enzima pierde su actividad.")).isTrue();
    }
}
