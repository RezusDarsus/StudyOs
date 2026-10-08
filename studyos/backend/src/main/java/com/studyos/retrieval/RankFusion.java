package com.studyos.retrieval;

import java.util.*;
import java.util.function.Function;

/** Deterministic reciprocal-rank fusion with the existing k=60 policy. */
public final class RankFusion {
    private static final int RRF_K = 60;
    private RankFusion() {}

    public static <T> List<T> fuse(List<T> first, List<T> second, Function<T, UUID> identity) {
        return fuseWithScores(first,second,identity).stream().map(Ranked::value).toList();
    }

    public static <T> List<Ranked<T>> fuseWithScores(List<T> first,List<T> second,Function<T,UUID> identity) {
        Map<UUID, Scored<T>> merged = new LinkedHashMap<>();
        addRanks(merged, first, identity);
        addRanks(merged, second, identity);
        return merged.values().stream().sorted(Comparator.comparingDouble(Scored<T>::score).reversed()).map(value->new Ranked<>(value.value(),value.score())).toList();
    }

    private static <T> void addRanks(Map<UUID, Scored<T>> merged, List<T> results, Function<T, UUID> identity) {
        for (int i = 0; i < results.size(); i++) {
            T value = results.get(i);
            UUID id = identity.apply(value);
            Scored<T> current = merged.get(id);
            double score = 1.0 / (RRF_K + i + 1);
            merged.put(id, new Scored<>(current == null ? value : current.value(), (current == null ? 0 : current.score()) + score));
        }
    }

    private record Scored<T>(T value, double score) {}
    public record Ranked<T>(T value,double score) {}
}
