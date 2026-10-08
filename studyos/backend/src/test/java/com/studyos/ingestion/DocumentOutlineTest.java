package com.studyos.ingestion;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

class DocumentOutlineTest {
    /**
     * The reason this class exists: ingestion used to store one pseudo-section per page, so a course had no
     * chapters, no subsections, and no way to ask what a passage was part of. The trail each chunk already carried
     * is the tree, and this is it being rebuilt.
     */
    @Test void nestedHeadingsBecomeTheTreeTheDocumentHas() {
        var chunks = List.of(
                chunk(0, 1, "A process is new, ready, or running.", heading(1, "1 Processes"), heading(2, "1.1 Process states")),
                chunk(1, 2, "The PCB stores the saved registers.", heading(1, "1 Processes"), heading(2, "1.2 PCB")),
                chunk(2, 3, "User threads are cheap to create.", heading(1, "2 Threads"), heading(2, "2.1 User threads")));
        var outline = DocumentOutline.of("OperatingSystems.pdf", chunks);
        assertThat(titles(outline)).containsExactly("OperatingSystems.pdf", "1 Processes", "1.1 Process states", "1.2 PCB", "2 Threads", "2.1 User threads");
        assertThat(parentTitle(outline, "1 Processes")).isEqualTo("OperatingSystems.pdf");
        assertThat(parentTitle(outline, "1.1 Process states")).isEqualTo("1 Processes");
        assertThat(parentTitle(outline, "2.1 User threads")).isEqualTo("2 Threads");
        assertThat(node(outline, "OperatingSystems.pdf").parentId()).isNull();
        assertThat(outline.depth()).isEqualTo(2);
    }

    /** "1.1" then "1.2" are siblings. Nesting the second inside the first would file half a chapter under a page of it. */
    @Test void aSubsectionsSuccessorIsItsSiblingRatherThanItsChild() {
        var chunks = List.of(
                chunk(0, 1, "Generator polynomials divide x^n - 1.", heading(1, "3 Cyclic codes"), heading(2, "3.1 Generator polynomials")),
                chunk(1, 2, "Systematic encoding keeps the message visible.", heading(1, "3 Cyclic codes"), heading(2, "3.2 Systematic encoding")));
        var outline = DocumentOutline.of("Coding.pdf", chunks);
        assertThat(parentTitle(outline, "3.2 Systematic encoding")).isEqualTo("3 Cyclic codes");
        assertThat(node(outline, "3.1 Generator polynomials").level()).isEqualTo(node(outline, "3.2 Systematic encoding").level());
    }

    /**
     * A document that titles nothing gets one section covering it, not a fabricated row per page. The row per page
     * was the old behaviour and it made every unstructured document look structured.
     */
    @Test void anUnstructuredDocumentBecomesOneSectionCoveringIt() {
        var chunks = List.of(chunk(0, 1, "Plain prose that titles nothing."), chunk(1, 2, "More of the same."));
        var outline = DocumentOutline.of("notes.txt", chunks);
        assertThat(outline.nodes()).hasSize(1);
        assertThat(outline.nodes().get(0).level()).isEqualTo(DocumentOutline.DOCUMENT_LEVEL);
        assertThat(outline.nodes().get(0).path()).isEmpty();
        assertThat(outline.depth()).isEqualTo(DocumentOutline.DOCUMENT_LEVEL);
        assertThat(outline.chunkSections().values()).containsOnly(outline.nodes().get(0).id());
    }

    /**
     * Chunks were bound by looking their start page up in a page-keyed map, which returned null whenever a chunk
     * began on a page that produced no section. A chunk with no section is a passage retrieval can find and cannot
     * place, so every chunk gets one.
     */
    @Test void everyChunkBelongsToExactlyOneSection() {
        var chunks = List.of(
                chunk(0, 1, "Front matter."),
                chunk(1, 1, "Scheduling decides who runs.", heading(1, "3 Scheduling")),
                chunk(2, 2, "Round robin gives each process a slice.", heading(1, "3 Scheduling"), heading(2, "3.3 Round Robin")));
        var outline = DocumentOutline.of("OperatingSystems.pdf", chunks);
        assertThat(outline.chunkSections()).hasSize(3).doesNotContainValue(null);
        assertThat(outline.chunkSections().keySet()).containsExactlyInAnyOrderElementsOf(chunks.stream().map(Chunk::id).toList());
    }

    /** Text before the first heading belongs to the document. Filing it under the first chapter would misattribute it. */
    @Test void textBeforeTheFirstHeadingBelongsToTheDocumentItself() {
        var chunks = List.of(
                chunk(0, 1, "Course handout, spring term."),
                chunk(1, 1, "A process is a program in execution.", heading(1, "1 Processes")));
        var outline = DocumentOutline.of("OperatingSystems.pdf", chunks);
        var root = node(outline, "OperatingSystems.pdf");
        assertThat(outline.chunkSections().get(chunks.get(0).id())).isEqualTo(root.id());
        assertThat(root.rawText()).isEqualTo("Course handout, spring term.");
    }

    /**
     * A section holds its own text and not its subsections', which is what lets a summary of it be composed from
     * theirs instead of repeating them.
     */
    @Test void aSectionsTextStopsWhereItsSubsectionsBegin() {
        var chunks = List.of(
                chunk(0, 1, "This chapter introduces processes.", heading(1, "1 Processes")),
                chunk(1, 1, "New, ready, running, waiting, terminated.", heading(1, "1 Processes"), heading(2, "1.1 Process states")));
        var outline = DocumentOutline.of("OperatingSystems.pdf", chunks);
        assertThat(node(outline, "1 Processes").rawText()).isEqualTo("This chapter introduces processes.");
        assertThat(node(outline, "1.1 Process states").rawText()).isEqualTo("New, ready, running, waiting, terminated.");
    }

    /** A heading with no text directly under it has measured zero of it, which is not the same as an unknown amount. */
    @Test void aHeadingWithNothingDirectlyUnderItReportsZeroTokensRatherThanOne() {
        var chunks = List.of(chunk(0, 1, "A process is new, ready, or running.", heading(1, "1 Processes"), heading(2, "1.1 Process states")));
        var outline = DocumentOutline.of("OperatingSystems.pdf", chunks);
        assertThat(node(outline, "1 Processes").rawText()).isEmpty();
        assertThat(node(outline, "1 Processes").tokenCount()).isZero();
        assertThat(node(outline, "1.1 Process states").tokenCount()).isPositive();
    }

    /** Ordinal is document order, parents before children, so inserting the tree in this order satisfies the parent key. */
    @Test void ordinalsAreDocumentOrderStartingWithTheDocument() {
        var chunks = List.of(
                chunk(0, 1, "States.", heading(1, "1 Processes"), heading(2, "1.1 Process states")),
                chunk(1, 2, "Threads.", heading(1, "2 Threads")));
        var outline = DocumentOutline.of("OperatingSystems.pdf", chunks);
        assertThat(outline.nodes().stream().map(DocumentOutline.Node::ordinal)).containsExactlyElementsOf(IntStream.range(0, outline.nodes().size()).boxed().toList());
        for (var node : outline.nodes()) {
            if (node.parentId() == null) continue;
            assertThat(byId(outline, node.parentId()).ordinal()).isLessThan(node.ordinal());
        }
    }

    /** A citation naming a chapter has to span the chapter, so a section's page range covers what is inside it. */
    @Test void aSectionSpansThePagesOfItsSubsections() {
        var chunks = List.of(
                chunk(0, 1, "This chapter introduces processes.", heading(1, "1 Processes")),
                chunk(1, 4, "States are new, ready, running.", heading(1, "1 Processes"), heading(2, "1.1 Process states")));
        var outline = DocumentOutline.of("OperatingSystems.pdf", chunks);
        assertThat(node(outline, "1 Processes").pageStart()).isEqualTo(1);
        assertThat(node(outline, "1 Processes").pageEnd()).isEqualTo(4);
        assertThat(node(outline, "1.1 Process states").pageStart()).isEqualTo(4);
    }

    /** Two chapters may both end in "Summary". Merging them would pool two unrelated sections into one. */
    @Test void sectionsSharingATitleUnderDifferentChaptersStayDistinct() {
        var chunks = List.of(
                chunk(0, 1, "Processes recap.", heading(1, "1 Processes"), heading(2, "Summary")),
                chunk(1, 2, "Threads recap.", heading(1, "2 Threads"), heading(2, "Summary")));
        var outline = DocumentOutline.of("OperatingSystems.pdf", chunks);
        var summaries = outline.nodes().stream().filter(node -> node.title().equals("Summary")).toList();
        assertThat(summaries).hasSize(2);
        assertThat(summaries.get(0).parentId()).isNotEqualTo(summaries.get(1).parentId());
        assertThat(summaries.get(0).path()).isEqualTo("1 Processes > Summary");
        assertThat(summaries.get(1).path()).isEqualTo("2 Threads > Summary");
    }

    /**
     * The invariant the rest of the pipeline rests on: the path stored on a section is character-for-character the
     * trail folded into the {@code context_header} of the chunks bound to it. If the two could drift, the section a
     * passage was indexed under and the section the tree says it is in would be different sections.
     */
    @Test void aSectionsPathIsTheContextItsChunksWereIndexedWith() {
        String filler = ("Padding sentence for length. ".repeat(200)).trim();
        var document = new ExtractedDocument(List.of(
                new ParsedPage(1, "2 Cyclic codes\n\n2.1 Generator polynomials\n\n" + filler),
                new ParsedPage(2, "3 Convolutional codes\n\n" + filler)));
        var chunks = new StructureAwareChunker().chunk(document);
        var outline = DocumentOutline.of("Coding.pdf", chunks);
        assertThat(chunks).hasSizeGreaterThan(1);
        for (Chunk chunk : chunks) {
            assertThat(byId(outline, outline.chunkSections().get(chunk.id())).path()).isEqualTo(chunk.headingPath());
        }
        assertThat(titles(outline)).contains("2 Cyclic codes", "2.1 Generator polynomials", "3 Convolutional codes");
    }

    /** A document that extracted to nothing still gets its root, so no caller has to handle a document with no sections. */
    @Test void aDocumentWithNoChunksStillHasARoot() {
        var outline = DocumentOutline.of("empty.pdf", List.of());
        assertThat(outline.nodes()).hasSize(1);
        assertThat(outline.nodes().get(0).title()).isEqualTo("empty.pdf");
        assertThat(outline.nodes().get(0).rawText()).isEmpty();
        assertThat(outline.chunkSections()).isEmpty();
    }

    /** Document order comes from the ordinal, not from the order a caller happened to hand the chunks over in. */
    @Test void documentOrderComesFromTheOrdinalRatherThanTheListOrder() {
        var second = chunk(1, 2, "Threads.", heading(1, "2 Threads"));
        var first = chunk(0, 1, "Processes.", heading(1, "1 Processes"));
        var outline = DocumentOutline.of("OperatingSystems.pdf", List.of(second, first));
        assertThat(titles(outline)).containsExactly("OperatingSystems.pdf", "1 Processes", "2 Threads");
    }

    private static Heading heading(int level, String text) { return new Heading(level, text); }

    private static Chunk chunk(int ordinal, int page, String content, Heading... trail) {
        List<Heading> path = List.of(trail);
        return new Chunk(UUID.randomUUID(), ordinal, page, page, content, Math.max(1, content.length() / 4), Heading.path(path), path);
    }

    private static List<String> titles(DocumentOutline.Outline outline) { return outline.nodes().stream().map(DocumentOutline.Node::title).toList(); }

    private static DocumentOutline.Node node(DocumentOutline.Outline outline, String title) {
        return outline.nodes().stream().filter(node -> node.title().equals(title)).findFirst().orElseThrow(() -> new AssertionError("no section titled " + title));
    }

    private static DocumentOutline.Node byId(DocumentOutline.Outline outline, UUID id) {
        return outline.nodes().stream().filter(node -> node.id().equals(id)).findFirst().orElseThrow(() -> new AssertionError("no section " + id));
    }

    private static String parentTitle(DocumentOutline.Outline outline, String title) { return byId(outline, node(outline, title).parentId()).title(); }
}
