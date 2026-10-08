package com.studyos.curriculum;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.studyos.adaptive.CognitiveLevel;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/**
 * Turns what a lesson has — retrieved excerpts, a generated draft, the mistakes this student has
 * already made — into the brief they read. Pure: no database and no provider, so the rules about
 * what counts as usable teaching content are testable on their own.
 *
 * <p>The order of the sections is fixed, because that order is what makes teaching work: plain
 * intuition first, then the idea stated precisely, then one worked example, then a check that it
 * landed. What goes into those slots comes entirely from the lesson's own evidence, so the same
 * rules produce a chemistry lesson and a contract law lesson.
 *
 * <p>When no draft is available the brief is not invented. {@link #fallback} surfaces the student's
 * own material with citations and reports the rest as missing, so a lesson never opens with prose
 * nothing supports.
 */
public final class LessonBriefComposer {
    private LessonBriefComposer() {}

    public static final int MAX_CHECKS = 3;
    public static final int MAX_MISTAKES = 3;
    public static final int MAX_EXCERPTS = 6;
    /** Long enough to hold a real explanation, short enough that a lesson stays one sitting. */
    private static final int MAX_SECTION_CHARS = 2000;
    /** Below this a section is a placeholder ("see notes", "N/A") rather than teaching. */
    private static final int MIN_SECTION_CHARS = 24;
    private static final int MIN_QUESTION_CHARS = 8;
    private static final int FALLBACK_SENTENCES = 3;

    public record Request(String title, String objective, List<String> keyIdeas, int targetLevel, List<String> knownMistakes) {
        public Request(String title, String objective, List<String> keyIdeas, int targetLevel, List<String> knownMistakes) {
            this.title = title; this.objective = objective;
            this.keyIdeas = keyIdeas == null ? List.of() : keyIdeas;
            this.targetLevel = targetLevel;
            this.knownMistakes = knownMistakes == null ? List.of() : knownMistakes;
        }
    }

    /** One passage of the student's own material, with where it came from. */
    public record Excerpt(String documentName, int pageStart, int pageEnd, String content) {}

    public record Citation(String documentName, int pageStart, int pageEnd) {}

    public record Check(String question, String answer) {
        @JsonCreator public Check(@JsonProperty("question") String question, @JsonProperty("answer") String answer) {
            this.question = question; this.answer = answer;
        }
    }

    /** What a generator proposes. Every field is optional; the composer decides what survives. */
    public record Draft(String intuition, String formalDefinition, String workedExample, List<Check> checks,
                        List<String> commonMistakes, String nextStep) {
        @JsonCreator public Draft(@JsonProperty("intuition") String intuition, @JsonProperty("formalDefinition") String formalDefinition,
                                  @JsonProperty("workedExample") String workedExample, @JsonProperty("checks") List<Check> checks,
                                  @JsonProperty("commonMistakes") List<String> commonMistakes, @JsonProperty("nextStep") String nextStep) {
            this.intuition = intuition; this.formalDefinition = formalDefinition; this.workedExample = workedExample;
            this.checks = checks == null ? List.of() : checks;
            this.commonMistakes = commonMistakes == null ? List.of() : commonMistakes;
            this.nextStep = nextStep;
        }
    }

    public record Brief(String title, String objective, List<String> keyIdeas, int targetLevel, String targetLevelLabel,
                        String intuition, String formalDefinition, String workedExample, List<Check> checks,
                        List<String> commonMistakes, String nextStep, List<Citation> citations,
                        boolean grounded, boolean complete, List<String> missing) {}

    /** Keeps what the draft got right, drops placeholders, and records what is still missing. */
    public static Brief compose(Request request, Draft draft, List<Excerpt> evidence) {
        Draft safe = draft == null ? new Draft(null, null, null, List.of(), List.of(), null) : draft;
        String intuition = section(safe.intuition());
        String formal = section(safe.formalDefinition());
        String example = section(safe.workedExample());
        List<Check> checks = checks(safe.checks());
        return brief(request, intuition, formal, example, checks, mistakes(request.knownMistakes(), safe.commonMistakes()),
                section(safe.nextStep()), citations(evidence), evidence != null && !evidence.isEmpty());
    }

    /**
     * The brief a lesson can still offer when nothing generated one: the student's own material,
     * cited, with every slot it cannot honestly fill reported as missing.
     */
    public static Brief fallback(Request request, List<Excerpt> evidence) {
        List<Excerpt> usable = evidence == null ? List.of() : evidence.stream().filter(excerpt -> excerpt != null && !blank(excerpt.content())).toList();
        String formal = usable.isEmpty() ? null : section(sentences(usable.getFirst().content(), FALLBACK_SENTENCES));
        return brief(request, null, formal, null, List.of(), mistakes(request.knownMistakes(), List.of()),
                null, citations(usable), !usable.isEmpty());
    }

    /**
     * How finished a brief is, in the words the lesson row stores. PARTIAL matters: it says the
     * student has something to read while telling the UI the lesson is still worth regenerating.
     */
    public static String contentStatus(Brief brief) {
        if (brief == null) return "PENDING";
        if (brief.complete()) return "READY";
        boolean anything = brief.intuition() != null || brief.formalDefinition() != null
                || brief.workedExample() != null || !brief.checks().isEmpty();
        return anything ? "PARTIAL" : "PENDING";
    }

    /** The brief as readable text, for storing alongside the student's other material. */
    public static String markdown(Brief brief) {
        StringBuilder text = new StringBuilder("# ").append(Objects.toString(brief.title(), "Lesson")).append("\n");
        if (!blank(brief.objective())) text.append("\n_").append(brief.objective().trim()).append("_\n");
        if (!brief.keyIdeas().isEmpty()) text.append("\nKey ideas: ").append(String.join(", ", brief.keyIdeas())).append('\n');
        appendSection(text, "In plain terms", brief.intuition());
        appendSection(text, "Stated precisely", brief.formalDefinition());
        appendSection(text, "Worked example", brief.workedExample());
        if (!brief.checks().isEmpty()) {
            text.append("\n## Check yourself\n");
            int number = 1;
            for (Check check : brief.checks()) {
                text.append('\n').append(number++).append(". ").append(check.question().trim()).append('\n');
                if (!blank(check.answer())) text.append("   Answer: ").append(check.answer().trim()).append('\n');
            }
        }
        if (!brief.commonMistakes().isEmpty()) {
            text.append("\n## Watch out for\n\n");
            for (String mistake : brief.commonMistakes()) text.append("- ").append(mistake).append('\n');
        }
        appendSection(text, "Next", brief.nextStep());
        if (!brief.citations().isEmpty()) {
            text.append("\n## From your material\n\n");
            for (Citation citation : brief.citations()) text.append("- ").append(reference(citation)).append('\n');
        }
        return text.toString();
    }

    /** A citation as the student would cite it: the document they uploaded, and where in it. */
    public static String reference(Citation citation) {
        String name = blank(citation.documentName()) ? "Course material" : citation.documentName().trim();
        if (citation.pageStart() <= 0) return name;
        return citation.pageEnd() > citation.pageStart() ? name + " p." + citation.pageStart() + "–" + citation.pageEnd()
                : name + " p." + citation.pageStart();
    }

    // ---- rules ------------------------------------------------------------------------------

    private static Brief brief(Request request, String intuition, String formal, String example, List<Check> checks,
                              List<String> mistakes, String nextStep, List<Citation> citations, boolean grounded) {
        List<String> missing = new ArrayList<>();
        if (intuition == null) missing.add("intuition");
        if (formal == null) missing.add("precise statement");
        if (example == null) missing.add("worked example");
        if (checks.isEmpty()) missing.add("check questions");
        int level = request.targetLevel() < 1 || request.targetLevel() > 6 ? CognitiveLevel.L3_APPLY.rank() : request.targetLevel();
        return new Brief(request.title(), request.objective(), request.keyIdeas(), level, CognitiveLevel.ofRank(level).label(),
                intuition, formal, example, checks, mistakes, nextStep, citations, grounded, missing.isEmpty(), List.copyOf(missing));
    }

    /** Null when the text says nothing worth reading; otherwise tidied and bounded. */
    private static String section(String value) {
        if (blank(value)) return null;
        String cleaned = value.replace('\u00A0', ' ').replaceAll("[ \t]+", " ").replaceAll("\n{3,}", "\n\n").trim();
        if (cleaned.length() < MIN_SECTION_CHARS) return null;
        return cleaned.length() <= MAX_SECTION_CHARS ? cleaned : cleaned.substring(0, MAX_SECTION_CHARS).trim() + "…";
    }

    /** A check earns its place on the question alone; a missing answer is shown as unmarked. */
    private static List<Check> checks(List<Check> drafted) {
        List<Check> result = new ArrayList<>();
        for (Check check : drafted) {
            if (check == null || blank(check.question())) continue;
            String question = check.question().replaceAll("\\s+", " ").trim();
            if (question.length() < MIN_QUESTION_CHARS || result.size() >= MAX_CHECKS) continue;
            String answer = blank(check.answer()) ? null : check.answer().replaceAll("[ \t]+", " ").trim();
            result.add(new Check(question, answer));
        }
        return List.copyOf(result);
    }

    /** What this student got wrong before comes first: it is the part of the lesson they need most. */
    private static List<String> mistakes(List<String> known, List<String> drafted) {
        List<String> result = new ArrayList<>();
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        for (String value : concat(known, drafted)) {
            if (blank(value)) continue;
            String mistake = value.replaceAll("\\s+", " ").trim();
            if (!seen.add(mistake.toLowerCase(Locale.ROOT)) || result.size() >= MAX_MISTAKES) continue;
            result.add(mistake.length() <= 300 ? mistake : mistake.substring(0, 300).trim() + "…");
        }
        return List.copyOf(result);
    }

    private static List<Citation> citations(List<Excerpt> evidence) {
        List<Citation> result = new ArrayList<>();
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        for (Excerpt excerpt : evidence == null ? List.<Excerpt>of() : evidence) {
            if (excerpt == null || blank(excerpt.documentName())) continue;
            Citation citation = new Citation(excerpt.documentName().trim(), Math.max(0, excerpt.pageStart()), Math.max(0, excerpt.pageEnd()));
            if (!seen.add(citation.documentName() + '|' + citation.pageStart() + '|' + citation.pageEnd()) || result.size() >= MAX_EXCERPTS) continue;
            result.add(citation);
        }
        return List.copyOf(result);
    }

    /** The first whole sentences of a passage, so an excerpt is never cut mid-clause. */
    static String sentences(String text, int limit) {
        if (blank(text)) return null;
        String flat = text.replaceAll("\\s+", " ").trim();
        String[] parts = flat.split("(?<=[.!?])\\s+");
        return String.join(" ", List.of(parts).subList(0, Math.min(Math.max(1, limit), parts.length)));
    }

    private static void appendSection(StringBuilder text, String heading, String body) {
        if (blank(body)) return;
        text.append("\n## ").append(heading).append("\n\n").append(body.trim()).append('\n');
    }

    private static List<String> concat(List<String> first, List<String> second) {
        List<String> all = new ArrayList<>(first == null ? List.of() : first);
        all.addAll(second == null ? List.of() : second);
        return all;
    }

    private static boolean blank(String value) { return value == null || value.isBlank(); }
}
