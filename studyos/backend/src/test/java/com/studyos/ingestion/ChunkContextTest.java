package com.studyos.ingestion;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ChunkContextTest {
    @Test void theHeaderNamesTheDocumentAndTheSection() {
        assertThat(ChunkContext.header("lecture-03.pdf", "3 Cyclic codes > 3.1 Generator polynomials"))
                .isEqualTo("lecture-03 — 3 Cyclic codes > 3.1 Generator polynomials");
    }

    /**
     * A stored file name is not a title. The extension and the underscores standing in for spaces would enter
     * the full-text vector of every chunk in the course as lexemes of their own.
     */
    @Test void fileNameArtefactsAreNormalisedAway() {
        assertThat(ChunkContext.header("Coding_Theory_Lecture_04.PDF", "")).isEqualTo("Coding Theory Lecture 04");
    }

    @Test void anAbsentOutlineLeavesJustTheDocumentAndAnAbsentNameJustTheOutline() {
        assertThat(ChunkContext.header("notes.txt", null)).isEqualTo("notes");
        assertThat(ChunkContext.header(null, "2 Syntax")).isEqualTo("2 Syntax");
        assertThat(ChunkContext.header("  ", "  ")).isEmpty();
    }

    /** Whatever retrieval scored is what the header plus the content says, in that order. */
    @Test void theContextualTextIsTheHeaderThenTheChunk() {
        assertThat(ChunkContext.contextual("notes — 2 Syntax", "The same rule applies for any n."))
                .isEqualTo("notes — 2 Syntax\n\nThe same rule applies for any n.");
        assertThat(ChunkContext.contextual("", "Body")).isEqualTo("Body");
        assertThat(ChunkContext.contextual(null, "Body")).isEqualTo("Body");
    }

    /** Context is bounded, so a runaway heading trail shortens the context instead of crowding out the chunk. */
    @Test void theHeaderIsBoundedOnAWordBoundary() {
        String path = ("Section " + "very long heading ".repeat(30)).strip();
        String header = ChunkContext.header("notes.pdf", path);
        String full = "notes — " + path;
        assertThat(header.length()).isLessThanOrEqualTo(ChunkContext.MAX_HEADER_CHARS);
        assertThat(full).startsWith(header);
        assertThat(full.charAt(header.length())).isEqualTo(' ');
    }

    /** Beside a citation that already names the document, repeating the name says nothing. */
    @Test void theSectionDropsWhatTheCitationAlreadyStates() {
        assertThat(ChunkContext.section("lecture-03 — 3 Cyclic codes", "lecture-03.pdf")).isEqualTo("3 Cyclic codes");
        assertThat(ChunkContext.section("lecture-03", "lecture-03.pdf")).isEmpty();
        assertThat(ChunkContext.section("", "lecture-03.pdf")).isEmpty();
        assertThat(ChunkContext.section("3 Cyclic codes", "lecture-03.pdf")).isEqualTo("3 Cyclic codes");
    }
}
