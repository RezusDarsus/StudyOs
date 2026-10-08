package com.studyos.ingestion;

import static org.assertj.core.api.Assertions.assertThat;
import java.util.List;
import org.junit.jupiter.api.Test;

class StructureAwareChunkerTest {
    @Test void preservesPagesAndSplitsLargeDocuments() {
        var pages = new ExtractedDocument(List.of(new ParsedPage(1, "A paragraph."), new ParsedPage(2, "B paragraph.")));
        var chunks = new StructureAwareChunker().chunk(pages);
        assertThat(chunks).hasSize(1); assertThat(chunks.get(0).pageStart()).isEqualTo(1); assertThat(chunks.get(0).pageEnd()).isEqualTo(2); assertThat(chunks.get(0).content()).contains("A paragraph", "B paragraph");
    }

    /**
     * The reason chunks carry their section: a passage carved out of the middle of one never repeats the name of
     * what it is explaining, so on its own it is unmatchable by the question that it answers.
     */
    @Test void eachChunkCarriesTheSectionItBeganIn() {
        String filler = ("Padding sentence for length. ".repeat(200)).trim();
        var document = new ExtractedDocument(List.of(
                new ParsedPage(1, "2 Cyclic codes\n\n2.1 Generator polynomials\n\n" + filler),
                new ParsedPage(2, "3 Convolutional codes\n\n" + filler)));
        var chunks = new StructureAwareChunker().chunk(document);
        assertThat(chunks).hasSizeGreaterThan(1);
        assertThat(chunks.get(0).headingPath()).isEqualTo("2 Cyclic codes > 2.1 Generator polynomials");
        assertThat(chunks.get(chunks.size() - 1).headingPath()).isEqualTo("3 Convolutional codes");
        assertThat(chunks).allSatisfy(chunk -> assertThat(chunk.content()).doesNotContain(" > "));
    }

    /** A document with no structure to find says so, rather than inventing a title from its first line. */
    @Test void anUnstructuredDocumentCarriesNoSection() {
        var document = new ExtractedDocument(List.of(new ParsedPage(1, "Plain prose that titles nothing at all.")));
        var chunk = new StructureAwareChunker().chunk(document).get(0);
        assertThat(chunk.headingPath()).isEmpty();
        assertThat(chunk.headingTrail()).isEmpty();
    }

    /**
     * The path and the trail are two views of one snapshot: the string that gets folded into
     * {@code chunks.context_header} and indexed, and the levels that reach {@code document_sections}. They are
     * rendered from the same trail at the same moment rather than captured separately, because if they could
     * disagree a passage would be retrievable under one section and filed in the tree under another.
     */
    @Test void theTrailRendersToExactlyThePathThatIsIndexed() {
        String filler = ("Padding sentence for length. ".repeat(200)).trim();
        var document = new ExtractedDocument(List.of(
                new ParsedPage(1, "2 Cyclic codes\n\n2.1 Generator polynomials\n\n" + filler),
                new ParsedPage(2, "3 Convolutional codes\n\n" + filler)));
        var chunks = new StructureAwareChunker().chunk(document);
        assertThat(chunks).hasSizeGreaterThan(1);
        assertThat(chunks).allSatisfy(chunk -> assertThat(Heading.path(chunk.headingTrail())).isEqualTo(chunk.headingPath()));
        assertThat(chunks.get(0).headingTrail()).extracting(Heading::text).containsExactly("2 Cyclic codes", "2.1 Generator polynomials");
        assertThat(chunks.get(0).headingTrail().get(0).level()).isLessThan(chunks.get(0).headingTrail().get(1).level());
    }
}
