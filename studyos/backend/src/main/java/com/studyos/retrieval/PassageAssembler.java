package com.studyos.retrieval;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Turns ranked chunks into the passages an answer is actually written from: expanded to their neighbours,
 * consolidated within a section, and selected whole against a budget.
 *
 * <p>Three measured problems, all downstream of ranking rather than in it, which is why nothing here changes how
 * a chunk is found:
 *
 * <ol>
 *   <li>A chunk is a window, not an argument. Retrieval matches the window holding the term and hands over prose
 *       that begins mid-derivation and stops before the conclusion, so the model is asked to explain something it
 *       was shown the middle of. The chunk either side is usually the rest of it.
 *   <li>Several chunks of one section arrived as several blocks, each repeating the same document and section
 *       header, and each reading as separate evidence. They are one stretch of text and now say so.
 *   <li>The evidence block was assembled and then cut to the token budget with a substring, so the last passage
 *       in it ended mid-word — and its {@code [Source: …]} line still claimed the pages of the part that had been
 *       cut away. An answer could cite a page whose text the model never received. Selection is now by whole
 *       passage: what does not fit is dropped and said to have been dropped.
 * </ol>
 *
 * <p>Pure and deterministic — no database, no provider, no clock. The caller supplies the matched chunks and the
 * rows around them; every decision about what belongs together is made here so it can be tested on fixtures.
 */
public final class PassageAssembler {
    /**
     * How far either side of a match a neighbour may be pulled in. One chunk is the sentence that finishes the
     * thought; two starts including text that matched nothing and pushes out a passage that did.
     */
    public static final int NEIGHBOUR_RADIUS = 1;
    /** Chunks of one section are consecutive text, so they join as paragraphs of it. */
    private static final String JOIN = "\n\n";

    private PassageAssembler() {}

    /**
     * @param candidates the retrieved chunks plus the rows within {@link #NEIGHBOUR_RADIUS} of them, in any order.
     *     Duplicates are folded, preferring the matched copy, so a caller may pass a chunk that is both.
     * @param charBudget the ceiling on the total length of the selected passages. Zero or less means unbounded: a
     *     caller wanting no evidence asks for no chunks, and a zero budget silently blanking the block is the
     *     failure this is written to avoid.
     */
    public static Assembly assemble(List<Candidate> candidates, int charBudget) {
        Map<UUID, Candidate> unique = new LinkedHashMap<>();
        for (Candidate candidate : candidates == null ? List.<Candidate>of() : candidates) {
            if (candidate == null) continue;
            unique.merge(candidate.id(), candidate, (existing, other) -> existing.matched() ? existing : other);
        }

        // Section first, because a section is the boundary of what belongs together: the chunk after this one is
        // the rest of the argument only while it is still inside the same section.
        Map<UUID, List<Candidate>> sections = new LinkedHashMap<>();
        for (Candidate candidate : unique.values()) sections.computeIfAbsent(candidate.sectionKey(), key -> new ArrayList<>()).add(candidate);

        List<Passage> passages = new ArrayList<>();
        for (List<Candidate> section : sections.values()) {
            List<Candidate> kept = withinReach(section.stream().sorted(Comparator.comparingInt(Candidate::ordinal)).toList());
            List<Candidate> run = new ArrayList<>();
            for (Candidate candidate : kept) {
                // A gap in the ordinals is text that was not supplied, and joining across it would present two
                // separated stretches as one continuous one. Two passages of the same section is the honest shape.
                if (!run.isEmpty() && candidate.ordinal() - run.get(run.size() - 1).ordinal() > 1) { emit(run, passages); run = new ArrayList<>(); }
                run.add(candidate);
            }
            emit(run, passages);
        }

        List<Passage> ranked = passages.stream().sorted(Comparator.comparingDouble(Passage::score).reversed()
                .thenComparing(Passage::documentName, Comparator.nullsFirst(Comparator.naturalOrder()))
                .thenComparingInt(Passage::firstOrdinal)).toList();

        List<Passage> selected = new ArrayList<>();
        int used = 0;
        int dropped = 0;
        for (Passage passage : ranked) {
            int cost = passage.content().length();
            if (charBudget > 0 && selected.isEmpty() && cost > charBudget) {
                // The best passage alone overruns the budget. Cutting it is still better than answering with no
                // evidence at all, and it is the one case where a passage is reported narrower than it is.
                selected.add(passage.cutTo(charBudget));
                used = charBudget;
                continue;
            }
            if (charBudget > 0 && used + cost > charBudget) { dropped++; continue; }
            selected.add(passage);
            used += cost;
        }
        return new Assembly(List.copyOf(selected), passages.size(), dropped, used);
    }

    /**
     * Drops neighbours that no match in their own section is near. The caller reads a window out of the document,
     * so a chunk pulled in for a match in the previous section arrives here having nothing to do with anything
     * this section matched.
     */
    private static List<Candidate> withinReach(List<Candidate> ordered) {
        List<Candidate> kept = new ArrayList<>();
        for (Candidate candidate : ordered) {
            if (candidate.matched()) { kept.add(candidate); continue; }
            for (Candidate other : ordered) {
                if (other.matched() && Math.abs(other.ordinal() - candidate.ordinal()) <= NEIGHBOUR_RADIUS) { kept.add(candidate); break; }
            }
        }
        return kept;
    }

    /** A run with nothing matched in it is expansion around nothing, and is evidence for nothing. */
    private static void emit(List<Candidate> run, List<Passage> passages) {
        if (run.isEmpty() || run.stream().noneMatch(Candidate::matched)) return;
        StringBuilder content = new StringBuilder();
        int pageStart = Integer.MAX_VALUE;
        int pageEnd = Integer.MIN_VALUE;
        double score = 0;
        int matched = 0;
        List<UUID> ids = new ArrayList<>();
        for (Candidate candidate : run) {
            String text = candidate.content() == null ? "" : candidate.content().strip();
            if (!text.isEmpty()) { if (content.length() > 0) content.append(JOIN); content.append(text); }
            pageStart = Math.min(pageStart, candidate.pageStart());
            pageEnd = Math.max(pageEnd, candidate.pageEnd());
            // The passage ranks by the best evidence inside it, not by an average the expansion would dilute.
            if (candidate.matched()) { score = Math.max(score, candidate.score()); matched++; }
            ids.add(candidate.id());
        }
        Candidate first = run.get(0);
        passages.add(new Passage(first.documentId(), first.documentName(), first.sectionPath(), pageStart, pageEnd, content.toString(), score, first.ordinal(), matched, List.copyOf(ids), first.external()));
    }

    /**
     * @param matched whether retrieval ranked this chunk, as opposed to it being pulled in beside one that was.
     *     Only a matched chunk can make a passage exist or set its score.
     * @param sectionId the section this chunk is bound to, null for a document ingested before sections were a
     *     tree. Grouping then falls back to the document, which is the widest honest boundary available.
     * @param sectionPath the rendered section trail, already stripped of the document name by the caller.
     * @param external whether this chunk comes from researched web material rather than the learner's own
     *     uploaded course documents. Retrieved, never guessed: the flag is read from the document row.
     */
    public record Candidate(UUID id, int ordinal, UUID sectionId, String sectionPath, UUID documentId, String documentName, int pageStart, int pageEnd, String content, double score, boolean matched, boolean external) {
        public Candidate { sectionPath = sectionPath == null ? "" : sectionPath; }
        /** Callers that have no provenance flag treat the chunk as the learner's own material. */
        public Candidate(UUID id, int ordinal, UUID sectionId, String sectionPath, UUID documentId, String documentName, int pageStart, int pageEnd, String content, double score, boolean matched) {
            this(id, ordinal, sectionId, sectionPath, documentId, documentName, pageStart, pageEnd, content, score, matched, false);
        }
        UUID sectionKey() { return sectionId == null ? documentId : sectionId; }
    }

    /**
     * @param external whether this passage was assembled from researched web material. An answer citing it is
     *     citing a source that is not the learner's own, which the evidence block states and the citation
     *     contract tells the model to keep saying.
     */
    public record Passage(UUID documentId, String documentName, String sectionPath, int pageStart, int pageEnd, String content, double score, int firstOrdinal, int matchedChunks, List<UUID> chunkIds, boolean external) {
        public Passage { sectionPath = sectionPath == null ? "" : sectionPath; chunkIds = chunkIds == null ? List.of() : List.copyOf(chunkIds); }
        public Passage(UUID documentId, String documentName, String sectionPath, int pageStart, int pageEnd, String content, double score, int firstOrdinal, int matchedChunks, List<UUID> chunkIds) {
            this(documentId, documentName, sectionPath, pageStart, pageEnd, content, score, firstOrdinal, matchedChunks, chunkIds, false);
        }
        Passage cutTo(int chars) { return content.length() <= chars ? this : new Passage(documentId, documentName, sectionPath, pageStart, pageEnd, content.substring(0, chars).stripTrailing(), score, firstOrdinal, matchedChunks, chunkIds, external); }
    }

    /**
     * @param assembled how many passages the candidates formed, before the budget.
     * @param droppedToBudget how many were left out for want of room. Reported rather than swallowed, because
     *     evidence that was found and not shown is a different situation from evidence that does not exist.
     */
    public record Assembly(List<Passage> passages, int assembled, int droppedToBudget, int charsUsed) {}
}
