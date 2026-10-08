package com.studyos.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The properties every consumer of an edge reads off its type, pinned — and pinned against the migration that
 * defines the same vocabulary in SQL.
 *
 * <p>Three facts about a relation type decide what happens to an edge: whether it orders learning (the planner, the
 * ladder, a capsule's prerequisite list and the topic model's depth all read the ordering ones), which way round
 * that order runs, and whether the pair is symmetric (which decides whether a mirrored row is a duplicate or a
 * second fact). Getting any of them wrong is silent: the graph still validates, the course is just taught in the
 * wrong sequence, or one relation is counted twice.
 *
 * <p>The last test is the one that earns its place. The enum and {@code V41} are two independent declarations of the
 * same vocabulary — a type added to the enum but not to the CHECK constraint fails only at INSERT time in
 * production, and a type left out of the view's WHERE clause disappears from the learning order without any error
 * at all. This reads the migration off the classpath and makes the two agree here instead.
 */
class TopicRelationTypeTest {
    @Test
    void statesWhichRelationsOrderLearningAndWhichWayRound() {
        assertThat(TopicRelationType.PREREQUISITE_OF.learningOrder()).isEqualTo(TopicRelationType.Order.TARGET_RESTS_ON_SOURCE);
        assertThat(TopicRelationType.BUILDS_ON.learningOrder()).isEqualTo(TopicRelationType.Order.SOURCE_RESTS_ON_TARGET);
        assertThat(TopicRelationType.PART_OF.learningOrder()).isEqualTo(TopicRelationType.Order.NONE);
        assertThat(TopicRelationType.RELATED_TO.learningOrder()).isEqualTo(TopicRelationType.Order.NONE);
        assertThat(TopicRelationType.COMPARES_WITH.learningOrder()).isEqualTo(TopicRelationType.Order.NONE);
    }

    /**
     * A part is not a prerequisite of its whole. Courses introduce the whole first about as often as they assemble
     * it from pieces, so counting containment as depth would rank every leaf of a well-structured document as the
     * course's hardest topic.
     */
    @Test
    void doesNotTreatContainmentAsLearningOrder() {
        assertThat(TopicRelationType.PART_OF.ordersLearning()).isFalse();
        assertThat(TopicRelationType.PART_OF.acyclic()).isTrue();
    }

    /** Which relations may be stored in either order for the same pair, and which may not. */
    @Test
    void statesWhichRelationsAreSymmetric() {
        assertThat(TopicRelationType.RELATED_TO.symmetric()).isTrue();
        assertThat(TopicRelationType.COMPARES_WITH.symmetric()).isTrue();
        assertThat(TopicRelationType.PREREQUISITE_OF.symmetric()).isFalse();
        assertThat(TopicRelationType.PART_OF.symmetric()).isFalse();
        assertThat(TopicRelationType.BUILDS_ON.symmetric()).isFalse();
    }

    /**
     * The combinations that cannot both hold, checked over every type so a sixth added later cannot be incoherent.
     * A symmetric relation has no direction to order anything by and no cycle to detect; a relation whose cycles are
     * rejected has to have a direction for a cycle to run round.
     */
    @Test
    void keepsDirectionSymmetryAndCycleRulesConsistent() {
        for (TopicRelationType type : TopicRelationType.values()) {
            if (type.symmetric()) {
                assertThat(type.acyclic()).as("%s is symmetric, so a cycle through it is not a contradiction", type).isFalse();
                assertThat(type.ordersLearning()).as("%s is symmetric, so it cannot say which comes first", type).isFalse();
            }
            if (type.acyclic()) assertThat(type.symmetric()).as("%s rejects cycles, so it must be directed", type).isFalse();
            if (type.ordersLearning()) assertThat(type.acyclic()).as("%s orders learning, so a cycle in it is unlearnable", type).isTrue();
        }
    }

    /** Every type the enum has is a value the column accepts, and no more. */
    @Test
    void agreesWithTheCheckConstraintInV41() throws Exception {
        Set<String> allowed = valuesAfter(migration(), "topic_edges_relation_type_check CHECK (relation_type IN (");

        assertThat(allowed).containsExactlyInAnyOrderElementsOf(names(TopicRelationType.values()));
    }

    /** Every type that orders learning reaches {@code topic_prerequisites}, and nothing else does. */
    @Test
    void agreesWithThePrerequisiteViewInV41() throws Exception {
        Set<String> ordering = valuesAfter(migration(), "WHERE e.relation_type IN (");

        assertThat(ordering).containsExactlyInAnyOrderElementsOf(
                names(Arrays.stream(TopicRelationType.values()).filter(TopicRelationType::ordersLearning).toArray(TopicRelationType[]::new)));
    }

    private Set<String> names(TopicRelationType... types) {
        Set<String> result = new LinkedHashSet<>();
        for (TopicRelationType type : types) result.add(type.name());
        return result;
    }

    /** The quoted values of one SQL {@code IN (...)} list, located by a phrase that occurs once in the migration. */
    private Set<String> valuesAfter(String sql, String anchor) {
        int at = sql.indexOf(anchor);
        assertThat(at).as("anchor %s in V41", anchor).isNotNegative();
        assertThat(sql.indexOf(anchor, at + 1)).as("anchor %s occurs once in V41", anchor).isEqualTo(-1);
        String list = sql.substring(at + anchor.length(), sql.indexOf(')', at + anchor.length()));
        Set<String> result = new LinkedHashSet<>();
        for (String value : list.split(",")) result.add(value.trim().replace("'", ""));
        return result;
    }

    private String migration() throws Exception {
        try (InputStream input = getClass().getResourceAsStream("/db/migration/V41__topic_relation_vocabulary.sql")) {
            assertThat(input).as("V41 migration on the classpath").isNotNull();
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
