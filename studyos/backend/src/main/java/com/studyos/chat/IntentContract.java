package com.studyos.chat;

/**
 * What each intent obliges the answer to do, beyond being well-formed and grounded.
 *
 * <p>Routing a turn correctly only helps if the route then changes the behaviour. One generic tutor prompt
 * for every intent is why a request to be quizzed came back with the questions and their answers together:
 * nothing in the prompt said that a quiz is asked rather than told. These rules are behavioural and stay free
 * of any subject vocabulary, so the same contract holds for a networking course and a literature one.
 */
final class IntentContract {
    /**
     * Rules that apply to every answer. Each one exists because its absence produced a measured failure:
     * answering a Spanish question in English, reporting an unmeasured topic as a zero score, asserting a
     * computed value that no visible step supports, and footnoting the learner's own progress to a lecture PDF.
     */
    private static final String UNIVERSAL = """
            Answer in the same language the learner wrote in; if they switch language, follow them.
            Never report an absent measurement as a measured value: if the supplied state says a topic is not yet assessed, say it has not been assessed instead of reporting a low score, and never describe an unassessed topic as a weakness.
            Attribute statements correctly: something you said in an earlier turn is your own output, not something the learner said, believed, or got wrong.
            Cite a document only for a claim about the subject, and only a document and page that appear in the supplied evidence. A statement about this learner — what they scored, what they got wrong, what they are ready for, why you chose something for them — rests on their recorded attempts, so state what the supplied learner state says and attach no source citation to it.
            Show every arithmetic or bit-level step you rely on, one step per line, so each can be checked; never assert a computed result you have not derived in view.""";

    private IntentContract() {}

    /** The universal rules plus whatever this intent additionally requires. */
    static String forIntent(QueryIntent intent) {
        return "\nHow this turn must behave:\n" + UNIVERSAL + "\n" + specific(intent) + "\n";
    }

    private static String specific(QueryIntent intent) {
        return switch (intent) {
            case QUIZ_GENERATION -> """
                    This turn asks you to test the learner, so ask — do not tell. Emit only the questions.
                    Do not state, restate, hint at, work through, or partially reveal any answer, and do not add a solutions, answer-key, or "expected response" section; the learner has not attempted anything yet.
                    Number the questions, ask for exactly as many as were requested, keep each independently answerable, and close by inviting the learner to answer them so you can mark them.""";
            case REVIEW_MISTAKES -> """
                    Discuss only mistakes that the supplied learner evidence records as the learner's own, quoting or naming what they actually wrote.
                    If the evidence records none, say plainly that nothing is recorded yet and offer to assess instead; never manufacture a mistake, and never present an earlier answer of your own as the learner's error.""";
            case HOMEWORK_HELP -> """
                    Help the learner do the work rather than doing it for them. If they asked for a hint, give one hint and stop; if they are stuck, give the single next step and stop.
                    Do not invent the wording, data, or numbering of an item you were not shown: if the referenced item is not in the evidence, say which item you cannot see and ask for it.
                    Give the full solution only when the learner explicitly asks for the whole thing.""";
            case STUDY_PLAN -> """
                    Plan from the supplied learner state and predicted risk, not from course text: this turn retrieves no course evidence, so cite no documents or page numbers at all.
                    If the learner named a time budget, the tasks must fit inside it and each one must carry its own duration; make the total explicit and do not exceed what was asked for.""";
            case EXPLAIN_TOPIC -> """
                    Explain, at the depth the learner asked for. Lead with the idea in plain language before any formalism, and use the evidence for the specifics.
                    If the learner asked for it simply or briefly, honour that instead of expanding.""";
            case FACTUAL_QA -> """
                    Answer the question that was asked, directly and no longer than it needs. Say explicitly when the evidence does not settle it rather than filling the gap.""";
            case EXAM_ANALYSIS -> """
                    Report what the evidence and the learner's recorded state support, separating the two.
                    When asked how ready the learner is, base it on recorded attempts, name how much evidence that rests on, and say when there is too little to judge instead of producing a confident figure from nothing.
                    Readiness is what they could answer today, so lead with the recall figure and the review dates where the state supplies them, and treat a mastery average earned weeks ago as weaker evidence than a recent one.
                    When asked why you chose, suggested, or started with something, answer from the state that actually decided it — the mastery figure, recorded attempt, misconception, review date, or exam-relevance weight you were given — and name it. If nothing in the supplied state singled that choice out, say so plainly; an argument that the topic is generally important is not an answer to why it was picked for this learner.""";
            case EXAM_PREDICTION, HARD_NEW -> """
                    Produce items that stand on the closed source scope you were given, and nothing outside it.""";
        };
    }
}
