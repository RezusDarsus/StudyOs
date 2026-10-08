package com.studyos.summary;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Turns a document's section tree into summaries, composing each section from the sections inside it.
 *
 * <p>What this replaces is worth naming, because the old behaviour looked like a hierarchy and was not one. A
 * document's summary was the first sentences of its first eight chunks, and a "section" summary was the first
 * sentences of one page. So the summary of a document was the summary of its opening, and nothing anywhere
 * described a chapter. A chapter is exactly what a student navigating a course needs summarised.
 *
 * <p>Composing upwards is what fixes it: a leaf is summarised from its own text, and every section above it from
 * its own text plus the summaries of its children. The document's summary is then the root's, which means it is
 * built from every part of the document rather than from whichever part happened to be first.
 *
 * <p>Pure and deterministic — no database, no AI provider, extractive rather than generative. The same tree
 * always yields the same summaries, which is what lets this be tested on fixtures instead of on a model's mood.
 * Generating better prose is a later concern; getting the shape right is this one.
 */
public final class HierarchicalSummarizer {
    /** A section summary is a paragraph. A document summary is allowed to be a long one. */
    static final int SECTION_MAX = 700;
    static final int DOCUMENT_MAX = 1000;
    /** However many children a section has, each still gets enough room to say something. */
    private static final int MIN_SHARE = 80;
    /** The level {@code DocumentOutline} gives the node standing for the document itself. */
    private static final int ROOT_LEVEL = 0;

    private HierarchicalSummarizer() {}

    /**
     * @param nodes one document's sections. Order does not matter; document order is read from
     *     {@link Node#ordinal()} and parenthood from {@link Node#parentId()}.
     */
    public static Result summarize(List<Node> nodes) {
        List<Node> ordered = nodes == null ? List.<Node>of() : nodes.stream().sorted(Comparator.comparingInt(Node::ordinal)).toList();
        Map<UUID, List<Node>> children = new HashMap<>();
        List<Node> roots = new ArrayList<>();
        for (Node node : ordered) {
            if (node.parentId() == null) roots.add(node);
            else children.computeIfAbsent(node.parentId(), key -> new ArrayList<>()).add(node);
        }

        Map<UUID, Composed> composed = new HashMap<>();
        for (int index = ordered.size() - 1; index >= 0; index--) {
            Node node = ordered.get(index);
            composed.put(node.id(), compose(node, children.getOrDefault(node.id(), List.of()), composed));
        }

        // A document is not one of its own sections. When ingestion wrote a root for it, the root's composition is
        // the document's summary and the root itself is not reported as a section. Documents structured before
        // that — a flat row per page, every row a root — have no such node, so the document is composed from all
        // of them and each still stands as its own section. Both shapes have to work: the old rows stay until
        // their document is restructured.
        Node root = roots.size() == 1 && roots.get(0).level() == ROOT_LEVEL ? roots.get(0) : null;
        Composed document = root != null ? composed.get(root.id()) : merge(roots.stream().map(node -> composed.get(node.id())).toList(), DOCUMENT_MAX);
        List<Section> sections = new ArrayList<>();
        for (Node node : ordered) {
            if (node == root) continue;
            Composed value = composed.get(node.id());
            // A section whose composition is empty has no text of its own and no descendant with any, so skipping
            // it cannot orphan anything below it. That is why an empty chapter disappears whole rather than
            // becoming a row that summarises nothing.
            if (value.summary().isBlank()) continue;
            sections.add(new Section(node.id(), node.parentId(), node.level(), node.ordinal(), node.title(), value.summary(), value.sourceCount()));
        }
        return new Result(document.summary(), document.sourceCount(), List.copyOf(sections));
    }

    private static Composed compose(Node node, List<Node> children, Map<UUID, Composed> composed) {
        int max = node.level() <= ROOT_LEVEL ? DOCUMENT_MAX : SECTION_MAX;
        List<Composed> parts = new ArrayList<>();
        String own = condense(node.rawText(), max);
        if (!own.isBlank()) parts.add(new Composed(own, 1));
        for (Node child : children) {
            Composed value = composed.get(child.id());
            if (value != null && !value.summary().isBlank()) parts.add(value);
        }
        return merge(parts, max);
    }

    /**
     * Every part gets an equal share of the budget, so a long opening section cannot crowd the rest of a chapter
     * out of the chapter's own summary — which is precisely how summarising the first eight chunks used to fail.
     */
    private static Composed merge(List<Composed> parts, int max) {
        List<Composed> present = parts.stream().filter(part -> part != null && !part.summary().isBlank()).toList();
        if (present.isEmpty()) return new Composed("", 0);
        int share = Math.max(MIN_SHARE, max / present.size());
        StringBuilder result = new StringBuilder();
        int sources = 0;
        for (Composed part : present) {
            sources += part.sourceCount();
            String piece = condense(part.summary(), share);
            if (piece.isBlank()) continue;
            if (result.length() > 0) result.append(' ');
            result.append(piece);
        }
        return new Composed(condense(result.toString(), max), sources);
    }

    /**
     * Cut on a sentence boundary rather than mid-word, and only fall back to a hard cut when the text offers no
     * boundary to cut on. Lifted unchanged from {@code SummaryService} so the sentence shaping that has always
     * been applied to summaries still is.
     */
    static String condense(String raw, int max) {
        if (raw == null || raw.isBlank()) return "";
        String text = raw.replaceAll("\\s+", " ").trim();
        StringBuilder result = new StringBuilder();
        for (String sentence : text.split("(?<=[.!?])\\s+")) {
            if (sentence.isBlank()) continue;
            if (result.length() > 0 && result.length() + sentence.length() + 1 > max) break;
            if (result.length() > 0) result.append(' ');
            result.append(sentence);
            if (result.length() >= max * 0.65) break;
        }
        if (result.isEmpty()) result.append(text, 0, Math.min(max, text.length()));
        // The first sentence is taken whatever its length, because taking none of it would be worse — but a single
        // sentence longer than the entire budget used to be returned in full, and text without sentence
        // punctuation at all is one such sentence. That made the budget advisory, and a summary composed of
        // over-budget parts overruns at every level above it too. Now it is a real ceiling.
        return result.length() <= max ? result.toString() : result.substring(0, max).strip();
    }

    /** @param rawText the section's own text, excluding its subsections — the whole basis of composing upwards. */
    public record Node(UUID id, UUID parentId, int level, int ordinal, String title, String rawText) {}

    /**
     * @param parentNodeId the parent <em>section</em>, which the caller maps to the parent summary's id. Null, or
     *     the excluded root, means this section's summary hangs directly off the document's.
     * @param sourceCount how many sections' text reached this summary, itself included. Counts contributions, so
     *     a chapter that only points at its subsections reports theirs and not a phantom one of its own.
     */
    public record Section(UUID nodeId, UUID parentNodeId, int level, int ordinal, String title, String summary, int sourceCount) {}

    /** @param documentSummary empty when the document's sections hold no text at all — never a fabricated line. */
    public record Result(String documentSummary, int documentSourceCount, List<Section> sections) {}

    private record Composed(String summary, int sourceCount) {}
}
