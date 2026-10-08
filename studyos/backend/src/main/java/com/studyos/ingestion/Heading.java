package com.studyos.ingestion;

import java.util.List;
import java.util.stream.Collectors;

/**
 * One heading in a document's own outline, at the depth its numbering or markup puts it.
 *
 * <p>Its own type rather than a detail of {@link HeadingPath} because two things need it now: the detector that
 * recognises headings while chunking, and {@link DocumentOutline}, which turns them into stored sections. Both
 * have to agree on the rendered form, so {@link #path(List)} is the single place a trail becomes a string. A
 * section stored with a path that differed even by a separator from the one folded into
 * {@code chunks.context_header} would quietly break the link between what retrieval matched and what the
 * document tree says that text is part of.
 */
public record Heading(int level, String text) {
    /** Also the separator inside {@code chunks.context_header}, which is why only this class writes it. */
    private static final String SEPARATOR = " > ";

    /** A trail rendered outermost first, or empty when the document offers no structure at all. */
    public static String path(List<Heading> trail) {
        return trail == null ? "" : trail.stream().map(Heading::text).collect(Collectors.joining(SEPARATOR));
    }
}
