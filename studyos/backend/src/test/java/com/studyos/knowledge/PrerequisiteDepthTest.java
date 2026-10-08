package com.studyos.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.knowledge.PrerequisiteDepth.Edge;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Prerequisite depth is one third of every topic's difficulty, so a wrong depth quietly mis-ranks a whole course.
 * Two failures matter more than the arithmetic: reporting depth 0 for a course whose graph has never been built,
 * which would tell a learner a deep course is flat, and looping forever on a cycle, which real extracted graphs
 * contain often enough that a DAG assumption is not available.
 */
class PrerequisiteDepthTest {

    private static final UUID A = UUID.fromString("00000000-0000-0000-0000-00000000000a");
    private static final UUID B = UUID.fromString("00000000-0000-0000-0000-00000000000b");
    private static final UUID C = UUID.fromString("00000000-0000-0000-0000-00000000000c");
    private static final UUID D = UUID.fromString("00000000-0000-0000-0000-00000000000d");
    private static final UUID E = UUID.fromString("00000000-0000-0000-0000-00000000000e");

    /**
     * The distinction the whole return type exists for. A caller that read a missing computation as "every topic is
     * a root" would publish depth 0 for a course nobody has built a graph for.
     */
    @Test
    void reportsNothingRatherThanZeroWhenTheCourseHasNoEdges() {
        assertThat(PrerequisiteDepth.of(List.of(A, B, C), List.of())).isEmpty();
        assertThat(PrerequisiteDepth.of(List.of(A, B, C), null)).isEmpty();
        // Self-edges are not edges. A graph made only of them is still an unbuilt graph.
        assertThat(PrerequisiteDepth.of(List.of(A, B), List.of(new Edge(A, A), new Edge(B, B)))).isEmpty();
    }

    /** With edges present, a topic in none of them really is a root, and 0 is then a measurement. */
    @Test
    void countsAChainFromItsRoot() {
        Map<UUID, Integer> depths = PrerequisiteDepth.of(List.of(A, B, C, D), List.of(new Edge(A, B), new Edge(B, C)));
        assertThat(depths).containsEntry(A, 0).containsEntry(B, 1).containsEntry(C, 2).containsEntry(D, 0);
    }

    /**
     * The reason depth is the longest path and not the shortest. C rests on A directly and on A through B, and a
     * learner still has to hold both, so calling it as shallow as B's sibling would understate what it demands.
     */
    @Test
    void takesTheLongestRouteNotTheShortest() {
        Map<UUID, Integer> depths = PrerequisiteDepth.of(List.of(A, B, C), List.of(new Edge(A, C), new Edge(A, B), new Edge(B, C)));
        assertThat(depths).containsEntry(C, 2);
    }

    /** A cycle has to terminate, and the topics hanging off it still have to get a depth. */
    @Test
    void terminatesOnACycleAndStillMeasuresWhatHangsOffIt() {
        Map<UUID, Integer> depths = PrerequisiteDepth.of(List.of(A, B, C), List.of(new Edge(A, B), new Edge(B, A), new Edge(B, C)));
        assertThat(depths).containsKeys(A, B, C);
        assertThat(depths.get(C)).isGreaterThanOrEqualTo(1);
    }

    /**
     * Every topic named by an edge is measured even when the caller did not list it, because the graph knows about
     * topics a partial topic list may not — and a topic the caller listed is never dropped.
     */
    @Test
    void measuresEveryTopicTheGraphNamesAsWellAsEveryTopicAsked() {
        Map<UUID, Integer> depths = PrerequisiteDepth.of(List.of(A, E), List.of(new Edge(A, B), new Edge(B, C)));
        assertThat(depths).containsOnlyKeys(A, B, C, E);
        assertThat(depths).containsEntry(E, 0);
    }

    /**
     * A diamond is the common real shape — two independent prerequisites meeting again — and its depth is the
     * deeper branch, not the sum of the branches.
     */
    @Test
    void doesNotDoubleCountASharedPrerequisite() {
        Map<UUID, Integer> depths = PrerequisiteDepth.of(List.of(A, B, C, D), List.of(new Edge(A, B), new Edge(A, C), new Edge(B, D), new Edge(C, D)));
        assertThat(depths).containsEntry(D, 2);
    }

    /**
     * The memo is shared across the whole course, so the answer must not depend on which topic the walk happened
     * to start from. Reversing the topic list reverses the iteration order and must change nothing.
     */
    @Test
    void givesTheSameAnswerWhicheverTopicIsWalkedFirst() {
        List<Edge> edges = List.of(new Edge(A, B), new Edge(B, C), new Edge(C, D), new Edge(A, D));
        assertThat(PrerequisiteDepth.of(List.of(A, B, C, D), edges))
                .isEqualTo(PrerequisiteDepth.of(List.of(D, C, B, A), edges));
    }
}
