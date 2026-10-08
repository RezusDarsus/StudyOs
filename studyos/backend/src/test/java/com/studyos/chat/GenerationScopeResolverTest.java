package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;
import java.util.List;
import org.junit.jupiter.api.Test;

class GenerationScopeResolverTest {
    @Test void topicExcerptDoesNotExposeUnrelatedSectionsFromACoarseWorksheetChunk(){
        String text="Fairness "+"x".repeat(1800)+" CRC polynomial division and generator polynomial "+"y".repeat(1800)+" Sliding windows";
        String excerpt=GenerationScopeResolver.topicExcerpt(text,List.of("CRC"));
        assertThat(excerpt).contains("CRC polynomial division").doesNotContain("Fairness").doesNotContain("Sliding windows");
    }

    @Test void topicExcerptUsesAliasesAndLeavesUnscopedEvidenceUntouched(){
        String text="Prefix. Cyclic Redundancy Check uses polynomial division. Suffix.";
        assertThat(GenerationScopeResolver.topicExcerpt(text,List.of("Cyclic Redundancy Check","CRC"))).contains("polynomial division");
        assertThat(GenerationScopeResolver.topicExcerpt(text,List.of())).isEqualTo(text);
    }
}
