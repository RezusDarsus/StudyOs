package com.studyos.summary;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.summary.HierarchicalSummarizer.Node;
import com.studyos.summary.HierarchicalSummarizer.Result;
import com.studyos.summary.HierarchicalSummarizer.Section;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class HierarchicalSummarizerTest {
    private static final UUID ROOT = UUID.randomUUID();
    private static final UUID PROCESSES = UUID.randomUUID();
    private static final UUID STATES = UUID.randomUUID();
    private static final UUID PCB = UUID.randomUUID();
    private static final UUID THREADS = UUID.randomUUID();
    private static final UUID USER_THREADS = UUID.randomUUID();

    /**
     * A document's summary used to be the first sentences of its first eight chunks, so a chapter summary was the
     * summary of the chapter's opening paragraph. Composing upwards is what makes it a summary of the chapter.
     */
    @Test void aChapterIsComposedFromItsSubsectionsRatherThanItsOpening() {
        String summary = section(HierarchicalSummarizer.summarize(course()), "1 Processes").summary();
        assertThat(summary).contains("introduces processes").contains("new, ready, or running").contains("saved registers");
    }

    /** The document summary reaches the last section as well as the first, which summarising the opening never did. */
    @Test void theDocumentSummaryIsBuiltFromEveryPartRatherThanTheFirst() {
        Result result = HierarchicalSummarizer.summarize(course());
        assertThat(result.documentSummary()).contains("new, ready, or running").contains("cheap to create");
    }

    /** A document is not one of its own sections: its composition becomes the DOCUMENT summary, not a SECTION row. */
    @Test void theDocumentIsNotReportedAsOneOfItsOwnSections() {
        Result result = HierarchicalSummarizer.summarize(course());
        assertThat(result.sections()).extracting(Section::nodeId).doesNotContain(ROOT);
        assertThat(result.sections()).extracting(Section::title).containsExactly("1 Processes", "1.1 Process states", "1.2 PCB", "2 Threads", "2.1 User threads");
    }

    /**
     * Source count is contributions, so a chapter that only introduces its subsections reports theirs and not a
     * phantom one of its own. A count of sections read is the only honest reading now that a section is not a page.
     */
    @Test void sourceCountCountsTheSectionsWhoseTextReachedTheSummary() {
        Result result = HierarchicalSummarizer.summarize(course());
        assertThat(section(result, "1.1 Process states").sourceCount()).isEqualTo(1);
        assertThat(section(result, "1 Processes").sourceCount()).isEqualTo(3);
        assertThat(section(result, "2 Threads").sourceCount()).isEqualTo(1);
        assertThat(result.documentSourceCount()).isEqualTo(4);
    }

    /** A heading with no text directly under it still stands as a section, summarised by what is inside it. */
    @Test void aChapterWithNoTextOfItsOwnIsSummarisedByItsSubsections() {
        assertThat(section(HierarchicalSummarizer.summarize(course()), "2 Threads").summary()).contains("cheap to create");
    }

    /**
     * An empty subtree disappears whole rather than becoming rows that summarise nothing. It is safe to drop the
     * parent because a parent's composition contains its children's: if the parent composed to nothing, so did they.
     */
    @Test void anEmptySubtreeProducesNoSummaryNodeAtAll() {
        UUID appendix = UUID.randomUUID();
        var nodes = new java.util.ArrayList<>(course());
        nodes.add(new Node(appendix, ROOT, 1, 6, "3 Appendix", ""));
        nodes.add(new Node(UUID.randomUUID(), appendix, 2, 7, "3.1 Tables", "   "));
        Result result = HierarchicalSummarizer.summarize(nodes);
        assertThat(result.sections()).extracting(Section::title).doesNotContain("3 Appendix", "3.1 Tables");
        assertThat(result.documentSummary()).contains("cheap to create");
    }

    /** The parent link is by section, which is what lets the caller hang each summary off its parent's summary. */
    @Test void eachSectionNamesTheSectionItSitsUnder() {
        Result result = HierarchicalSummarizer.summarize(course());
        assertThat(section(result, "1.1 Process states").parentNodeId()).isEqualTo(PROCESSES);
        assertThat(section(result, "2.1 User threads").parentNodeId()).isEqualTo(THREADS);
        // The chapters point at the excluded root, which the caller resolves to the DOCUMENT summary.
        assertThat(section(result, "1 Processes").parentNodeId()).isEqualTo(ROOT);
        assertThat(result.sections()).extracting(Section::nodeId).doesNotContain(ROOT);
    }

    /**
     * Documents ingested before sections were a tree hold a flat row per page, every row a root and none of them a
     * document. Those rows stay until the document is restructured, so both shapes have to produce summaries.
     */
    @Test void aFlatPagePerSectionDocumentStillGetsADocumentSummary() {
        var flat = List.of(
                new Node(UUID.randomUUID(), null, 1, 0, "Page 1", "A process is a program in execution."),
                new Node(UUID.randomUUID(), null, 1, 1, "Page 2", "Threads share one address space."));
        Result result = HierarchicalSummarizer.summarize(flat);
        assertThat(result.documentSummary()).contains("program in execution").contains("address space");
        assertThat(result.documentSourceCount()).isEqualTo(2);
        assertThat(result.sections()).extracting(Section::title).containsExactly("Page 1", "Page 2");
    }

    /** Document order comes from the ordinal, not from the order the rows arrived in. */
    @Test void sectionsComeBackInDocumentOrder() {
        var shuffled = new java.util.ArrayList<>(course());
        java.util.Collections.reverse(shuffled);
        Result result = HierarchicalSummarizer.summarize(shuffled);
        assertThat(result.sections()).extracting(Section::ordinal).containsExactly(1, 2, 3, 4, 5);
    }

    /**
     * The failure the old summariser had, in one test: a long opening section used the whole budget and everything
     * after it was never mentioned. Each part gets an equal share, so the last subsection still gets a line.
     */
    @Test void oneLongSubsectionCannotCrowdOutTheRestOfTheChapter() {
        UUID chapter = UUID.randomUUID();
        var nodes = List.of(
                new Node(ROOT, null, 0, 0, "Networks.pdf", ""),
                new Node(chapter, ROOT, 1, 1, "4 Routing", ""),
                new Node(UUID.randomUUID(), chapter, 2, 2, "4.1 Link state", "Alpha detail about flooding link state updates. ".repeat(60).trim()),
                new Node(UUID.randomUUID(), chapter, 2, 3, "4.2 Distance vector", "Omega detail about counting to infinity."));
        Result result = HierarchicalSummarizer.summarize(nodes);
        assertThat(section(result, "4 Routing").summary()).contains("Alpha detail").contains("Omega detail");
        assertThat(result.documentSummary()).contains("Omega detail");
    }

    /**
     * The budget is a ceiling, not a suggestion. Text with no sentence punctuation at all — a table, a page of
     * formulae — is one enormous sentence, and the first sentence is always taken, so this is the case where an
     * unclamped summary escaped its budget and carried the overrun up every level above it.
     */
    @Test void aSectionWithNoSentenceBoundariesIsStillCutToItsBudget() {
        var nodes = List.of(
                new Node(ROOT, null, 0, 0, "Tables.pdf", ""),
                new Node(PROCESSES, ROOT, 1, 1, "Appendix A", "value ".repeat(800).trim()));
        Result result = HierarchicalSummarizer.summarize(nodes);
        assertThat(section(result, "Appendix A").summary().length()).isLessThanOrEqualTo(700);
        assertThat(result.documentSummary().length()).isLessThanOrEqualTo(1000);
        assertThat(result.documentSummary()).startsWith("value");
    }

    /** Every summary in an ordinary tree stays within the budget its level allows. */
    @Test void summariesStayWithinTheBudgetForTheirLevel() {
        Result result = HierarchicalSummarizer.summarize(course());
        assertThat(result.documentSummary().length()).isLessThanOrEqualTo(1000);
        assertThat(result.sections()).allSatisfy(section -> assertThat(section.summary().length()).isLessThanOrEqualTo(700));
    }

    /** A document whose sections hold no text gets no summary rather than a fabricated line about nothing. */
    @Test void aDocumentWithNoTextAnywhereGetsNoSummaryAtAll() {
        Result result = HierarchicalSummarizer.summarize(List.of(new Node(ROOT, null, 0, 0, "empty.pdf", "")));
        assertThat(result.documentSummary()).isEmpty();
        assertThat(result.documentSourceCount()).isZero();
        assertThat(result.sections()).isEmpty();
    }

    /** A document that produced no sections at all is a caller's edge case, not an exception. */
    @Test void noSectionsAtAllIsAnsweredRatherThanThrown() {
        Result result = HierarchicalSummarizer.summarize(List.of());
        assertThat(result.documentSummary()).isEmpty();
        assertThat(result.sections()).isEmpty();
        assertThat(HierarchicalSummarizer.summarize(null).documentSummary()).isEmpty();
    }

    /** A two-chapter document with a chapter that introduces its subsections and one that does not. */
    private static List<Node> course() {
        return List.of(
                new Node(ROOT, null, 0, 0, "OperatingSystems.pdf", ""),
                new Node(PROCESSES, ROOT, 1, 1, "1 Processes", "This chapter introduces processes."),
                new Node(STATES, PROCESSES, 2, 2, "1.1 Process states", "A process is new, ready, or running."),
                new Node(PCB, PROCESSES, 2, 3, "1.2 PCB", "The PCB stores the saved registers."),
                new Node(THREADS, ROOT, 1, 4, "2 Threads", ""),
                new Node(USER_THREADS, THREADS, 2, 5, "2.1 User threads", "User threads are cheap to create."));
    }

    private static Section section(Result result, String title) {
        return result.sections().stream().filter(section -> section.title().equals(title)).findFirst().orElseThrow(() -> new AssertionError("no summary for section " + title));
    }
}
