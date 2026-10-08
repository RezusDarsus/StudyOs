package com.studyos.ingestion;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Preserves page provenance while keeping chunks bounded for retrieval and embedding requests.
 *
 * <p>Each chunk also carries the document's section trail as it stood where the chunk begins. That trail is
 * what makes a chunk carved out of the middle of a section retrievable: on its own the text may never repeat
 * the name of the thing it is explaining. See {@link HeadingPath} for how sections are recognised without
 * knowing anything about the subject.
 */
@Component
public class StructureAwareChunker {
    private static final int TARGET_CHARS = 3200;

    public List<Chunk> chunk(ExtractedDocument document) {
        List<Chunk> result = new ArrayList<>();
        HeadingPath outline = new HeadingPath();
        StringBuilder buffer = new StringBuilder();
        List<Heading> trail = List.of();
        // A chunk is titled by the headings that open it. Once its own body has started, a heading further down
        // belongs to what comes after, and retitling the chunk with it would label the text already collected.
        boolean titleOnly = true;
        int startPage = 1;
        int endPage = 1;
        int ordinal = 0;
        for (ParsedPage page : document.pages()) {
            if (buffer.isEmpty()) startPage = page.pageNumber();
            endPage = page.pageNumber();
            for (String paragraph : page.text().split("\\n\\s*\\n")) {
                String clean = paragraph.trim();
                if (clean.isBlank()) continue;
                boolean heading = outline.observe(clean);
                if (titleOnly) trail = outline.trail();
                titleOnly = titleOnly && heading;
                for (int offset = 0; offset < clean.length(); offset += TARGET_CHARS) {
                    String part = clean.substring(offset, Math.min(offset + TARGET_CHARS, clean.length()));
                    if (buffer.length() > 0 && buffer.length() + part.length() + 2 > TARGET_CHARS) {
                        result.add(makeChunk(ordinal++, startPage, endPage, buffer.toString(), trail));
                        buffer.setLength(0);
                        startPage = page.pageNumber();
                        trail = outline.trail();
                        titleOnly = heading;
                    }
                    buffer.append(part).append("\n\n");
                }
            }
        }
        if (!buffer.isEmpty()) result.add(makeChunk(ordinal, startPage, endPage, buffer.toString(), trail));
        return result;
    }

    /**
     * The rendered path is derived from the trail here rather than captured beside it, so the two can never
     * disagree: the string that reaches {@code chunks.context_header} and the levels that reach
     * {@code document_sections} are two views of one snapshot.
     */
    private Chunk makeChunk(int ordinal, int startPage, int endPage, String content, List<Heading> trail) {
        String clean = content.trim();
        return new Chunk(UUID.randomUUID(), ordinal, startPage, endPage, clean, Math.max(1, clean.length() / 4), Heading.path(trail), trail);
    }
}
