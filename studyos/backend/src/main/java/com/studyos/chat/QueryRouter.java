package com.studyos.chat;

import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Intent routing. Constraints stated in the current turn outrank wording carried over from earlier
 * messages, so a scoped "new exercise" request cannot be pulled back into exam prediction by history.
 *
 * <p>Only interaction wording is matched here — "quiz me", "hint", "plan", "explain". Nothing in this
 * router names a course concept, so a chemistry prompt routes exactly like a networking one. Accents
 * are stripped and the request verbs are listed in several languages, because how a student phrases a
 * request is the one thing that genuinely varies from course to course.
 *
 * <p>Each rule covers a request as it is worded rather than as a specification would word it, because the
 * measured failures were all wording: a quiz asked for as a noun ("give me a difficult quiz"), the roles
 * written the other way round ("ask me one question at a time"), an exercise requested with no novelty word
 * ("create a problem that combines two topics"), a plan asked for with no plan in it ("the highest-value
 * thing to study"), and a question about the learner's own record with no exam in it ("what are my biggest
 * weaknesses"). Every one of those is the same request in any subject.
 */
@Service
public class QueryRouter {
    private static final Pattern CREATION = Pattern.compile("\\b(?:create|generate|make|give\\s+me|design|write|build|produce|invent|prepare|come\\s+up\\s+with)\\b");
    private static final Pattern ARTIFACT = Pattern.compile("\\b(?:exercises?|problems?|tasks?|questions?|items?)\\b");
    private static final Pattern NOVELTY = Pattern.compile("\\b(?:new|another|different|fresh|extra|harder|hardest|tougher|unlike|not\\s+(?:the\\s+)?same|not\\s+from)\\b");
    private static final Pattern PLAN_REQUEST = Pattern.compile("\\bwhat\\s+(?:should|shall|do|can)\\s+i\\s+(?:study|learn|revise|review|practi[cs]e|focus\\s+on|work\\s+on|prioriti[sz]e|start\\s+with|do\\s+next)\\b|\\bstudy\\s+(?:today|tonight|next|now)\\b|\\bstudy\\s+plan\\b|\\bwhere\\s+(?:should|do)\\s+i\\s+start\\b");
    private static final Pattern PLAN_NOUN = Pattern.compile("\\bplans?\\b|\\bstudy\\s+schedule\\b");
    /**
     * A request to be told what to do next, which is a plan however short it is. The superlative needs its
     * noun — "the highest-value thing to study" is an ask for a task, while "the most important concepts in
     * this course" is a question about the material and has to stay one.
     *
     * <p>"What should I do" is anchored to the end of the turn for the same reason: mid-sentence it usually
     * belongs to the subject ("what should I do if the remainder is zero"), and at the end it is the student
     * asking for their next move.
     */
    private static final Pattern NEXT_ACTION = Pattern.compile(
            "\\b(?:most|highest|best|single\\s+most)[\\s-]?(?:useful|valuable|value|important|impactful|effective|productive)\\s+(?:thing|things|task|tasks|topic|topics|activity|use|way|step|steps)\\b"
            + "|\\bwhat\\s+(?:should|shall|do|can)\\s+i\\s+do\\s*(?:next|now|first|today|tonight)?\\s*[.!?]*$"
            + "|\\bwhat\\s+to\\s+(?:study|do|revise|review|practi[cs]e)\\b|\\b(?:thing|things|task|tasks|step|steps)\\s+to\\s+(?:study|do|learn|revise|review|focus\\s+on)\\b"
            + "|\\b(?:fastest|quickest|best)\\s+way\\s+(?:for\\s+me\\s+)?to\\s+improve\\b|\\bimprove\\s+(?:my\\s+)?(?:exam\\s+)?readiness\\b"
            + "|\\bnext\\s+steps?\\b|\\bwhat\\s+(?:should|do)\\s+i\\s+focus\\s+on\\b");
    private static final Pattern QUIZ_REQUEST = Pattern.compile("\\bqui[sz]z*(?:es)?\\s+(?:me|us)\\b|\\b(?:test|assess|examine|drill)\\s+(?:me|us)\\b|\\bpracti[cs](?:e|es|ing)\\b|\\bflash\\s?cards?\\b|\\bself[\\s-]?test\\b");
    /** A quiz named as a thing to be given rather than an act to be performed: "give me a short quiz". */
    private static final Pattern QUIZ_NOUN = Pattern.compile("\\bqui[sz]z*(?:es)?\\b|\\bflash\\s?cards?\\b");
    /** Being asked questions, which is the same request as "quiz me" with the roles written the other way. */
    private static final Pattern ASK_ME = Pattern.compile("\\b(?:ask|quiz|test|drill|question)\\s+(?:me|us)\\b");
    /** Offering knowledge to be checked. Deliberately not "check my homework", which is help with an item. */
    private static final Pattern KNOWLEDGE_CHECK = Pattern.compile("\\b(?:check|test|assess|gauge|verify)\\s+(?:my|our)\\s+(?:knowledge|understanding|recall|mastery|grasp)\\b");
    private static final Pattern MISTAKE_WORDS = Pattern.compile("\\bmistakes?\\b|\\bmisconceptions?\\b|\\bwrong\\s+answers?\\b|\\bgot\\s+(?:\\S+\\s+){0,3}wrong\\b|\\bkeep\\s+(?:getting|failing)\\b");
    private static final Pattern REVIEW_WORDS = Pattern.compile("\\b(?:review|revisit|recap|go\\s+over|look\\s+back)\\b");
    private static final Pattern WRONG_WORDS = Pattern.compile("\\bwrong\\b|\\bincorrect(?:ly)?\\b|\\bfailed\\b|\\bmissed\\b");
    private static final Pattern SUPPORT_WORDS = Pattern.compile("\\bhints?\\b|\\bhelp\\s+me\\b|\\bwalk\\s+me\\s+through\\b|\\bstep\\s+by\\s+step\\b|\\bstuck\\b|\\bsolve\\b|\\bcheck\\s+my\\b|\\bhow\\s+do\\s+i\\s+(?:solve|do|start|approach)\\b");
    private static final Pattern EXISTING_ITEM = Pattern.compile("\\b(?:homework|hw|assignment|worksheet|problem\\s+set|exercise\\s+sheet|sheet|aufgabenblatt|ubungsblatt)\\b|\\b(?:exercise|problem|task|question|aufgabe|ejercicio|exercicio|esercizio)\\s*\\d+\\b");
    /** An item identified by its number, which the student is holding and the system has never written. */
    private static final Pattern NUMBERED_ITEM = Pattern.compile("\\b(?:homework|hw|assignment|worksheet|problem\\s+set|exercise\\s+sheet|sheet|aufgabenblatt|ubungsblatt|exercise|problem|task|question|aufgabe|ejercicio|exercicio|esercizio)\\s*\\d{1,4}\\b");
    private static final Pattern DIFFICULTY = Pattern.compile("\\b(?:hard|harder|hardest|difficult|challenging|tough|tougher|easy|easier|simple|simpler)\\b");
    private static final Pattern EXAM_WORDS = Pattern.compile("\\bexams?\\b|\\bmidterms?\\b|\\bfinal\\s+exam\\b|\\bklausur\\b|\\bexamen\\b|\\besame\\b|\\bprova\\b");
    private static final Pattern PREDICTION_WORDS = Pattern.compile("\\bpredict(?:s|ed|ing|ion|ions)?\\b|\\bcould\\s+(?:appear|come\\s+up|be\\s+asked)\\b|\\bmight\\s+(?:appear|come\\s+up|be\\s+asked)\\b|\\bwill\\s+(?:appear|be\\s+asked)\\b");
    /** Wording that claims the exam explicitly, so a scoped generation request must not pre-empt it. */
    private static final Pattern EXPLICIT_EXAM_ASK = Pattern.compile("\\bpredict(?:s|ed|ing|ion|ions)?\\b|\\blikely\\b");
    private static final Pattern ANALYSIS_WORDS = Pattern.compile("\\blikely\\b|\\bimportant\\b|\\bfocus\\b|\\bready\\b|\\breadiness\\b|\\bprepared\\b|\\bcover(?:ed|age|s)?\\b|\\bweight(?:ed|ing)?\\b|\\btopics?\\b|\\bchances?\\b");
    private static final Pattern EXPLAIN_VERBS = Pattern.compile("\\b(?:explain(?:s|ed|ing)?|explanation|explica(?:me|nos|r)?|explique(?:z|me)?|erklar(?:e|en|s|t)?|spiega(?:mi|re)?|insegna(?:mi)?|ensena(?:me)?|teach(?:es|ing)?|tell\\s+me\\s+about|uitleg(?:gen)?|forklar(?:a|e)?)\\b");
    /**
     * A turn that opens with an interrogative is the student naming their own request, so a chat's
     * purpose must not reinterpret it. Openers only: "what does this mean" is a question, while "do it
     * again" merely starts with a question word.
     */
    private static final Pattern INTERROGATIVE_OPENER = Pattern.compile("^(?:ok(?:ay)?|and|so|but|hmm+|well|also)?[\\s,]*(?:what|why|how|when|which|who|whose|where|whats|wheres|hows|do|does|did|is|are|was|were|can|could|should|would|will)\\b");
    /**
     * A question asked as an instruction. "Compare weak and strong fairness" has no question mark and opens
     * with no interrogative, but the student has said exactly what they want, so a chat's purpose must not
     * reinterpret it as homework help or as an exercise request. Only verbs that ask for an account of the
     * material are listed: "show" and "give" would take generation requests with them.
     */
    private static final Pattern IMPERATIVE_REQUEST = Pattern.compile("^(?:ok(?:ay)?|and|so|but|also|now|please)?[\\s,]*(?:compare|contrast|list|define|describe|summari[sz]e|outline|vergleich(?:e|en)?|compara|confronta)\\b");
    private static final Pattern DIACRITICS = Pattern.compile("\\p{M}+");
    /**
     * A turn that only asks for more of what the chat was already doing. It says nothing about the kind of
     * help wanted, which is exactly why it has to inherit: on its own, "another one, but not this topic"
     * carries no artifact word and would fall through to a factual question and be answered instead of served.
     * Request wording again, in several languages, and never a course concept.
     */
    private static final Pattern CONTINUATION = Pattern.compile(
            "\\b(?:another|one\\s+more|next\\s+one|more\\s+like\\s+(?:this|that)|same\\s+again|again\\s+please|keep\\s+going|carry\\s+on|go\\s+on|continue)\\b"
            + "|^(?:ok(?:ay)?|and|so|but|also|now)?[\\s,]*(?:again|more|mas|otra?|otro|encore|noch\\s+(?:eine?s?|mal)|un\\s+altro|una\\s+altra|nog\\s+een)\\b"
            + "|\\b(?:harder|hardest|tougher|easier|simpler|shorter|longer)(?:\\s+(?:one|version|variant))?\\s*[.!?]*$"
            + "|\\bnot\\s+(?:this|that)\\s+(?:topic|one|time)\\b|\\b(?:different|other)\\s+topic\\b|\\bsame\\s+but\\b");
    /** Asking why the tutor chose what it chose is a question about the learner's own recorded state. */
    private static final Pattern SELECTION_RATIONALE = Pattern.compile(
            "\\bwhy\\s+(?:did|do|would|does)\\s+(?:you|it)\\s+(?:choose|chose|pick|picked|select|selected|suggest|suggested|recommend|recommended|start|give|show)\\b"
            + "|\\bwhy\\s+(?:you|it)\\s+(?:chose|choose|picked|pick|selected|select|suggested|suggest|recommended|recommend|started)\\b"
            + "|\\bwhy\\s+(?:that|this)\\s+(?:topic|one|exercise|question|order|first)\\b|\\bwhy\\s+not\\s+(?:the\\s+)?other\\b");
    /**
     * A question about what this learner has been measured to know. It has to be recognised without the word
     * "exam" in it, because "what are my biggest weaknesses" is the same request as "how ready am I for the
     * exam" and was answered from course retrieval instead of from the record.
     *
     * <p>The possessive is allowed two intervening words so "my biggest weaknesses" and "my current weak
     * areas" both read, and the nouns are all about a measurement rather than about material: "my sources",
     * "my lectures" and "my homework" are none of them claims about the learner.
     */
    private static final Pattern LEARNER_STATE = Pattern.compile(
            "\\bmy\\s+(?:\\S+\\s+){0,2}(?:readiness|weakness(?:es)?|weak\\s+(?:topics?|areas?|spots?|points?)|strengths?|progress|mastery|performance|gaps?|recall|retention)\\b"
            + "|\\bmy\\s+(?:\\S+\\s+){0,2}(?:strongest|weakest)\\b|\\bhow\\s+(?:ready|prepared)\\s+am\\s+i\\b"
            + "|\\b(?:am|are)\\s+i\\s+(?:ready|prepared|improving|on\\s+track|behind)\\b"
            + "|\\b(?:what|which)\\s+(?:topic|topics|area|areas|part|parts)\\s+(?:am|are)\\s+i\\s+(?:strongest|weakest|best|worst|struggling|good|bad|weak|strong)\\b"
            + "|\\bhow\\s+(?:am|well\\s+am)\\s+i\\s+doing\\b");

    public QueryIntent classify(String query) { return classify(query, ""); }

    public QueryIntent classify(String query, String recentUserContext) {
        String q = normalize(query);
        String history = normalize(recentUserContext);
        if (asksForAPlan(q)) return QueryIntent.STUDY_PLAN;
        if (SELECTION_RATIONALE.matcher(q).find()) return QueryIntent.EXAM_ANALYSIS;
        if (asksAboutOwnMistakes(q)) return QueryIntent.REVIEW_MISTAKES;
        if (asksToBeTested(q)) return QueryIntent.QUIZ_GENERATION;
        if (asksForSupportOnAnExistingItem(q)) return QueryIntent.HOMEWORK_HELP;
        if (asksAboutOwnRecordedState(q)) return QueryIntent.EXAM_ANALYSIS;
        if (asksForAnItemTheLearnerAlreadyHas(q)) return QueryIntent.HOMEWORK_HELP;
        boolean examWording = EXAM_WORDS.matcher(q).find();
        boolean scopedGeneration = HardNewRequest.requestsScopedNewExercise(query);
        if (scopedGeneration && !EXPLICIT_EXAM_ASK.matcher(q).find()) return QueryIntent.HARD_NEW;
        if (examWording && asksForNewItems(q)) return QueryIntent.EXAM_PREDICTION;
        if (scopedGeneration) return QueryIntent.HARD_NEW;
        if (continuesExamPrediction(q, history)) return QueryIntent.EXAM_PREDICTION;
        if (examWording && ANALYSIS_WORDS.matcher(q).find()) return QueryIntent.EXAM_ANALYSIS;
        if (asksToGenerateAnItem(q)) return QueryIntent.HARD_NEW;
        if (EXISTING_ITEM.matcher(q).find()) return QueryIntent.HOMEWORK_HELP;
        if (EXPLAIN_VERBS.matcher(q).find()) return QueryIntent.EXPLAIN_TOPIC;
        return QueryIntent.FACTUAL_QA;
    }

    /**
     * The same wording routed inside a chat that has a stated purpose. The purpose only gets to decide
     * turns that say nothing about what kind of help is wanted: "another one" in a difficult-exercises
     * chat asks for another exercise, while "what does this notation mean?" is a question wherever it is
     * typed and must stay one.
     */
    public QueryIntent classify(String query, String recentUserContext, ChatPurpose purpose) {
        return classify(query, recentUserContext, purpose, null);
    }

    /**
     * As above, with what the previous turn in this chat was served as. A continuation inherits it, because
     * the request it continues is the only place the kind of help was ever stated: five turns into a chat
     * about difficult exercises, "another one, but not this topic" still asks for an exercise. The previous
     * intent outranks the chat's purpose, being the more specific of the two, and only a turn that names its
     * own kind of request outranks both.
     */
    public QueryIntent classify(String query, String recentUserContext, ChatPurpose purpose, QueryIntent previousIntent) {
        QueryIntent intent = classify(query, recentUserContext);
        if (intent != QueryIntent.FACTUAL_QA) return intent;
        String q = normalize(query);
        if (previousIntent != null && previousIntent != QueryIntent.FACTUAL_QA && continuesThePreviousTurn(q)) return previousIntent;
        QueryIntent preferred = ChatPurpose.orGeneral(purpose).fallbackIntent();
        return preferred == null || namesItsOwnQuestion(q) ? intent : preferred;
    }

    /**
     * A continuation the previous turn may be inherited by. An interrogative disqualifies one, because "is
     * there another way to prove this?" asks about the material rather than for more of it — unless the turn
     * also asks for something outright, as "can you give me another one?" does.
     */
    private boolean continuesThePreviousTurn(String q) {
        return CONTINUATION.matcher(q).find() && (!namesItsOwnQuestion(q) || CREATION.matcher(q).find());
    }

    /**
     * Whether the turn only asks for more of what came before. Retrieval needs this too: a continuation names
     * no topic, so searching on its words alone finds whatever the words "another one" happen to match, which
     * is how a follow-up ends up answered from unrelated material.
     */
    public boolean continues(String query) {
        return CONTINUATION.matcher(normalize(query)).find();
    }

    /** A question mark, an opening interrogative, or an instruction to account for something: the student already said what they are asking for. */
    private boolean namesItsOwnQuestion(String q) {
        return q.contains("?") || INTERROGATIVE_OPENER.matcher(q).find() || IMPERATIVE_REQUEST.matcher(q).find();
    }

    /** A planning ask, whether it names the day ("study today"), the artifact ("a 30-minute plan"), or only the move ("what should I do?"). */
    private boolean asksForAPlan(String q) {
        return PLAN_REQUEST.matcher(q).find() || NEXT_ACTION.matcher(q).find() || (CREATION.matcher(q).find() && PLAN_NOUN.matcher(q).find());
    }

    /**
     * Being tested, however the student words it. "Quiz me" is one wording of four: a quiz can be asked for as
     * a thing ("give me a short quiz"), the roles can be written the other way round ("ask me one question at a
     * time"), or the knowledge itself can be offered ("check my understanding"). All four are the same turn,
     * and the quiz contract — ask, never tell — is the whole point of getting them there.
     */
    private boolean asksToBeTested(String q) {
        return QUIZ_REQUEST.matcher(q).find() || KNOWLEDGE_CHECK.matcher(q).find()
                || (CREATION.matcher(q).find() && QUIZ_NOUN.matcher(q).find())
                || (ASK_ME.matcher(q).find() && ARTIFACT.matcher(q).find());
    }

    /** "Review what I got wrong" is the same request as "review my mistakes" and has to route the same way. */
    private boolean asksAboutOwnMistakes(String q) {
        return MISTAKE_WORDS.matcher(q).find() || (REVIEW_WORDS.matcher(q).find() && WRONG_WORDS.matcher(q).find());
    }

    /**
     * A question about the learner's own measured state, which must be answered from their record rather than
     * from the course. A turn asking for an item built around a weak topic is excluded: "give me a hard
     * exercise on my weakest topic" is a generation request that happens to mention the record.
     */
    private boolean asksAboutOwnRecordedState(String q) {
        return LEARNER_STATE.matcher(q).find() && !(CREATION.matcher(q).find() && ARTIFACT.matcher(q).find());
    }

    /**
     * Asking for a hint on a numbered item is help with that item, never a request to invent a new one.
     * Without this the creation verb in "give me a hint for assignment 2" reads as exercise generation.
     */
    private boolean asksForSupportOnAnExistingItem(String q) {
        return SUPPORT_WORDS.matcher(q).find() && EXISTING_ITEM.matcher(q).find();
    }

    /**
     * "Give me exercise 3 of homework 1" asks to be shown work the student is already holding. The numbered
     * reference is the item itself here, not a scope or an exclusion, and the tell is that nothing in the turn
     * asks for anything new or harder: with a novelty or difficulty word it is generation constrained by that
     * reference, and without one it is a request the system cannot satisfy by inventing a replacement.
     */
    private boolean asksForAnItemTheLearnerAlreadyHas(String q) {
        return NUMBERED_ITEM.matcher(q).find() && !NOVELTY.matcher(q).find() && !DIFFICULTY.matcher(q).find();
    }

    private boolean asksForNewItems(String q) {
        return PREDICTION_WORDS.matcher(q).find() || (NOVELTY.matcher(q).find() && ARTIFACT.matcher(q).find());
    }

    /**
     * A generation request with no named scope still asks for a generated exercise, not an answer. A novelty
     * word is not required: "create a problem that combines two topics" and "give me an easy exercise first"
     * ask to be given something that does not exist yet just as plainly as "a new one" does.
     *
     * <p>Without a novelty word the turn must also name no existing item, because "give me exercise 3 of
     * homework 1" asks to be shown work the student already has, and inventing one instead is the worse of
     * the two mistakes.
     */
    private boolean asksToGenerateAnItem(String q) {
        if (!CREATION.matcher(q).find() || !ARTIFACT.matcher(q).find()) return false;
        return NOVELTY.matcher(q).find() || !EXISTING_ITEM.matcher(q).find();
    }

    /**
     * A bare follow-up inherits the exam framing of the conversation, but only when the turn still asks
     * for an item. Wording like "explain that differently" must not be dragged into exam prediction.
     */
    private boolean continuesExamPrediction(String q, String history) {
        boolean examHistory = PREDICTION_WORDS.matcher(history).find() || EXAM_WORDS.matcher(history).find();
        return examHistory && (ARTIFACT.matcher(q).find() || q.contains("another one") || q.contains("where"));
    }

    /** Lower-cased, accent-stripped and whitespace-collapsed, so "Explícame" and "explicame" are one word. */
    private static String normalize(String value) {
        String lowered = (value == null ? "" : value).toLowerCase(Locale.ROOT);
        return DIACRITICS.matcher(Normalizer.normalize(lowered, Normalizer.Form.NFD)).replaceAll("").replaceAll("\\s+", " ").trim();
    }
}
