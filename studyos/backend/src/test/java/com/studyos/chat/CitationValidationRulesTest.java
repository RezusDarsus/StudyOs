package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

class CitationValidationRulesTest {
    @Test void rejectsCndsEx02PagesThreeToFourWhenDocumentHasOnlyTwoPages() {
        var range=CitationValidationRules.parse("3-4").orElseThrow();
        assertThat(CitationValidationRules.withinDocument(range,2)).isFalse();
    }

    @Test void acceptsExistingPageRange() {
        var range=CitationValidationRules.parse("1-2").orElseThrow();
        assertThat(CitationValidationRules.withinDocument(range,2)).isTrue();
    }

    @Test void rejectsMalformedOrReversedRanges() {
        assertThat(CitationValidationRules.parse("pages unknown")).isEmpty();
        assertThat(CitationValidationRules.parse("4-3")).isEmpty();
    }

    @Test void acceptsAContiguousPageListAsARange(){var range=CitationValidationRules.parse("13, 14, 15, 16").orElseThrow();assertThat(range.start()).isEqualTo(13);assertThat(range.end()).isEqualTo(16);}
    @Test void rejectsANonContiguousPageList(){assertThat(CitationValidationRules.parse("13, 15, 16")).isEmpty();}
}
