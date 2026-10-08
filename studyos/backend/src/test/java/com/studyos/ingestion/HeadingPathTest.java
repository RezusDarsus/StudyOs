package com.studyos.ingestion;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class HeadingPathTest {
    @Test void numberedHeadingsNestByTheirNumbering() {
        HeadingPath outline = new HeadingPath();
        outline.observe("3 Cyclic codes");
        outline.observe("3.1 Generator polynomials");
        assertThat(outline.path()).isEqualTo("3 Cyclic codes > 3.1 Generator polynomials");
        outline.observe("3.2 Systematic encoding");
        assertThat(outline.path()).isEqualTo("3 Cyclic codes > 3.2 Systematic encoding");
        outline.observe("4 Convolutional codes");
        assertThat(outline.path()).isEqualTo("4 Convolutional codes");
    }

    /** The trail is a path, not a log: a sibling replaces its sibling instead of accumulating beside it. */
    @Test void aSectionEndsWhenItsSiblingBegins() {
        HeadingPath outline = new HeadingPath();
        outline.observe("## Verbos irregulares\n### Presente\n### Pretérito");
        assertThat(outline.path()).isEqualTo("Verbos irregulares > Pretérito");
    }

    /** The whole point of detecting structurally: nothing here is an English word, and it still works. */
    @Test void recognitionRestsOnFormRatherThanVocabulary() {
        assertThat(HeadingPath.heading("2.4 Sätze über Vektorräume")).isNotNull();
        assertThat(HeadingPath.heading("CAPÍTULO PRIMERO")).isNotNull();
        assertThat(HeadingPath.heading("# 誤り検出")).isNotNull();
    }

    /** A sentence that happens to open with a figure is prose, and titling a chunk with it is worse than nothing. */
    @Test void proseIsNotMistakenForAHeading() {
        assertThat(HeadingPath.heading("10 points are awarded for a correct derivation")).isNull();
        assertThat(HeadingPath.heading("3.2 shows that the bound is tight.")).isNull();
        assertThat(HeadingPath.heading("1998 was the year the standard was ratified")).isNull();
        assertThat(HeadingPath.heading("This paragraph runs on and on and on and on and on and on and on and on")).isNull();
    }

    @Test void trailingColonsAndMarkupAreNotPartOfTheTitle() {
        assertThat(HeadingPath.heading("## Error detection:").text()).isEqualTo("Error detection");
    }

    @Test void aDocumentWithNoStructureYieldsNoPath() {
        HeadingPath outline = new HeadingPath();
        outline.observe("Plain prose, wrapped over two lines,\nwith nothing that resembles a title.");
        assertThat(outline.path()).isEmpty();
        assertThat(outline.trail()).isEmpty();
    }

    /**
     * The levels are what turn a path into a tree, and collapsing the trail to a string loses them: as strings,
     * "1 Processes > 1.1 States" and "1 Processes > 2 Threads" are the same shape, and only the levels say that the
     * first pair nests while the second pair are siblings. Both views come from one trail, so they cannot disagree.
     */
    @Test void theTrailKeepsTheLevelsThePathCollapses() {
        HeadingPath outline = new HeadingPath();
        outline.observe("3 Cyclic codes\n3.1 Generator polynomials");
        assertThat(outline.trail()).extracting(Heading::text).containsExactly("3 Cyclic codes", "3.1 Generator polynomials");
        assertThat(outline.trail().get(0).level()).isLessThan(outline.trail().get(1).level());
        assertThat(Heading.path(outline.trail())).isEqualTo(outline.path());
    }

    /** Deep numbering is bounded so a pathological outline cannot grow the context without limit. */
    @Test void depthIsBounded() {
        HeadingPath outline = new HeadingPath();
        outline.observe("1 Codes\n1.1 Linear codes\n1.1.1 Dual codes\n1.1.1.1 Weight enumerators\n1.1.1.1.1 MacWilliams identity");
        assertThat(outline.path().split(" > ")).hasSizeLessThanOrEqualTo(4);
        assertThat(outline.path()).endsWith("1.1.1.1.1 MacWilliams identity");
    }
}
