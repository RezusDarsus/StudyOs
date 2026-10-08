package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * A chat's purpose is read back from a database column that older rows do not have and newer clients
 * may spell differently, so parsing has to be forgiving: an unrecognised value must still give a usable
 * chat rather than break the workspace. The broad threads deliberately carry no fallback intent, because
 * guessing what an unspecific turn means is only safe when the chat is narrow.
 */
class ChatPurposeTest {
    @Test void readsTheStoredNameBackForEveryPurpose() {
        for (ChatPurpose purpose : ChatPurpose.values()) assertThat(ChatPurpose.of(purpose.name())).isEqualTo(purpose);
    }

    @Test void acceptsTheSpellingsAClientIsLikelyToSend() {
        assertThat(ChatPurpose.of("homework_help")).isEqualTo(ChatPurpose.HOMEWORK_HELP);
        assertThat(ChatPurpose.of("Homework Help")).isEqualTo(ChatPurpose.HOMEWORK_HELP);
        assertThat(ChatPurpose.of("homework-help")).isEqualTo(ChatPurpose.HOMEWORK_HELP);
        assertThat(ChatPurpose.of("  EXAM_PREPARATION  ")).isEqualTo(ChatPurpose.EXAM_PREPARATION);
    }

    /** A chat row written before purposes existed still has to open. */
    @Test void missingOrUnknownValuesFallBackToGeneral() {
        assertThat(ChatPurpose.of(null)).isEqualTo(ChatPurpose.GENERAL);
        assertThat(ChatPurpose.of("")).isEqualTo(ChatPurpose.GENERAL);
        assertThat(ChatPurpose.of("   ")).isEqualTo(ChatPurpose.GENERAL);
        assertThat(ChatPurpose.of("WEEKLY_REFLECTION")).isEqualTo(ChatPurpose.GENERAL);
        assertThat(ChatPurpose.orGeneral(null)).isEqualTo(ChatPurpose.GENERAL);
        assertThat(ChatPurpose.orGeneral(ChatPurpose.DEEP_DIVE)).isEqualTo(ChatPurpose.DEEP_DIVE);
    }

    /** A general or main thread covers too much ground for a bare phrase to be read as any one request. */
    @Test void broadThreadsDoNotGuessWhatAnUnspecificTurnMeans() {
        assertThat(ChatPurpose.GENERAL.fallbackIntent()).isNull();
        assertThat(ChatPurpose.MAIN_TUTOR.fallbackIntent()).isNull();
        assertThat(ChatPurpose.HOMEWORK_HELP.fallbackIntent()).isEqualTo(QueryIntent.HOMEWORK_HELP);
        assertThat(ChatPurpose.DEEP_DIVE.fallbackIntent()).isEqualTo(QueryIntent.EXPLAIN_TOPIC);
        assertThat(ChatPurpose.EXAM_PREPARATION.fallbackIntent()).isEqualTo(QueryIntent.EXAM_ANALYSIS);
        assertThat(ChatPurpose.HARD_EXERCISES.fallbackIntent()).isEqualTo(QueryIntent.HARD_NEW);
    }

    /** An untitled chat is named after what it is for, so a sidebar of them is still readable. */
    @Test void everyPurposeNamesAnUntitledChatDistinctly() {
        Set<String> titles = new HashSet<>();
        for (ChatPurpose purpose : ChatPurpose.values()) {
            assertThat(purpose.label()).isNotBlank();
            assertThat(purpose.defaultTitle()).isNotBlank();
            assertThat(purpose.hint()).as("%s has nothing to show a student choosing it", purpose).isNotBlank();
            assertThat(titles.add(purpose.defaultTitle())).as("%s reuses a default title", purpose).isTrue();
        }
    }
}
