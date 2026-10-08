package com.studyos.ingestion;

import java.util.List;
import java.util.UUID;

/**
 * @param headingPath the document's own section trail at the point this chunk begins, or empty when the
 *     document offers no structure. It is context for retrieval, not part of the source text, so it is stored
 *     and indexed separately from {@code content} and never quoted back as evidence.
 * @param headingTrail the same trail with its levels intact, for {@link DocumentOutline} to rebuild the
 *     document's tree from. It is not stored on the chunk row: {@code headingPath} is what gets embedded and
 *     indexed, and the trail is what says whether two adjacent sections nest or are siblings — a distinction
 *     the rendered string loses. Empty for chunks read back from the database, which only kept the string.
 */
public record Chunk(UUID id, int ordinal, int pageStart, int pageEnd, String content, int tokenCount, String headingPath, List<Heading> headingTrail) {
    public Chunk(UUID id, int ordinal, int pageStart, int pageEnd, String content, int tokenCount) {
        this(id, ordinal, pageStart, pageEnd, content, tokenCount, "", List.of());
    }

    public Chunk(UUID id, int ordinal, int pageStart, int pageEnd, String content, int tokenCount, String headingPath) {
        this(id, ordinal, pageStart, pageEnd, content, tokenCount, headingPath, List.of());
    }

    public Chunk {
        headingPath = headingPath == null ? "" : headingPath;
        headingTrail = headingTrail == null ? List.of() : List.copyOf(headingTrail);
    }
}
