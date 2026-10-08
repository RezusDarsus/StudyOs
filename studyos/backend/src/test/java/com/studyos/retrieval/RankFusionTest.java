package com.studyos.retrieval;

import static org.assertj.core.api.Assertions.assertThat;
import java.util.*;
import org.junit.jupiter.api.Test;

class RankFusionTest {
    @Test void rewardsResultAppearingInBothRankings() {
        Item first = new Item(UUID.randomUUID(), "first"); Item common = new Item(UUID.randomUUID(), "common"); Item second = new Item(UUID.randomUUID(), "second");
        var fused = RankFusion.fuse(List.of(first, common), List.of(common, second), Item::id);
        assertThat(fused).extracting(Item::name).containsExactly("common", "first", "second");
    }

    @Test void preservesFirstRankingOrderForEqualScores() {
        Item lexical = new Item(UUID.randomUUID(), "lexical"); Item vector = new Item(UUID.randomUUID(), "vector");
        var fused = RankFusion.fuse(List.of(lexical), List.of(vector), Item::id);
        assertThat(fused).containsExactly(lexical, vector);
    }

    @Test void exposesTheCalculatedFusionScoreToDownstreamRerankers() {
        Item common=new Item(UUID.randomUUID(),"common");Item one=new Item(UUID.randomUUID(),"one");
        var ranked=RankFusion.fuseWithScores(List.of(common,one),List.of(common),Item::id);
        assertThat(ranked.getFirst().value()).isEqualTo(common);
        assertThat(ranked.getFirst().score()).isGreaterThan(ranked.get(1).score());
    }

    private record Item(UUID id, String name) {}
}
