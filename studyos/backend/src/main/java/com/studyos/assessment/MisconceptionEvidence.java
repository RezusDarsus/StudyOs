package com.studyos.assessment;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Decides whether a grader's proposed misconception is evidenced by the attempt it came from, and which
 * already-recorded misconception it is the same one as.
 *
 * <p>A misconception is durable learner state. It is read by the planner's priority, by the quiz generator when it
 * writes a follow-up question, by the lesson brief, by the topic capsule and by the learner-state view — so a
 * wrong one does not sit inertly in a table, it redirects the course. Until this class existed the grading model's
 * free-text answer went into that state unexamined, which meant a model naming a concept from a neighbouring
 * subject created a misconception the learner had never shown and StudyOS then taught against it.
 *
 * <p>The check is the same one {@link com.studyos.verify.ClaimProvenance} applies to an answer's claims, asked
 * about the learner instead of about the material: <em>whose vocabulary is this written in?</em> A misconception is
 * a claim about how someone is thinking, so the evidence for it is what they actually wrote.
 *
 * <ul>
 *   <li><b>LEARNER_STATED</b> — the candidate's distinctive terms are in the learner's own answer. This is the only
 *       verdict that may create a new misconception.
 *   <li><b>TASK_GROUNDED</b> — they are in the question or the expected answer but not in the learner's answer.
 *       That is the signature of a gap rather than a misconception: they did not say the thing. It may reinforce a
 *       misconception already established and may not mint one, because "the learner never mentioned X" is not
 *       evidence that they believe something false about X.
 *   <li><b>UNGROUNDED</b> — the terms occur nowhere in the attempt. The vocabulary is the model's own.
 *   <li><b>UNVERIFIABLE</b> — no attempt evidence was supplied. Deliberately not folded into UNGROUNDED: one says
 *       the candidate failed a check and the other says no check was possible, and a table that reported them as
 *       the same number could not tell a hallucinating grader from an unwired caller.
 *   <li><b>NOT_AN_ERROR</b> — the answer was correct. An attempt this good cannot evidence a misconception, which
 *       is the mirror of never raising mastery because a learner said they understood.
 *   <li><b>MALFORMED</b> — blank, a placeholder, the wrong length, or with no distinctive vocabulary at all.
 * </ul>
 *
 * <p>Clustering is here for the same reason. Matching on the exact normalised string, which is what StudyOS did
 * before, treats "believes entropy is temperature" and "thinks that entropy just measures temperature" as two
 * unrelated misconceptions, each with one occurrence and neither ever severe enough to act on. Overlap of
 * distinctive terms makes them one, with two occurrences, which is what the learner actually demonstrated.
 *
 * <p>Pure, deterministic and subject-general: no database, no provider, no clock, and no vocabulary of the
 * subject. The one word list is English framing — "believes", "instead", "incorrectly" — the words a grader uses
 * to describe a misunderstanding rather than to name one. Removing them can only make grounding easier to reach,
 * since a term that would have matched leaves the numerator and the denominator together, and it stops a label's
 * groundedness being decided by how verbosely the model phrased it. Every term that is judged comes from the
 * attempt itself, so this places a misconception about cyclic codes, about consideration in contract law and about
 * renal physiology with the same code.
 */
public final class MisconceptionEvidence {
    /** What a share or a similarity is when there was nothing to measure it over. Never a real figure. */
    public static final double UNMEASURED = -1;

    /** Long enough to be a term of the subject rather than grammar, which is why no stopword list is needed. */
    private static final Pattern TERM = Pattern.compile("\\p{L}{6,}");
    /** The opening letters every {@link #TERM} has, which is what stands in for a stemmer here. */
    private static final int STEM_CHARS = 6;
    /** Shorter than this is not a misconception anyone can teach against; longer is an explanation, not a label. */
    private static final int MIN_LABEL_CHARS = 8;
    private static final int MAX_LABEL_CHARS = 300;
    /** How much of a candidate's own distinctive vocabulary has to occur in the evidence for it to be grounded. */
    private static final double MIN_GROUNDED_SHARE = .5;
    /**
     * How much two labels must share to be the same misconception. Set where a rephrasing of one belief clusters
     * and two beliefs about the same topic do not: "entropy is temperature" and "entropy is heat capacity" share
     * only "entropy" of three terms, and remain two misconceptions, which is right — they need different teaching.
     */
    private static final double MIN_CLUSTER_SIMILARITY = .6;
    /** A candidate with fewer distinctive terms than this cannot be placed and is not a usable label either. */
    private static final int MIN_TERMS_TO_JUDGE = 1;

    /**
     * The English words a grader uses to frame a misunderstanding rather than to name one, stemmed like every
     * other term. Structural vocabulary only: nothing here is ever the subject of a course, which is what makes
     * removing it safe on material this class has never seen.
     */
    private static final Set<String> FRAMING = stems(List.of("thinks", "thinking", "thought", "believes", "believe", "belief",
            "assumes", "assume", "assumed", "confuses", "confuse", "confused", "conflates", "conflate", "treats", "applies",
            "applied", "forgets", "forgot", "missing", "misses", "missed", "misunderstands", "misunderstanding", "understands",
            "understand", "understanding", "student", "students", "learner", "answer", "answers", "answered", "response",
            "attempt", "attempts", "question", "questions", "instead", "because", "should", "rather", "without", "although",
            "however", "therefore", "whether", "actually", "simply", "likely", "probably", "possibly", "apparently",
            "seemingly", "presumably", "supposedly", "incorrect", "incorrectly", "correct", "correctly", "wrongly",
            "mistake", "mistaken", "mistakenly", "explains", "explain", "explanation", "states", "stated", "cannot",
            "unable", "failed", "appears", "appeared", "seemed", "example"));

    /** Whole labels that say a grader found nothing, which must never become a misconception. */
    private static final Set<String> PLACEHOLDERS = Set.of("none", "no", "na", "n a", "nothing", "null", "empty", "unknown",
            "unclear", "not applicable", "no error", "no errors", "no mistake", "no mistakes", "no misconception",
            "no misconceptions", "no misconception detected", "no misconception found", "correct", "correct answer", "not sure");

    private MisconceptionEvidence() {}

    /**
     * What to do with one proposed misconception.
     *
     * @param candidate the grader's own wording, unexamined. Never trusted, always recorded.
     * @param attempt what the learner was asked, what was expected and what they wrote — the only evidence there
     *     is for a claim about their thinking, and the same evidence the grading model itself was shown. Nothing
     *     the model returned is treated as evidence for anything, exactly as a chunk id a model names is not
     *     evidence that it read that chunk.
     * @param known the misconceptions this workspace already holds for the topic, strongest first. Order breaks a
     *     tie between two equally similar clusters, so the one already acted on wins rather than an arbitrary row.
     */
    public static Finding of(String candidate, Attempt attempt, List<Known> known) {
        String label = clean(candidate);
        if (label.length() > MAX_LABEL_CHARS) return rejected(truncate(label), Verdict.MALFORMED);
        if (label.length() < MIN_LABEL_CHARS || PLACEHOLDERS.contains(letters(label))) return rejected(label, Verdict.MALFORMED);
        Set<String> terms = terms(label);
        if (terms.size() < MIN_TERMS_TO_JUDGE) return rejected(label, Verdict.MALFORMED);
        if (attempt == null) return rejected(label, Verdict.UNVERIFIABLE);
        if (attempt.score() >= AssessmentOutcomeRules.CORRECT_SCORE) return rejected(label, Verdict.NOT_AN_ERROR);

        Set<String> learnerTerms = terms(attempt.learnerAnswer());
        Set<String> taskTerms = terms(attempt.question());
        taskTerms.addAll(terms(attempt.expectedAnswer()));
        if (learnerTerms.isEmpty() && taskTerms.isEmpty()) return rejected(label, Verdict.UNVERIFIABLE);

        Set<String> attemptTerms = new LinkedHashSet<>(learnerTerms);
        attemptTerms.addAll(taskTerms);
        double learnerShare = share(terms, learnerTerms);
        double attemptShare = share(terms, attemptTerms);
        Verdict verdict = learnerShare >= MIN_GROUNDED_SHARE ? Verdict.LEARNER_STATED
                : attemptShare >= MIN_GROUNDED_SHARE ? Verdict.TASK_GROUNDED : Verdict.UNGROUNDED;
        String excerpt = excerpt(attempt.learnerAnswer(), terms);
        if (verdict == Verdict.UNGROUNDED) return new Finding(label, verdict, Action.REJECTED, attemptShare, UNMEASURED, excerpt, null);

        List<Known> clusters = known == null ? List.of() : known.stream().filter(value -> value != null && value.label() != null).toList();
        Match match = closest(terms, clusters);
        if (match != null && match.similarity() >= MIN_CLUSTER_SIMILARITY) {
            return new Finding(label, verdict, Action.REINFORCED, attemptShare, match.similarity(), excerpt, match.id());
        }
        // Nothing to attach it to. A candidate the learner's own words carry becomes a new misconception; one that
        // only the task carries is recorded and goes no further, because an omission is not a stated belief.
        double similarity = match == null ? UNMEASURED : match.similarity();
        return verdict.mayCreate()
                ? new Finding(label, verdict, Action.CREATED, attemptShare, similarity, excerpt, null)
                : new Finding(label, verdict, Action.REJECTED, attemptShare, similarity, excerpt, null);
    }

    /** The recorded misconception whose wording overlaps this candidate most, or null when none was compared. */
    private static Match closest(Set<String> terms, List<Known> clusters) {
        Match best = null;
        for (Known cluster : clusters) {
            double similarity = jaccard(terms, terms(cluster.label()));
            if (best == null || similarity > best.similarity()) best = new Match(cluster.id(), similarity);
        }
        return best;
    }

    /** The share of a candidate's distinctive terms that occur in a body of evidence. */
    private static double share(Set<String> terms, Set<String> evidence) {
        if (terms.isEmpty()) return UNMEASURED;
        int found = 0;
        for (String term : terms) if (evidence.contains(term)) found++;
        return (double) found / terms.size();
    }

    /** Overlap of two labels' vocabularies over their union, so a longer rephrasing is not penalised twice. */
    private static double jaccard(Set<String> left, Set<String> right) {
        if (left.isEmpty() || right.isEmpty()) return 0;
        int shared = 0;
        for (String term : left) if (right.contains(term)) shared++;
        return (double) shared / (left.size() + right.size() - shared);
    }

    /**
     * The learner's own sentence that carries the most of the candidate's vocabulary, which is the thing a person
     * reviewing the record needs to see. Null when their answer shares nothing: an excerpt invented from a
     * sentence with no shared term would present the evidence as stronger than it is.
     */
    private static String excerpt(String answer, Set<String> terms) {
        String best = null;
        int most = 0;
        for (String sentence : (answer == null ? "" : answer).split("(?<=[.!?;])\\s+|\\R")) {
            Set<String> found = terms(sentence);
            int shared = 0;
            for (String term : terms) if (found.contains(term)) shared++;
            if (shared > most) { most = shared; best = sentence.replaceAll("\\s+", " ").trim(); }
        }
        return best == null || best.isBlank() ? null : truncate(best);
    }

    /** The distinctive words of a piece of text, stemmed by prefix, with English framing vocabulary removed. */
    private static Set<String> terms(String text) {
        Set<String> terms = new LinkedHashSet<>();
        Matcher matcher = TERM.matcher(text == null ? "" : text.toLowerCase(Locale.ROOT));
        while (matcher.find()) {
            String stem = matcher.group().substring(0, STEM_CHARS);
            if (!FRAMING.contains(stem)) terms.add(stem);
        }
        return terms;
    }

    private static Set<String> stems(List<String> words) {
        Set<String> result = new LinkedHashSet<>();
        for (String word : words) if (word.length() >= STEM_CHARS) result.add(word.substring(0, STEM_CHARS));
        return Set.copyOf(result);
    }

    private static Finding rejected(String label, Verdict verdict) { return new Finding(label, verdict, Action.REJECTED, UNMEASURED, UNMEASURED, null, null); }
    private static String clean(String value) { return value == null ? "" : value.replaceAll("\\s+", " ").trim(); }
    private static String truncate(String value) { return value.length() <= MAX_LABEL_CHARS ? value : value.substring(0, MAX_LABEL_CHARS); }
    /** Letters and single spaces only, so "N/A." and "n a" are the same placeholder. */
    private static String letters(String value) { return value.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}]+", " ").trim(); }

    /** How a candidate's vocabulary relates to the attempt it was produced from. */
    public enum Verdict {
        LEARNER_STATED, TASK_GROUNDED, UNGROUNDED, UNVERIFIABLE, NOT_AN_ERROR, MALFORMED;

        /** Whether this candidate may add a misconception the workspace has never recorded. */
        public boolean mayCreate() { return this == LEARNER_STATED; }
        /** Whether this candidate may strengthen one it already holds. */
        public boolean mayReinforce() { return this == LEARNER_STATED || this == TASK_GROUNDED; }
    }

    /** What was done about the candidate. REJECTED means nothing durable was written, and it is still recorded. */
    public enum Action { CREATED, REINFORCED, REJECTED }

    /**
     * The attempt a candidate was produced from.
     *
     * @param question what was asked, and {@code expectedAnswer} what a correct answer says. Both are the task's
     *     vocabulary, not the learner's, which is why a candidate grounded only in them cannot create anything.
     * @param learnerAnswer what the learner wrote. The only evidence that they hold a belief rather than lack one.
     */
    public record Attempt(double score, String question, String expectedAnswer, String learnerAnswer) {}

    /** A misconception the workspace already holds, as the candidate is clustered against. */
    public record Known(UUID id, String label) {}

    /**
     * @param groundedShare the share of the candidate's distinctive terms found anywhere in the attempt, or
     *     {@link #UNMEASURED} when it was never checked. One definition for every verdict: the verdict says
     *     <em>where</em> the vocabulary was found, so this stays comparable across all of them.
     * @param clusterSimilarity how close the nearest recorded misconception was, or {@link #UNMEASURED} when the
     *     workspace held none to compare against. A measured value below the threshold is kept on purpose: it is
     *     the evidence that this really is a different misconception and not a near-duplicate.
     * @param misconceptionId set only when an existing misconception was reinforced. A created one has no id yet —
     *     the caller mints it — and a rejected one never gets one.
     */
    public record Finding(String label, Verdict verdict, Action action, double groundedShare, double clusterSimilarity,
                          String learnerExcerpt, UUID misconceptionId) {}

    private record Match(UUID id, double similarity) {}
}
