package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

/**
 * The contract is a prompt, so these tests can only assert what it says, not what a model does with it.
 * That is still worth pinning: the failures these rules exist for were silent regressions of the kind where a
 * rule gets dropped in an edit and nobody notices until the next benchmark run.
 */
class IntentContractTest {
    @ParameterizedTest @EnumSource(QueryIntent.class)
    void everyIntentCarriesBothTheUniversalRulesAndSomethingSpecificToIt(QueryIntent intent) {
        String contract = IntentContract.forIntent(intent);
        assertThat(contract).contains("same language the learner wrote in").contains("not yet assessed");
        assertThat(contract.lines().filter(line -> !line.isBlank()).count()).isGreaterThan(5);
    }

    @Test void quizGenerationIsToldToAskRatherThanTell() {
        String contract = IntentContract.forIntent(QueryIntent.QUIZ_GENERATION);
        assertThat(contract).contains("only the questions").contains("answer-key");
        assertThat(contract).contains("as many as were requested");
    }

    /** Plans retrieve no evidence chunks, so a plan that cites a page number invented it. */
    @Test void studyPlanIsForbiddenFromCitingDocumentsItNeverRetrieved() {
        assertThat(IntentContract.forIntent(QueryIntent.STUDY_PLAN)).contains("cite no documents or page numbers");
    }

    @Test void reviewMistakesMayNotManufactureAMistakeOrBlameTheLearnerForOneOfItsOwn() {
        String contract = IntentContract.forIntent(QueryIntent.REVIEW_MISTAKES);
        assertThat(contract).contains("never manufacture a mistake").contains("earlier answer of your own");
    }

    @Test void homeworkHelpStopsAtOneHintWhenOneHintIsWhatWasAsked() {
        assertThat(IntentContract.forIntent(QueryIntent.HOMEWORK_HELP)).contains("give one hint and stop");
    }

    /** No rule may name a subject: the same contract has to hold for a course this system has never seen. */
    @ParameterizedTest @EnumSource(QueryIntent.class)
    void noRuleNamesASubjectOrACourseSpecificTerm(QueryIntent intent) {
        assertThat(IntentContract.forIntent(intent).toLowerCase(java.util.Locale.ROOT))
                .doesNotContain("crc").doesNotContain("network").doesNotContain("polynomial")
                .doesNotContain("checksum").doesNotContain("chemistry").doesNotContain("physics");
    }
}
