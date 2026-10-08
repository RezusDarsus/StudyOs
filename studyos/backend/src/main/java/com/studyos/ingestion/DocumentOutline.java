package com.studyos.ingestion;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * A document's own outline as a tree of sections, with the section each chunk belongs to.
 *
 * <p>{@code document_sections} has been able to hold a hierarchy since the first migration, and ingestion filled
 * it with one pseudo-section per page — "Page 7", level 1, no parent. The document's real outline was walked a
 * few lines later by {@link StructureAwareChunker} and then thrown away, surviving only collapsed into
 * {@code chunks.context_header}. Nothing downstream could ask what chapter a passage was in, which section
 * followed it, or what the section as a whole said, because pages answer none of those.
 *
 * <p>This turns the trail each chunk already carries back into the tree it came from. It is deliberately free of
 * the database and of any AI provider: given the same chunks it produces the same tree, which is what makes both
 * the structure and the summaries built on it testable on fixtures.
 *
 * <p>Two decisions are worth stating because they bound what callers may assume:
 *
 * <ul>
 *   <li><b>Every document gets a root.</b> A document is not one of its own sections, so the root sits at
 *       {@link #DOCUMENT_LEVEL} below the first heading level. It gives front matter — everything before the
 *       first heading — somewhere to belong instead of a null section, it gives an unstructured document exactly
 *       one node instead of a page-per-row fiction, and it means walking {@code parent_section_id} upwards always
 *       terminates somewhere known.
 *   <li><b>A section's text is the text of its own chunks.</b> Not its subsections' text, so a parent summary is
 *       composed from its children rather than repeating them; and chunk-granular rather than character-exact,
 *       because chunks are the unit retrieval and citation already work in. A section's text is therefore
 *       reconstructible from the chunk rows, and a chunk that happens to run past a heading is counted once,
 *       under the section it started in.
 * </ul>
 */
public final class DocumentOutline {
    /** The document itself. Headings start at 1, so 0 is free for the one node that is not a heading. */
    public static final int DOCUMENT_LEVEL = 0;
    private static final String UNTITLED = "Document";
    private static final String JOIN = "\n\n";

    private DocumentOutline() {}

    /**
     * @param documentName titles the root node. Only a name — this class never reads the stored file.
     * @param chunks in any order; document order is taken from {@link Chunk#ordinal()}, not from the list.
     */
    public static Outline of(String documentName, List<Chunk> chunks) {
        List<Chunk> ordered = chunks == null ? List.<Chunk>of() : chunks.stream().sorted(Comparator.comparingInt(Chunk::ordinal)).toList();
        List<Section> built = new ArrayList<>();
        List<Section> open = new ArrayList<>();
        List<Heading> openTrail = new ArrayList<>();
        Map<UUID, UUID> bindings = new LinkedHashMap<>();

        Section root = new Section(null, DOCUMENT_LEVEL, title(documentName), "", 0, ordered.isEmpty() ? 1 : ordered.get(0).pageStart());
        built.add(root);
        open.add(root);

        for (Chunk chunk : ordered) {
            List<Heading> trail = chunk.headingTrail();
            int shared = shared(openTrail, trail);
            // A heading that is not a continuation of the open trail closed every section below where they agree.
            while (openTrail.size() > shared) { openTrail.remove(openTrail.size() - 1); open.remove(open.size() - 1); }
            for (int depth = shared; depth < trail.size(); depth++) {
                Heading heading = trail.get(depth);
                openTrail.add(heading);
                Section parent = open.get(open.size() - 1);
                Section section = new Section(parent.id, Math.max(DOCUMENT_LEVEL + 1, heading.level()), heading.text(), Heading.path(openTrail), built.size(), chunk.pageStart());
                built.add(section);
                open.add(section);
            }
            Section section = open.get(open.size() - 1);
            bindings.put(chunk.id(), section.id);
            section.absorb(chunk);
        }

        return new Outline(nodes(built), Map.copyOf(bindings));
    }

    /**
     * How many headings the open trail and the next one agree on. Level and text both have to match, so a
     * document that names two subsections the same under different chapters gets two sections, and a sibling
     * ("3.1" then "3.2") closes its predecessor instead of nesting inside it.
     */
    private static int shared(List<Heading> open, List<Heading> next) {
        int shared = 0;
        while (shared < open.size() && shared < next.size() && open.get(shared).equals(next.get(shared))) shared++;
        return shared;
    }

    /**
     * A section's own chunks give it its text and the pages it directly covers; the range reported for it also
     * covers its subsections, because that is what a citation naming the section has to span. Children precede
     * their parents here — sections are built in document order, so a reverse walk sees a subtree before its top.
     */
    private static List<Node> nodes(List<Section> built) {
        Map<UUID, Section> byId = new HashMap<>();
        for (Section section : built) byId.put(section.id, section);
        for (int index = built.size() - 1; index >= 1; index--) {
            Section section = built.get(index);
            Section parent = byId.get(section.parentId);
            if (parent == null) continue;
            parent.pageStart = Math.min(parent.pageStart, section.pageStart);
            parent.pageEnd = Math.max(parent.pageEnd, section.pageEnd);
        }
        return built.stream().map(Section::toNode).toList();
    }

    private static String title(String documentName) {
        String clean = documentName == null ? "" : documentName.strip();
        return clean.isEmpty() ? UNTITLED : clean;
    }

    /**
     * @param id the section's own identifier, ready for {@code document_sections.id}
     * @param parentId null only for the document root
     * @param level {@link #DOCUMENT_LEVEL} for the root, then the heading's own depth
     * @param path the rendered trail, empty for the root. Byte-identical to the trail folded into the
     *     {@code context_header} of the chunks bound here, because {@link Heading#path} builds both.
     * @param ordinal document order, contiguous from 0 at the root, parents before children
     * @param rawText this section's own text, excluding its subsections. Empty for a heading with nothing under
     *     it, which is a measured emptiness and not an unknown.
     */
    public record Node(UUID id, UUID parentId, int level, String title, String path, int ordinal, int pageStart, int pageEnd, String rawText, int tokenCount) {}

    /** @param chunkSections the section each chunk belongs to, by chunk id. Never null-valued, never partial. */
    public record Outline(List<Node> nodes, Map<UUID, UUID> chunkSections) {
        /** The deepest heading level reached, or {@link #DOCUMENT_LEVEL} when the document offers no structure. */
        public int depth() { return nodes.stream().mapToInt(Node::level).max().orElse(DOCUMENT_LEVEL); }
    }

    /** Mutable while the tree is being walked; a {@link Node} once its page range and text are settled. */
    private static final class Section {
        private final UUID id = UUID.randomUUID();
        private final UUID parentId;
        private final int level;
        private final String title;
        private final String path;
        private final int ordinal;
        private final StringBuilder text = new StringBuilder();
        private int pageStart;
        private int pageEnd;

        private Section(UUID parentId, int level, String title, String path, int ordinal, int page) {
            this.parentId = parentId; this.level = level; this.title = title; this.path = path; this.ordinal = ordinal; this.pageStart = page; this.pageEnd = page;
        }

        private void absorb(Chunk chunk) {
            if (text.length() > 0) text.append(JOIN);
            text.append(chunk.content());
            pageStart = Math.min(pageStart, chunk.pageStart());
            pageEnd = Math.max(pageEnd, chunk.pageEnd());
        }

        private Node toNode() {
            String raw = text.toString().strip();
            return new Node(id, parentId, level, title, path, ordinal, pageStart, pageEnd, raw, raw.isEmpty() ? 0 : Math.max(1, raw.length() / 4));
        }
    }
}
