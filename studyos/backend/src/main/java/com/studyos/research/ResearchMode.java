package com.studyos.research;

/**
 * How much of a workspace's authority may come from the open web.
 *
 * <ul>
 *   <li>{@link #SOURCE_ONLY} — only material the student uploaded is authoritative. Research
 *       requests are refused: the workspace's knowledge base is deliberately closed.</li>
 *   <li>{@link #SOURCE_PLUS_RESEARCH} — uploaded material stays primary; research may fill
 *       missing definitions, supply examples and expand weakly covered topics. Every researched
 *       source stays visibly external through its provenance row.</li>
 *   <li>{@link #RESEARCH_ONLY} — the course is built from researched external material, for
 *       self-directed goals with no uploaded material at all.</li>
 * </ul>
 */
public enum ResearchMode {
    SOURCE_ONLY,
    SOURCE_PLUS_RESEARCH,
    RESEARCH_ONLY;

    /** Whether this mode permits fetching external material into the knowledge base at all. */
    public boolean allowsResearch() { return this != SOURCE_ONLY; }
}
