package com.studyos.knowledge;

/**
 * The relation vocabulary persisted in {@code topic_edges}, and what each kind of edge means.
 *
 * <p>Every type is read as the English clause "source <em>type</em> target". That is how the two original types
 * already read, and it is the only convention under which a reader does not have to remember a direction per type
 * — at the cost of the learning order running the other way for {@link #BUILDS_ON}, which is why the order is
 * declared here rather than assumed by each caller.
 *
 * <p>Three facts are attached to each type because the persistence rules branch on them: whether the edge implies
 * an order to learn the two topics in, whether a chain of these edges must not close on itself, and whether the
 * pair is unordered and so should be stored once rather than once per direction.
 */
public enum TopicRelationType {
    /** Target cannot be understood without source. The hard gate the planner and the ladder both read. */
    PREREQUISITE_OF(Order.TARGET_RESTS_ON_SOURCE, true, false),
    /** The two were written together and nothing more specific was found. Carries no order and no direction. */
    RELATED_TO(Order.NONE, false, true),
    /**
     * Source is a component of target: a stage of a process, an element of a rule, a step of a method.
     *
     * <p>Not a learning order. Course material introduces a whole before its parts about as often as it assembles
     * one from them, so containment says nothing about what to study first — but it cannot close on itself either,
     * because a topic containing something that contains it is not a hierarchy.
     */
    PART_OF(Order.NONE, true, false),
    /**
     * Source is target taken further — the same line of thought extended, refined or generalised.
     *
     * <p>Softer than a prerequisite and stored the other way round: source rests on target. A prerequisite gap
     * blocks a topic, whereas this says where a topic naturally leads next once its base is held.
     */
    BUILDS_ON(Order.SOURCE_RESTS_ON_TARGET, true, false),
    /**
     * The two are worth studying against each other, whether the material calls them alike or opposed.
     *
     * <p>Symmetric, so it is stored once per pair. Comparison is also where confusion lives, which is what makes
     * this the pair a misconception is most likely to be about.
     */
    COMPARES_WITH(Order.NONE, false, true);

    /** Which end of an edge has to be understood first, if either does. */
    public enum Order {
        /** The pair carries no order at all. */
        NONE,
        /** Source first: the shape {@code PREREQUISITE_OF} is stored in. */
        TARGET_RESTS_ON_SOURCE,
        /** Target first: the shape {@code BUILDS_ON} is stored in. */
        SOURCE_RESTS_ON_TARGET
    }

    private final Order order;
    private final boolean acyclic;
    private final boolean symmetric;

    TopicRelationType(Order order, boolean acyclic, boolean symmetric) { this.order = order; this.acyclic = acyclic; this.symmetric = symmetric; }

    /** Which end has to be understood first. */
    public Order learningOrder() { return order; }

    /** Whether this type contributes to what a learner has to hold before a topic. */
    public boolean ordersLearning() { return order != Order.NONE; }

    /**
     * Whether a chain of these edges closing on itself is a contradiction rather than a fact about the material.
     *
     * <p>True for the three directed types, and the reason extraction refuses an edge that would close a cycle:
     * "A before B before A" is not a course, and a depth walk over it measures nothing. False for the symmetric
     * types, where a pair is trivially a two-cycle and the question does not arise.
     */
    public boolean acyclic() { return acyclic; }

    /**
     * Whether the pair is unordered, so that A→B and B→A are the same edge and only one of them is stored.
     *
     * <p>Storing both would double the pair's weight everywhere edges are counted, and make a graph that says
     * nothing about direction look as though it did.
     */
    public boolean symmetric() { return symmetric; }
}
