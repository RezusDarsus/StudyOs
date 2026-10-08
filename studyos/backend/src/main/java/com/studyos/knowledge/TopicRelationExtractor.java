package com.studyos.knowledge;

import com.studyos.ingestion.Chunk;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Deterministic, provenance-preserving relation inference over the topics a workspace already has.
 * The topic names come from the student's own uploaded material; the only thing hardcoded here is
 * English structural wording ("relies on", "is required for", "consists of", "in contrast to"), which
 * reads the same in every subject.
 *
 * <p>Five kinds of edge are read, and the wording that decides between them is the whole of the classifier: a cue
 * between two topic names both names the relation and says which way round it goes. What no cue matches is either
 * a bare co-mention — {@link TopicRelationType#RELATED_TO}, and only when the two names are close enough together
 * to be about each other — or nothing at all.
 */
@Component
public class TopicRelationExtractor {
    private static final String METHOD = "LOCAL_RULE_V2";
    /**
     * How much each kind of wording commits, in descending order of how hard it is to read any other way.
     *
     * <p>A requirement is stated outright; containment is nearly as explicit but its commonest wording ("includes",
     * "contains") is loose; extension wording sometimes means no more than that one thing came after another; a
     * comparison may be made once in passing. Bare proximity commits to almost nothing, which is what .55 says.
     */
    private static final double DEPENDENCY_CONFIDENCE = .78;
    private static final double PART_CONFIDENCE = .74;
    private static final double EXTENSION_CONFIDENCE = .72;
    private static final double COMPARISON_CONFIDENCE = .70;
    private static final double RELATED_CONFIDENCE = .55;
    private static final int MAX_PER_CHUNK = 6;
    private static final int MAX_RELATED_GAP_WORDS = 6;

    /** Wording where the text on the right is the foundation for the text on the left. */
    private static final List<String> LEFT_DEPENDS_ON_RIGHT = List.of("is an application of", "is a special case of", "is derived from",
            "is computed from", "is expressed in terms of", "is defined in terms of", "is based on", "is grounded in", "follows from",
            "derived from", "depends on", "depend on", "relies on", "rely on", "based on", "requires", "require", "assumes", "assume",
            "presupposes", "needs", "need", "uses", "use", "using", "applies", "apply");

    /** Wording where the text on the left is the foundation for the text on the right. */
    private static final List<String> LEFT_SUPPORTS_RIGHT = List.of("is a prerequisite for", "is a prerequisite of", "is the basis for",
            "is the foundation for", "is required for", "is required by", "is needed for", "is used in", "is used by", "is applied in",
            "makes it possible to", "prerequisite for", "prerequisite of", "required for", "required by", "needed for", "used in",
            "used by", "applied in", "underlies", "underpins", "enables", "enable", "leads to", "lead to", "motivates");

    /** Wording where the text on the left is a piece of the text on the right. */
    private static final List<String> LEFT_IS_PART_OF_RIGHT = List.of("is a subcomponent of", "is one component of", "is a component of",
            "is an element of", "is a subfield of", "is a member of", "is a branch of", "is a stage of", "is a phase of", "is a step in",
            "is a step of", "is contained in", "is included in", "is a part of", "are part of", "forms a part of", "forms part of",
            "form part of", "is part of", "belongs to", "belong to", "falls under", "fall under");

    /** Wording where the text on the right is a piece of the text on the left. */
    private static final List<String> RIGHT_IS_PART_OF_LEFT = List.of("is broken down into", "can be broken down into", "is organized into",
            "is organised into", "is divided into", "is composed of", "is made up of", "is made of", "breaks down into", "break down into",
            "subdivides into", "divides into", "divide into", "consists of", "consist of", "comprises", "comprise", "includes", "include",
            "contains", "contain");

    /**
     * Wording where the text on the left is the text on the right taken further.
     *
     * <p>"Builds on", "extends" and "generalizes" read as dependencies too and used to be stored as them, which is
     * why the learning order is preserved either way: the base still comes first, it is just now recorded as a
     * development of the base rather than as a gate in front of it.
     */
    private static final List<String> LEFT_BUILDS_ON_RIGHT = List.of("is a generalization of", "is a generalisation of", "is an improvement on",
            "is a continuation of", "is a refinement of", "is built on top of", "is an extension of", "is developed from", "is built on",
            "improves upon", "elaborates on", "elaborate on", "generalizes", "generalises", "generalize", "generalise", "improves on",
            "improve on", "builds upon", "build upon", "builds on", "build on", "refines", "refine", "extends", "extend");

    /** Wording where the text on the right is the text on the left taken further. */
    private static final List<String> RIGHT_BUILDS_ON_LEFT = List.of("is taken further in", "is taken further by", "is generalized by",
            "is generalised by", "is extended to", "is extended by", "is refined by", "generalizes to", "generalises to");

    /**
     * Wording that sets two topics against each other, whether the material calls them alike or opposed.
     *
     * <p>Similarity belongs here with contrast because the relation records that the pair is worth studying
     * together, and "is analogous to" earns that as much as "must not be confused with" does.
     */
    private static final List<String> COMPARISON = List.of("should not be confused with", "must not be confused with", "is easily confused with",
            "is often confused with", "is distinguished from", "is contrasted with", "in comparison with", "in comparison to", "is different from",
            "is the opposite of", "is analogous to", "is distinct from", "in contrast with", "in contrast to", "compared with", "is similar to",
            "as opposed to", "is the dual of", "compared to", "differs from", "rather than", "as against", "differ from", "resembles",
            "parallels", "versus", "unlike", "vs");

    /**
     * Every cue in one ordered table, scanned longest-match-first so "is required for" is never read as "require".
     *
     * <p>The order matters only for two cues of the same length, where the first listed wins. Dependency wording
     * leads because it is the oldest and the most consequential: an edge the ladder gates on should not be lost to
     * a same-length cue for a softer relation.
     */
    private static final List<Cue> CUES = cues();

    public List<Candidate> extract(Chunk chunk) { return extract(chunk, List.of()); }

    /** Relations supported by this passage between topics the workspace already knows about. */
    public List<Candidate> extract(Chunk chunk, Collection<String> knownTopicNames) {
        if (chunk == null || chunk.content() == null || knownTopicNames == null || knownTopicNames.size() < 2) return List.of();
        Map<String, String> byFolded = new LinkedHashMap<>();
        for (String name : knownTopicNames) { String folded = fold(name); if (folded.length() >= 3) byFolded.putIfAbsent(folded, name); }
        if (byFolded.size() < 2) return List.of();
        Map<Key, Candidate> result = new LinkedHashMap<>();
        for (String sentence : chunk.content().split("(?<=[.!?;])|\\R")) {
            String text = " " + fold(sentence) + " ";
            if (text.length() < 8) continue;
            List<Mention> mentions = mentions(text, byFolded);
            for (int index = 0; index + 1 < mentions.size(); index++) {
                Mention left = mentions.get(index);
                Mention right = mentions.get(index + 1);
                if (left.name().equals(right.name())) continue;
                String between = text.substring(left.end(), right.start()).trim();
                Relation relation = classify(between);
                if (relation == null) continue;
                Candidate candidate = relation.reversed()
                        ? candidate(right.name(), left.name(), relation.type(), relation.confidence(), chunk)
                        : candidate(left.name(), right.name(), relation.type(), relation.confidence(), chunk);
                if (relation.type().symmetric()) candidate = canonical(candidate);
                result.putIfAbsent(new Key(fold(candidate.sourceName()), fold(candidate.targetName()), candidate.type()), candidate);
            }
        }
        List<Candidate> candidates = new ArrayList<>(result.values());
        Set<Pair> stated = new LinkedHashSet<>();
        for (Candidate candidate : candidates) if (candidate.type() != TopicRelationType.RELATED_TO) stated.add(pair(candidate));
        return candidates.stream()
                .filter(candidate -> candidate.type() != TopicRelationType.RELATED_TO || !stated.contains(pair(candidate)))
                .sorted(Comparator.comparingInt((Candidate candidate) -> candidate.type() == TopicRelationType.RELATED_TO ? 1 : 0))
                .limit(MAX_PER_CHUNK).toList();
    }

    /** Every known topic named in this sentence, in the order the sentence mentions them. */
    private List<Mention> mentions(String text, Map<String, String> byFolded) {
        List<Mention> mentions = new ArrayList<>();
        byFolded.forEach((folded, name) -> {
            int at = firstMatch(text, folded);
            if (at >= 0) mentions.add(new Mention(name, at, at + matchLength(text, folded, at)));
        });
        mentions.sort((left, right) -> Integer.compare(left.start(), right.start()));
        List<Mention> distinct = new ArrayList<>();
        for (Mention mention : mentions) if (distinct.stream().noneMatch(kept -> overlaps(kept, mention))) distinct.add(mention);
        return distinct;
    }

    private boolean overlaps(Mention kept, Mention candidate) { return candidate.start() < kept.end() && kept.start() < candidate.end(); }

    private int firstMatch(String text, String folded) {
        for (String variant : variants(folded)) { int at = text.indexOf(" " + variant + " "); if (at >= 0) return at + 1; }
        return -1;
    }

    private int matchLength(String text, String folded, int at) {
        for (String variant : variants(folded)) if (text.startsWith(variant, at)) return variant.length();
        return folded.length();
    }

    /** Singular and plural spellings of the same name, so "vector clock" matches "vector clocks". */
    private List<String> variants(String folded) {
        return folded.endsWith("s") ? List.of(folded, folded.substring(0, folded.length() - 1)) : List.of(folded, folded + "s");
    }

    /** Reads the words between two topics and decides which relation holds and which way round it runs. */
    private Relation classify(String between) {
        if (between.isBlank()) return null;
        Cue cue = longestCue(between);
        if (cue != null) return new Relation(cue.type(), cue.confidence(), cue.reversed());
        return between.split("\\s+").length <= MAX_RELATED_GAP_WORDS ? new Relation(TopicRelationType.RELATED_TO, RELATED_CONFIDENCE, false) : null;
    }

    /** The most specific matching cue wins, so "is required for" is never read as "require". */
    private Cue longestCue(String between) {
        String padded = " " + between + " ";
        Cue best = null;
        for (Cue cue : CUES) if (padded.contains(" " + cue.words() + " ") && (best == null || cue.words().length() > best.words().length())) best = cue;
        return best;
    }

    private static List<Cue> cues() {
        List<Cue> cues = new ArrayList<>();
        add(cues, LEFT_SUPPORTS_RIGHT, TopicRelationType.PREREQUISITE_OF, DEPENDENCY_CONFIDENCE, false);
        add(cues, LEFT_DEPENDS_ON_RIGHT, TopicRelationType.PREREQUISITE_OF, DEPENDENCY_CONFIDENCE, true);
        add(cues, LEFT_IS_PART_OF_RIGHT, TopicRelationType.PART_OF, PART_CONFIDENCE, false);
        add(cues, RIGHT_IS_PART_OF_LEFT, TopicRelationType.PART_OF, PART_CONFIDENCE, true);
        add(cues, LEFT_BUILDS_ON_RIGHT, TopicRelationType.BUILDS_ON, EXTENSION_CONFIDENCE, false);
        add(cues, RIGHT_BUILDS_ON_LEFT, TopicRelationType.BUILDS_ON, EXTENSION_CONFIDENCE, true);
        add(cues, COMPARISON, TopicRelationType.COMPARES_WITH, COMPARISON_CONFIDENCE, false);
        return List.copyOf(cues);
    }

    private static void add(List<Cue> cues, List<String> words, TopicRelationType type, double confidence, boolean reversed) {
        for (String word : words) cues.add(new Cue(word, type, confidence, reversed));
    }

    /** Possessives folded away too, so "Newton's Second Law" and "Newton Second Law" are one name. */
    private String fold(String value) { return TopicRegistry.normalize(value == null ? "" : value.replaceAll("(?i)['’]s\\b", "")); }

    /**
     * A symmetric relation stored in one fixed order, so the same pair found in two passages is one edge.
     *
     * <p>Ordered by folded name rather than by which the sentence mentioned first, because the sentence's order is
     * exactly the thing a symmetric relation says nothing about.
     */
    private Candidate canonical(Candidate candidate) {
        return fold(candidate.sourceName()).compareTo(fold(candidate.targetName())) <= 0 ? candidate
                : new Candidate(candidate.targetName(), candidate.sourceName(), candidate.type(), candidate.confidence(), candidate.sourceChunkId(), candidate.extractionMethod());
    }

    /** The two topics without their direction, so a stated relation can suppress a bare co-mention of the pair. */
    private Pair pair(Candidate candidate) {
        String source = fold(candidate.sourceName());
        String target = fold(candidate.targetName());
        return source.compareTo(target) <= 0 ? new Pair(source, target) : new Pair(target, source);
    }

    private Candidate candidate(String source, String target, TopicRelationType type, double confidence, Chunk chunk) { return new Candidate(source, target, type, confidence, chunk.id(), METHOD); }
    private record Mention(String name, int start, int end) {}
    private record Relation(TopicRelationType type, double confidence, boolean reversed) {}
    private record Cue(String words, TopicRelationType type, double confidence, boolean reversed) {}
    private record Key(String source, String target, TopicRelationType type) {}
    private record Pair(String low, String high) {}
    public record Candidate(String sourceName, String targetName, TopicRelationType type, double confidence, UUID sourceChunkId, String extractionMethod) {}
}
